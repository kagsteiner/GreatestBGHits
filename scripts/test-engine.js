'use strict';

// Smoke test for the DarkBGHelmet engine: checks that it is reachable and
// answers a checker play and a cube decision. Run on the server after
// deploying: npm run test:engine

require('dotenv').config();
const BackgammonBoard = require('../src/board');
const { getClient } = require('../src/engines/bgEngine');

async function main() {
    const client = getClient();
    const info = await client.getInfo();
    console.log(`Engine: ${info.name} ${info.version}, network ${info.network} at ${client.config.url}`);

    const board = BackgammonBoard.starting('player1');
    board.dice = { die1: 3, die2: 1 };
    const checker = await client.analyzeChecker({ ogid: board.toOgid(), played: '13/10 10/9' });
    if (checker.moves[0]?.move !== '8/5 6/5') {
        throw new Error(`Unexpected best play for opening 31: ${checker.moves[0]?.move || 'none'}`);
    }
    if (!Number.isFinite(checker.played?.diff) || checker.played.diff >= 0) {
        throw new Error('The engine did not grade the played move 13/9 as an error');
    }
    console.log(`Opening 31 at ${checker.plies}-ply: best ${checker.moves[0].move}; `
        + `13/9 loses ${(-checker.played.diff).toFixed(3)} (${Math.round(checker.durationMs)} ms)`);

    board.dice = null;
    const cube = await client.analyzeCube({ ogid: board.toOgid() });
    if (cube.decision !== 'No double, take') {
        throw new Error(`Unexpected cube decision in the starting position: ${cube.decision}`);
    }
    console.log(`Starting position cube decision: ${cube.decision} (${Math.round(cube.durationMs)} ms)`);
    console.log(`Configured depths: ${client.config.plies}-ply import, ${client.config.deepPlies}-ply deep analysis`);
}

main().catch((error) => {
    console.error(`Engine test failed: ${error.message}`);
    process.exitCode = 1;
});
