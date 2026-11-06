'use strict';

const express = require('express');
const bgEngine = require('../engines/bgEngine');
const localAnalysis = require('../localAnalysis');
const { engineErrorStatus } = require('./errors');
const { requirePlayAccess } = require('./playAccess');

const router = express.Router();

// POST /analysis - analysis of a position in a match, for the review and the
// friendly match: up to 4-ply, or up to 7-ply and rollouts in the browser's
// engine or with LOCAL_ANALYSIS=1 (see src/localAnalysis.js)
// Body: { kind: 'move'|'deepen'|'cube'|'rollout-move'|'rollout-cube', ogid, played?, move?, plies?, mode?, candidates? }
router.post('/analysis', requirePlayAccess, async (req, res) => {
    try {
        res.json(await localAnalysis.analyze(bgEngine.getClient(), req.body || {}));
    } catch (error) {
        if (error instanceof localAnalysis.AnalysisError) return res.status(error.status).json({ error: error.message });
        res.status(engineErrorStatus(error)).json({ error: error.message });
    }
});

module.exports = router;
