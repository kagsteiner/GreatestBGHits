'use strict';

const runHedgehogAnalysis = require('./hedgehogEngine');

async function analyzePosition(params) {
    return runHedgehogAnalysis(params);
}

analyzePosition.close = () => runHedgehogAnalysis.close();
analyzePosition.analyzeCube = (params) => runHedgehogAnalysis.analyzeCube(params);
analyzePosition.getStatus = () => {
    const hedgehog = runHedgehogAnalysis.getStatus();
    return {
        engine: 'hedgehog',
        running: hedgehog.running,
        pending: hedgehog.pending,
        metadata: hedgehog.metadata,
        lastError: hedgehog.lastError,
        model: hedgehog.config.modelId,
        modelName: hedgehog.config.modelName,
        ply: hedgehog.config.ply,
        cubePly: hedgehog.config.cubePly,
        timeoutMs: hedgehog.config.timeoutMs,
        maxPending: hedgehog.config.maxPending
    };
};

module.exports = analyzePosition;
