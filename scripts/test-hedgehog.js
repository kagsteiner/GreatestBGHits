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

    if (!result.engineAvailable) throw new Error(result.error || 'Hedgehog is unavailable');
    if (!result.bestMoveVerified) throw new Error('Best-move verification failed');
    if (moveSignature(result.moves[0]?.move) !== moveSignature('8/5 6/5')) {
        throw new Error(`Unexpected 3-1 opening move: ${result.moves[0]?.move || 'none'}`);
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
