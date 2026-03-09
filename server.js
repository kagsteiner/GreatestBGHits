'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const runGnuBgAnalysis = require('./src/gnubgRunner');
const {
    getNextQuiz,
    getQuizById,
    getAnyQuizById,
    getAllPlayers,
    getAllMatches,
    loadQuizzes,
    addQuizzesAndSave,
    recordQuizResult,
    removeNackgammonQuizzes
} = require('./src/gameCore');
const { normalizeUsername, getAllUsersStats, recordActivity, getActivityStats, consumeAdminNotice } = require('./src/storage');
const { getActiveAdminNotice } = require('./src/adminNotice');
const CrawlerQueue = require('./src/crawlerQueue');

const app = express();
const PORT = process.env.PORT || 3033;
const crawlerQueue = new CrawlerQueue(addQuizzesAndSave);
const removeNackQueue = new CrawlerQueue(removeNackgammonQuizzes);

function log(message) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    // eslint-disable-next-line no-console
    console.log(`${date} ${time}: ${message}`);
}

function formatElapsed(ms) {
    const totalMinutes = Math.floor(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}:${String(minutes).padStart(2, '0')}`;
}

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

const activeUsersToday = { date: '', users: new Set() };

function trackDailyUser(storageKey) {
    const today = new Date().toISOString().slice(0, 10);
    if (activeUsersToday.date !== today) {
        activeUsersToday.date = today;
        activeUsersToday.users = new Set();
    }
    if (!activeUsersToday.users.has(storageKey)) {
        activeUsersToday.users.add(storageKey);
        recordActivity('logins');
    }
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
    trackDailyUser(storageKey);
    next();
}

function attachAdminNoticeForUser(storageKey, quizPayload) {
    if (!quizPayload || typeof quizPayload !== 'object') return quizPayload;
    const notice = getActiveAdminNotice();
    if (!notice || !notice.text || !notice.hash) return quizPayload;
    if (!consumeAdminNotice(storageKey, notice.hash)) return quizPayload;
    return { ...quizPayload, adminNotice: notice.text };
}

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Healthcheck
app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

// POST /validateCredentials - verify DailyGammon credentials before accepting them
app.post('/validateCredentials', requireUser, async (req, res) => {
    try {
        const DailyGammonRetriever = require('./DailyGammonRetriever');
        const retriever = new DailyGammonRetriever();
        const ok = await retriever.login(req.userContext.username, req.userContext.password);
        if (!ok) {
            log(`unsuccessful login attempt by ${req.userContext.username}`);
            await new Promise(r => setTimeout(r, 3000));
            return res.status(401).json({ error: 'Invalid DailyGammon credentials' });
        }
        log(`${req.userContext.username} logged in`);
        res.json({ valid: true });
    } catch (error) {
        res.status(502).json({ error: 'Unable to reach DailyGammon for verification' });
    }
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
// Query params: ?player=<playerName> to filter by player, ?match=<matchId> to filter by match
app.get('/getQuiz', requireUser, async (req, res) => {
    try {
        const playerFilter = req.query.player || null;
        const matchFilter = req.query.match || null;
        const quiz = await getNextQuiz(req.userContext.storageKey, playerFilter, matchFilter);
        if (!quiz) return res.status(204).end();
        log(`served quiz to ${req.userContext.username}`);
        recordActivity('quizzes_served');
        res.json(attachAdminNoticeForUser(req.userContext.storageKey, quiz));
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

// GET /getMatches - retrieve all unique matches with metadata
app.get('/getMatches', requireUser, async (req, res) => {
    try {
        const matches = await getAllMatches(req.userContext.storageKey, req.userContext.username);
        res.json(matches);
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
        res.json(attachAdminNoticeForUser(req.userContext.storageKey, quiz));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /getQuizDebug/:id - retrieve a quiz by its ID from ANY user (debug endpoint)
// This searches across all users' quizzes for debugging purposes
app.get('/getQuizDebug/:id', requireUser, async (req, res) => {
    try {
        const { id } = req.params;
        if (!id || typeof id !== 'string') {
            return res.status(400).json({ error: 'id (string) is required' });
        }
        const quiz = await getAnyQuizById(id);
        if (!quiz) return res.status(404).json({ error: 'quiz not found' });
        res.json(quiz);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /updateQuiz - update quiz counters
// Body: { id: string, wasCorrect?: boolean, ignored?: boolean }
app.post('/updateQuiz', requireUser, async (req, res) => {
    try {
        const { id, wasCorrect, ignored } = req.body || {};
        const isIgnored = Boolean(ignored);
        const isCorrect = Boolean(wasCorrect);
        if (!id || typeof id !== 'string') {
            return res.status(400).json({ error: 'id (string) is required' });
        }
        const updated = await recordQuizResult(req.userContext.storageKey, id, isCorrect, isIgnored);
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
                daysValue = Math.min(parsed, 60); // Cap at 60 days maximum
            }
        }
        const username = req.userContext.username;
        const job = crawlerQueue.createJob({
            username: req.userContext.storageKey,
            storageKey: req.userContext.storageKey,
            dgCredentials: {
                username,
                password: req.userContext.password,
                userId: body.userId ? String(body.userId) : null
            },
            days: daysValue
        }, {
            onStart: () => log(`adding quizzes for ${username}, queue size is ${crawlerQueue.getQueueSize()}`),
            onFinish: (elapsed, result) => {
                log(`finished adding quizzes for ${username} in ${formatElapsed(elapsed)} minutes, queue size is ${crawlerQueue.getQueueSize()}`);
                if (result && result.added > 0) recordActivity('quizzes_added', result.added);
            }
        });
        log(`added ${username} to queue, queue size is ${crawlerQueue.getQueueSize()}`);
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
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    crawlerQueue.attach(jobId, res);
});

// POST /removeNackgammon - remove quizzes from Nackgammon matches
app.post('/removeNackgammon', requireUser, (req, res) => {
    try {
        const job = removeNackQueue.createJob({
            username: req.userContext.storageKey,
            storageKey: req.userContext.storageKey,
            dgCredentials: {
                username: req.userContext.username,
                password: req.userContext.password
            }
        });
        res.json({ jobId: job.id, aheadCount: job.aheadCount });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// SSE: GET /removeNackgammon/stream?jobId=UUID - subscribe to remove progress updates
app.get('/removeNackgammon/stream', (req, res) => {
    const jobId = req.query.jobId;
    if (!jobId || typeof jobId !== 'string') {
        return res.status(400).json({ error: 'jobId query parameter is required' });
    }
    const job = removeNackQueue.getJob(jobId);
    if (!job) {
        return res.status(404).json({ error: 'job not found' });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    removeNackQueue.attach(jobId, res);
});

// GET /siteStats - get global statistics for all users
app.get('/siteStats', (_req, res) => {
    try {
        const stats = getAllUsersStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /activityStats - daily + monthly activity data
app.get('/activityStats', (_req, res) => {
    try {
        res.json(getActivityStats());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

if (require.main === module) {
    app.listen(PORT, () => {
        // eslint-disable-next-line no-console
        console.log(`Server listening on http://localhost:${PORT}`);
    });
}

module.exports = app;


