'use strict';

const runHedgehogAnalysis = require('./hedgehogEngine');

const DEEP_MODEL = 'aureus-v0.1';
const REQUESTED_CHECKER_PLY = 3;
const CUBE_PLY = 2;

let client = null;

function getClient() {
    if (!client) {
        client = new runHedgehogAnalysis.HedgehogEngineClient({
            model: DEEP_MODEL,
            ply: REQUESTED_CHECKER_PLY,
            cubePly: CUBE_PLY,
            timeoutMs: process.env.HEDGEHOG_DEEP_TIMEOUT_MS || 300000,
            maxPending: process.env.HEDGEHOG_DEEP_MAX_PENDING || 4
        });
    }
    return client;
}

async function analyze(params) {
    return getClient().analyze(params);
}

analyze.analyzeCube = (params) => getClient().analyzeCube(params);
analyze.getStatus = () => client?.getStatus() || {
    running: false,
    model: DEEP_MODEL,
    requestedPly: REQUESTED_CHECKER_PLY,
    cubePly: CUBE_PLY
};
analyze.close = async () => {
    if (client) await client.close();
    client = null;
};
analyze.DEEP_MODEL = DEEP_MODEL;
analyze.REQUESTED_CHECKER_PLY = REQUESTED_CHECKER_PLY;

module.exports = analyze;
