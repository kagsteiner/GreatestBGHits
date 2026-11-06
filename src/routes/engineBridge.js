'use strict';

// The engine in the browser (src/engineBridge.js) asks here for work and sends its answers.

const express = require('express');
const { getBridges } = require('../engineBridge');

const router = express.Router();

// Before the general JSON limit: legal-play lists of doubles can be large.
router.post('/engineBridge/poll', express.json({ limit: '10kb' }), async (req, res) => {
    try {
        // A closed tab drops the poll: wake it, so its jobs are not sent into the void.
        const bridges = getBridges();
        let gone = false;
        res.on('close', () => {
            if (res.writableFinished) return;
            gone = true;
            const bridge = bridges.bridges.get(req.body?.bridge);
            if (bridge?.wake) bridge.wake();
        });
        res.json({ jobs: await bridges.poll(req.body?.bridge, req.body?.info, () => gone, { hello: req.body?.hello === true }) });
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});
router.post('/engineBridge/answer', express.json({ limit: '20mb' }), (req, res) => {
    const { bridge, job, result, error } = req.body || {};
    res.json({ ok: getBridges().answer(bridge, job, result, error) });
});

module.exports = router;
