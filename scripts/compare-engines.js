'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
process.env.ANALYSIS_ENGINE = 'compare';
const analyzePosition = require('../src/engines/analysisEngine');

function usage() {
    console.error('Usage: npm run compare:engines -- <positions.json>');
    console.error('Input: an array (or { positions: [...] }) of GNU IDs or { gnuId, dice, playedMove } objects.');
}

function percentile(values, fraction) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(reports) {
    const comparable = reports.filter((report) => report.gnu.available && report.hedgehog.available);
    const withPlayedMove = comparable.filter((report) => report.gnu.playedMoveRecognized !== null);
    const durations = (engine) => reports
        .map((report) => report[engine].durationMs)
        .filter(Number.isFinite);
    const durationStats = (engine) => {
        const values = durations(engine);
        return {
            p50Ms: percentile(values, 0.5),
            p95Ms: percentile(values, 0.95),
            worstMs: values.length ? Math.max(...values) : null
        };
    };

    return {
        positions: reports.length,
        gnuAvailable: reports.filter((report) => report.gnu.available).length,
        hedgehogAvailable: reports.filter((report) => report.hedgehog.available).length,
        comparable: comparable.length,
        bestMoveAgreements: comparable.filter((report) => report.bestMoveAgreement).length,
        bestMoveAgreementRate: comparable.length
            ? comparable.filter((report) => report.bestMoveAgreement).length / comparable.length
            : null,
        playedMovesChecked: withPlayedMove.length,
        gnuPlayedMovesRecognized: withPlayedMove.filter((report) => report.gnu.playedMoveRecognized).length,
        hedgehogPlayedMovesRecognized: withPlayedMove.filter((report) => report.hedgehog.playedMoveRecognized).length,
        duration: {
            gnubg: durationStats('gnu'),
            hedgehog: durationStats('hedgehog')
        }
    };
}

async function main() {
    const inputArgument = process.argv[2];
    if (!inputArgument) {
        usage();
        process.exitCode = 2;
        return;
    }

    const inputPath = path.resolve(inputArgument);
    const parsed = JSON.parse(await fs.promises.readFile(inputPath, 'utf8'));
    const positions = Array.isArray(parsed) ? parsed : parsed.positions;
    if (!Array.isArray(positions)) throw new Error('Input must be an array or contain a positions array');

    const reports = [];
    for (let index = 0; index < positions.length; index++) {
        const input = typeof positions[index] === 'string' ? { gnuId: positions[index] } : positions[index];
        const matchId = input.gnuId || input.matchId;
        if (!matchId) throw new Error(`Position ${index + 1} has no gnuId`);
        const result = await analyzePosition({
            matchId,
            positionIndex: input.positionIndex ?? index,
            dice: input.dice || input.context?.dice,
            playedMove: input.playedMove || input.userMoveParts || input.user?.move
        });
        reports.push(result.comparison);
        const report = result.comparison;
        console.error(
            `${index + 1}/${positions.length}: agreement=${report.bestMoveAgreement} `
            + `GNU=${report.gnu.durationMs.toFixed(1)}ms Hedgehog=${report.hedgehog.durationMs.toFixed(1)}ms`
        );
    }

    console.log(JSON.stringify({
        generatedAt: new Date().toISOString(),
        authoritativeEngine: 'gnubg',
        summary: summarize(reports),
        reports
    }, null, 2));
}

main()
    .catch((error) => {
        console.error(`Engine comparison failed: ${error.message}`);
        process.exitCode = 1;
    })
    .finally(() => analyzePosition.close());
