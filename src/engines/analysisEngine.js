'use strict';

const fs = require('fs');
const path = require('path');
const runGnuBgAnalysis = require('../gnubgRunner');
const runHedgehogAnalysis = require('./hedgehogEngine');
const { moveSignature } = require('./moveUtils');

function configuredMode(explicitMode) {
    const value = String(explicitMode || process.env.ANALYSIS_ENGINE || 'gnubg').trim().toLowerCase();
    if (value === 'gnu') return 'gnubg';
    if (value === 'gnubg' || value === 'hedgehog' || value === 'compare') return value;
    throw new Error(`Unknown ANALYSIS_ENGINE '${value}'. Use gnubg, hedgehog, or compare.`);
}

async function timed(operation) {
    const startedAt = process.hrtime.bigint();
    try {
        const value = await operation();
        return { status: 'fulfilled', value, durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6 };
    } catch (error) {
        return { status: 'rejected', error, durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6 };
    }
}

function candidateSummary(result, playedMove) {
    const moves = Array.isArray(result?.moves) ? result.moves : [];
    const metadata = result?.engineMetadata;
    const playedSignature = moveSignature(playedMove || []);
    const playedIndex = playedSignature
        ? moves.findIndex((move) => moveSignature(move.move || move.moveText || '') === playedSignature)
        : -1;
    return {
        available: result?.engineAvailable !== false,
        error: result?.error || null,
        moveCount: moves.length,
        bestMove: moves[0]?.move || moves[0]?.moveText || null,
        bestEquity: Number.isFinite(moves[0]?.equity) ? moves[0].equity : null,
        playedMoveRecognized: playedSignature ? playedIndex >= 0 : null,
        playedMoveRank: playedIndex >= 0 ? playedIndex + 1 : null,
        playedMoveEquity: playedIndex >= 0 && Number.isFinite(moves[playedIndex]?.equity)
            ? moves[playedIndex].equity
            : null,
        identity: metadata ? {
            engineVersion: metadata.engineVersion || null,
            ply: metadata.ply ?? null,
            hashes: metadata.hashes || null
        } : null,
        topMoves: moves.slice(0, 8).map((move, index) => ({
            rank: index + 1,
            move: move.move || move.moveText || null,
            equity: Number.isFinite(move.equity) ? move.equity : null
        }))
    };
}

function buildComparison(params, gnuRun, hedgehogRun) {
    const gnu = gnuRun.status === 'fulfilled'
        ? candidateSummary(gnuRun.value, params.playedMove)
        : { available: false, error: gnuRun.error.message, moveCount: 0 };
    const hedgehog = hedgehogRun.status === 'fulfilled'
        ? candidateSummary(hedgehogRun.value, params.playedMove)
        : { available: false, error: hedgehogRun.error.message, moveCount: 0 };
    const bestMoveAgreement = gnu.bestMove && hedgehog.bestMove
        ? moveSignature(gnu.bestMove) === moveSignature(hedgehog.bestMove)
        : null;

    return {
        timestamp: new Date().toISOString(),
        authoritativeEngine: 'gnubg',
        matchId: params.matchId || params.gnuId || null,
        ogid: hedgehogRun.status === 'fulfilled' ? hedgehogRun.value.ogid || null : null,
        positionIndex: params.positionIndex ?? null,
        dice: params.dice || null,
        gnu: { ...gnu, durationMs: gnuRun.durationMs },
        hedgehog: { ...hedgehog, durationMs: hedgehogRun.durationMs },
        bestMoveAgreement,
        bestEquityDifference: Number.isFinite(gnu.bestEquity) && Number.isFinite(hedgehog.bestEquity)
            ? hedgehog.bestEquity - gnu.bestEquity
            : null
    };
}

async function appendComparison(report) {
    const reportPath = process.env.ANALYSIS_COMPARE_REPORT;
    if (!reportPath) return null;
    const absolutePath = path.resolve(reportPath);
    try {
        await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.promises.appendFile(absolutePath, `${JSON.stringify(report)}\n`, 'utf8');
        return null;
    } catch (error) {
        return error.message;
    }
}

async function analyzePosition(params, options = {}) {
    const mode = configuredMode(options.engine);
    if (mode === 'gnubg') return runGnuBgAnalysis(params);
    if (mode === 'hedgehog') return runHedgehogAnalysis(params);

    // GNUbg remains authoritative during evaluation. Running both operations
    // concurrently makes compare mode no slower than its slowest engine.
    const [gnuRun, hedgehogRun] = await Promise.all([
        timed(() => runGnuBgAnalysis(params)),
        timed(() => runHedgehogAnalysis(params))
    ]);
    const comparison = buildComparison(params, gnuRun, hedgehogRun);
    const reportError = await appendComparison(comparison);
    if (reportError) comparison.reportError = reportError;

    if (process.env.ANALYSIS_COMPARE_LOG === '1') {
        console.log('[engine-compare]', JSON.stringify(comparison));
    }

    if (gnuRun.status === 'rejected') throw gnuRun.error;
    return { ...gnuRun.value, comparison };
}

analyzePosition.configuredMode = configuredMode;
analyzePosition.buildComparison = buildComparison;
analyzePosition.close = () => runHedgehogAnalysis.close();
analyzePosition.getStatus = () => {
    const mode = configuredMode();
    const status = { mode, authoritativeEngine: mode === 'compare' ? 'gnubg' : mode };
    if (mode !== 'gnubg' && typeof runHedgehogAnalysis.getStatus === 'function') {
        const hedgehog = runHedgehogAnalysis.getStatus();
        status.hedgehog = {
            running: hedgehog.running,
            pending: hedgehog.pending,
            metadata: hedgehog.metadata,
            lastError: hedgehog.lastError,
            ply: hedgehog.config.ply,
            timeoutMs: hedgehog.config.timeoutMs
        };
    }
    return status;
};

module.exports = analyzePosition;
