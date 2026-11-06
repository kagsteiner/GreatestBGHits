'use strict';

const { MatchError } = require('../matchCore');

function engineErrorStatus(error) {
    return /unreachable|queue is full|timed out|too deep|engine in this browser/i.test(error.message) ? 503 : 500;
}

function sendMatchError(res, error) {
    if (error instanceof MatchError) {
        return res.status(error.status).json({ error: error.message, ...(error.takeOver ? { takeOver: true } : {}) });
    }
    res.status(engineErrorStatus(error)).json({ error: error.message });
}

module.exports = { engineErrorStatus, sendMatchError };
