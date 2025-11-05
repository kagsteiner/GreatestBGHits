'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const runGnuBgAnalysis = require('./src/gnubgRunner');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Healthcheck
app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

// POST /analyzePositionFromMatch
// Body: { matchId: string, positionIndex?: number }
app.post('/analyzePositionFromMatch', async (req, res) => {
    try {
        const { matchId, positionIndex } = req.body || {};

        if (!matchId || typeof matchId !== 'string') {
            return res.status(400).json({ error: 'matchId (string) is required' });
        }

        const result = await runGnuBgAnalysis({ matchId, positionIndex });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Server listening on http://localhost:${PORT}`);
});


