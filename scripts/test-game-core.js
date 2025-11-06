'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { buildGamePositions } = require('../src/gameCore');
const { DEFAULT_MISTAKE_THRESHOLD } = require('../src/constants');

async function main() {
    const inputPath = process.argv[2];
    if (!inputPath) {
        console.error('Usage: node scripts/test-game-core.js <path-to-match-or-game-json> [userName] [threshold]');
        process.exit(1);
    }
    const userName = process.argv[3] || '';
    const threshold = process.argv[4] ? Number(process.argv[4]) : DEFAULT_MISTAKE_THRESHOLD;

    const fullPath = path.resolve(process.cwd(), inputPath);
    const raw = fs.readFileSync(fullPath, 'utf8');
    const matchOrGame = JSON.parse(raw);

    const result = await buildGamePositions(matchOrGame, { userName, threshold });
    console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});



