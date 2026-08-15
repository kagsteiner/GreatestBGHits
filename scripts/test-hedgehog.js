'use strict';

if (process.argv[2]) process.env.HEDGEHOG_MODEL = process.argv[2];

const BackgammonBoard = require('../src/board');
const runHedgehogAnalysis = require('../src/engines/hedgehogEngine');
const { moveSignature } = require('../src/engines/moveUtils');

async function main() {
    const board = BackgammonBoard.starting('player1');
    board.dice = { die1: 3, die2: 1 };
    const startedAt = process.hrtime.bigint();
    const result = await runHedgehogAnalysis({
        ogid: board.toOgid(),
        dice: board.dice
    });
    const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    if (!Array.isArray(result.moves) || result.moves.length === 0) {
        throw new Error('Hedgehog returned no legal moves');
    }
    if (!result.bestMoveVerified) throw new Error('Best-move verification failed');
    if (moveSignature(result.moves[0]?.move) !== moveSignature('8/5 6/5')) {
        throw new Error(`Unexpected 3-1 opening move: ${result.moves[0]?.move || 'none'}`);
    }
    // This turned-cube match position has different cubeless and cubeful move
    // ordering. Hedgehog's dedicated best-move operation uses cubeful equity,
    // so the candidate list must use that same measure.
    const cubefulResult = await runHedgehogAnalysis({
        ogid: 'aakkllmmnnooooo:11355668899dddh:B1N:11:W:R:4:1:21:0',
        dice: { die1: 1, die2: 1 }
    });
    if (moveSignature(cubefulResult.moves[0]?.move) !== moveSignature('9/8 9/8 8/7 8/7')) {
        throw new Error(`Unexpected cubeful best move: ${cubefulResult.moves[0]?.move || 'none'}`);
    }
    if (!cubefulResult.bestMoveVerified) {
        throw new Error('Cubeful best-move verification failed');
    }
    const cubeBoard = BackgammonBoard.starting('player1');
    const cubeResult = await runHedgehogAnalysis.analyzeCube({
        ogid: cubeBoard.toOgid(),
        cubeValue: 1,
        cubeOwner: null,
        player: 'player1',
        matchLength: 0,
        myScore: 0,
        opponentScore: 0,
        isCrawford: false
    });
    if (typeof cubeResult.shouldDouble !== 'boolean'
        || typeof cubeResult.shouldTake !== 'boolean'
        || !Number.isFinite(cubeResult.noDoubleEquity)
        || !Number.isFinite(cubeResult.doubleTakeEquity)
        || !Number.isFinite(cubeResult.doublePassEquity)) {
        throw new Error('Hedgehog returned an incomplete cube decision');
    }
    const matchCubeBoard = BackgammonBoard.starting('player1');
    matchCubeBoard.matchLength = 21;
    const matchCubeResult = await runHedgehogAnalysis.analyzeCube({
        ogid: matchCubeBoard.toOgid(),
        cubeValue: 1,
        cubeOwner: null,
        player: 'player1',
        matchLength: 21,
        myScore: 0,
        opponentScore: 0,
        isCrawford: false
    });
    if (!Number.isFinite(matchCubeResult.noDoubleNormEq)
        || !Number.isFinite(matchCubeResult.doubleTakeNormEq)
        || !Number.isFinite(matchCubeResult.doublePassNormEq)) {
        throw new Error('Hedgehog returned incomplete normalized match equities');
    }

    console.log(JSON.stringify({
        engine: result.engine,
        engineVersion: result.engineMetadata?.engineVersion,
        model: result.engineMetadata?.model,
        modelHashes: result.engineMetadata?.hashes,
        ply: result.engineMetadata?.ply,
        ogid: result.ogid,
        moveCount: result.moves.length,
        bestMove: result.moves[0],
        cubefulBestMove: cubefulResult.moves[0],
        cubeDecision: {
            action: cubeResult.action,
            shouldDouble: cubeResult.shouldDouble,
            shouldTake: cubeResult.shouldTake,
            noDoubleEquity: cubeResult.noDoubleEquity,
            doubleTakeEquity: cubeResult.doubleTakeEquity,
            doublePassEquity: cubeResult.doublePassEquity,
            cubePly: cubeResult.engineMetadata?.cubePly
        },
        matchCubeDecision: {
            noDoubleNormEq: matchCubeResult.noDoubleNormEq,
            doubleTakeNormEq: matchCubeResult.doubleTakeNormEq,
            doublePassNormEq: matchCubeResult.doublePassNormEq
        },
        searchMs: result.durationMs,
        wallMs
    }, null, 2));
}

main()
    .catch((error) => {
        console.error(`Hedgehog smoke test failed: ${error.message}`);
        process.exitCode = 1;
    })
    .finally(() => runHedgehogAnalysis.close());
