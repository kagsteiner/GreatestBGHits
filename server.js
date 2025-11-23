'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const runGnuBgAnalysis = require('./src/gnubgRunner');
const {
    getNextQuiz,
    getQuizById,
    getAllPlayers,
    loadQuizzes,
    addQuizzesAndSave,
    recordQuizResult
} = require('./src/gameCore');
const { normalizeUsername } = require('./src/storage');
const CrawlerQueue = require('./src/crawlerQueue');

const app = express();
const PORT = process.env.PORT || 3033;
const crawlerQueue = new CrawlerQueue(addQuizzesAndSave);

function parseBasicAuth(header) {
    if (!header || typeof header !== 'string') return null;
    const trimmed = header.trim();
    if (!trimmed.toLowerCase().startsWith('basic ')) return null;
    const base64 = trimmed.slice(6).trim();
    let decoded;
    try {
        decoded = Buffer.from(base64, 'base64').toString('utf8');
    } catch (_) {
        return null;
    }
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    const username = decoded.slice(0, idx);
    const password = decoded.slice(idx + 1);
    if (!username) return null;
    return { username, password };
}

function requireUser(req, res, next) {
    const creds = parseBasicAuth(req.headers.authorization || '');
    if (!creds || !creds.username || creds.password === undefined) {
        return res.status(401).json({ error: 'Missing credentials' });
    }
    const storageKey = normalizeUsername(creds.username);
    if (!storageKey) {
        return res.status(400).json({ error: 'Username is required' });
    }
    req.userContext = {
        username: creds.username.trim(),
        password: creds.password,
        storageKey
    };
    next();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Healthcheck
app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

// POST /analyzePositionFromMatch
// Body: { matchId: string, positionId?: string, positionIndex?: number, dice?: { die1: number, die2: number } }
app.post('/analyzePositionFromMatch', async (req, res) => {
    try {
        const { matchId, positionId, positionIndex, dice } = req.body || {};

        if (!matchId || typeof matchId !== 'string') {
            return res.status(400).json({ error: 'matchId (string) is required' });
        }

        const result = await runGnuBgAnalysis({ matchId, positionId, positionIndex, dice });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /getQuiz - retrieve the JSON of the next quiz
// Query param: ?player=<playerName> to filter by player
app.get('/getQuiz', requireUser, async (req, res) => {
    try {
        const playerFilter = req.query.player || null;
        const quiz = await getNextQuiz(req.userContext.storageKey, playerFilter);
        if (!quiz) return res.status(204).end();
        res.json(quiz);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /getPlayers - retrieve all unique player names
app.get('/getPlayers', requireUser, async (req, res) => {
    try {
        const players = await getAllPlayers(req.userContext.storageKey);
        res.json(players);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /getStatistics - retrieve quiz statistics
app.get('/getStatistics', requireUser, async (req, res) => {
    try {
        const quizzes = await loadQuizzes(req.userContext.storageKey);
        const positions = quizzes.positions || [];

        let totalAttempts = 0;
        let totalCorrect = 0;
        const quizzesWithStats = [];

        for (const pos of positions) {
            const quiz = pos.quiz || { playCount: 0, correctAnswers: 0 };
            const playCount = Number(quiz.playCount) || 0;
            const correctAnswers = Number(quiz.correctAnswers) || 0;

            totalAttempts += playCount;
            totalCorrect += correctAnswers;

            if (playCount > 0) {
                quizzesWithStats.push({
                    id: pos.id,
                    playCount,
                    correctAnswers,
                    correctnessRate: correctAnswers / playCount,
                    best: pos.best
                });
            }
        }

        // Sort by correctness rate (ascending) to get worst quizzes
        quizzesWithStats.sort((a, b) => a.correctnessRate - b.correctnessRate);
        const worstQuizzes = quizzesWithStats.slice(0, 3);

        res.json({
            totalQuizzes: positions.length,
            totalAttempts,
            totalCorrect,
            worstQuizzes
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /getQuiz/:id - retrieve a quiz by its ID
app.get('/getQuiz/:id', requireUser, async (req, res) => {
    try {
        const { id } = req.params;
        if (!id || typeof id !== 'string') {
            return res.status(400).json({ error: 'id (string) is required' });
        }
        const quiz = await getQuizById(req.userContext.storageKey, id);
        if (!quiz) return res.status(404).json({ error: 'quiz not found' });
        res.json(quiz);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /updateQuiz - update quiz counters
// Body: { id: string, wasCorrect?: boolean }
app.post('/updateQuiz', requireUser, async (req, res) => {
    try {
        const { id, wasCorrect } = req.body || {};
        const isCorrect = Boolean(wasCorrect);
        if (!id || typeof id !== 'string') {
            return res.status(400).json({ error: 'id (string) is required' });
        }
        const updated = await recordQuizResult(req.userContext.storageKey, id, isCorrect);
        if (!updated) {
            return res.status(404).json({ error: 'quiz not found' });
        }
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /addLastMatchesAndSave - retrieve last matches, analyze and save
app.post('/addLastMatchesAndSave', requireUser, (req, res) => {
    try {
        const body = req.body || {};
        let daysValue;
        if (body.days !== undefined && body.days !== null && body.days !== '') {
            const parsed = parseInt(body.days, 10);
            if (!Number.isNaN(parsed) && parsed > 0) {
                daysValue = parsed;
            }
        }
        const job = crawlerQueue.createJob({
            username: req.userContext.storageKey,
            storageKey: req.userContext.storageKey,
            dgCredentials: {
                username: req.userContext.username,
                password: req.userContext.password,
                userId: body.userId ? String(body.userId) : null
            },
            days: daysValue
        });
        res.json({ jobId: job.id, aheadCount: job.aheadCount });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// SSE: GET /addLastMatchesAndSave/stream?jobId=UUID - subscribe to queue + progress updates
app.get('/addLastMatchesAndSave/stream', (req, res) => {
    const jobId = req.query.jobId;
    if (!jobId || typeof jobId !== 'string') {
        return res.status(400).json({ error: 'jobId query parameter is required' });
    }
    const job = crawlerQueue.getJob(jobId);
    if (!job) {
        return res.status(404).json({ error: 'job not found' });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    crawlerQueue.attach(jobId, res);
});

app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Server listening on http://localhost:${PORT}`);
});


