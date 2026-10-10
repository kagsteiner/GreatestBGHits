'use strict';

require('dotenv').config();
const { DEFAULT_MISTAKE_THRESHOLD } = require('../src/constants');

const fs = require('fs');
const path = require('path');
const analyzeMatch = require('../src/analyzeMatch');

async function main() {
    const inputPath = process.argv[2];
    if (!inputPath) {
        console.error('Usage: node scripts/test-match-analysis.js <path-to-match-json> [threshold]');
        process.exit(1);
    }

    const threshold = process.argv[3] ? Number(process.argv[3]) : DEFAULT_MISTAKE_THRESHOLD;
    const fullPath = path.resolve(process.cwd(), inputPath);
    const raw = fs.readFileSync(fullPath, 'utf8');
    const match = JSON.parse(raw);

    const result = await analyzeMatch(match, { threshold });
    console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});


