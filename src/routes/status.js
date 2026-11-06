'use strict';

// How the server and the site are doing.

const express = require('express');
const bgEngine = require('../engines/bgEngine');
const { getAllUsersStats, getActivityStats } = require('../storage');

const router = express.Router();

// Healthcheck
router.get('/health', (_req, res) => {
    res.json({ status: 'ok', analysis: bgEngine.getClient().getStatus() });
});

// GET /siteStats - get global statistics for all users
router.get('/siteStats', (_req, res) => {
    try {
        const stats = getAllUsersStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /activityStats - daily + monthly activity data
router.get('/activityStats', (_req, res) => {
    try {
        res.json(getActivityStats());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
