'use strict';

// The quiz: everything for a DailyGammon user, who logs in with those credentials.

const express = require('express');
const { isAvailableQuiz } = require('../quizAnalysis');
const {
    getNextQuiz,
    getQuizById,
    getAllPlayers,
    getAllMatches,
    loadQuizzes,
    recordQuizResult,
    analyzeQuizPosition,
    quizAnalysisLimits,
    getLegalPlays,
    evaluateQuizMove
} = require('../gameCore');
const { normalizeUsername, recordActivity, consumeAdminNotice } = require('../storage');
const { getActiveAdminNotice } = require('../adminNotice');
const localAnalysis = require('../localAnalysis');
const { log } = require('../log');
const { engineErrorStatus } = require('./errors');

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

/** @param {object} crawlerQueue adds a user's latest matches as quizzes, one user at a time */
function createQuizRoutes(crawlerQueue) {
    const router = express.Router();

    // POST /validateCredentials - verify DailyGammon credentials before accepting them
    router.post('/validateCredentials', requireUser, async (req, res) => {
        try {
            const DailyGammonRetriever = require('../../DailyGammonRetriever');
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

    // GET /getQuiz - retrieve the JSON of the next quiz
    // Query params: player, match, mode=checker|cube|mixed, afterType=checker|cube
    router.get('/getQuiz', requireUser, async (req, res) => {
        try {
            const playerFilter = req.query.player || null;
            const matchFilter = req.query.match || null;
            const requestedMode = ['checker', 'cube', 'mixed'].includes(req.query.mode)
                ? req.query.mode
                : 'mixed';
            const afterType = ['checker', 'cube'].includes(req.query.afterType)
                ? req.query.afterType
                : null;
            const quiz = await getNextQuiz(
                req.userContext.storageKey,
                playerFilter,
                matchFilter,
                requestedMode,
                afterType
            );
            if (!quiz) return res.status(204).end();
            log(`served quiz to ${req.userContext.username}`);
            recordActivity('quizzes_served');
            res.json(attachAdminNoticeForUser(req.userContext.storageKey, quiz));
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /getPlayers - retrieve all unique player names
    router.get('/getPlayers', requireUser, async (req, res) => {
        try {
            const players = await getAllPlayers(req.userContext.storageKey);
            res.json(players);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /getMatches - retrieve all unique matches with metadata
    router.get('/getMatches', requireUser, async (req, res) => {
        try {
            const matches = await getAllMatches(req.userContext.storageKey, req.userContext.username);
            res.json(matches);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /getStatistics - retrieve quiz statistics
    router.get('/getStatistics', requireUser, async (req, res) => {
        try {
            const quizzes = await loadQuizzes(req.userContext.storageKey);
            const storedPositions = quizzes.positions || [];
            const positions = storedPositions.filter(isAvailableQuiz);

            let totalAttempts = 0;
            let totalCorrect = 0;
            const quizzesWithStats = [];
            const byType = {
                checker: { totalQuizzes: 0, totalAttempts: 0, totalCorrect: 0 },
                cube: { totalQuizzes: 0, totalAttempts: 0, totalCorrect: 0 }
            };

            for (const pos of positions) {
                const quiz = pos.quiz || { playCount: 0, correctAnswers: 0 };
                const playCount = Number(quiz.playCount) || 0;
                const correctAnswers = Number(quiz.correctAnswers) || 0;

                totalAttempts += playCount;
                totalCorrect += correctAnswers;
                const group = pos.type === 'cube-offer' || pos.type === 'cube-response' ? 'cube' : 'checker';
                byType[group].totalQuizzes += 1;
                byType[group].totalAttempts += playCount;
                byType[group].totalCorrect += correctAnswers;

                if (playCount > 0) {
                    quizzesWithStats.push({
                        id: pos.id,
                        playCount,
                        correctAnswers,
                        correctnessRate: correctAnswers / playCount,
                        best: pos.best,
                        type: pos.type || 'move'
                    });
                }
            }

            // Sort by correctness rate (ascending) to get worst quizzes
            quizzesWithStats.sort((a, b) => a.correctnessRate - b.correctnessRate);
            const worstQuizzes = quizzesWithStats.slice(0, 3);

            res.json({
                totalQuizzes: positions.length,
                storedQuizzes: storedPositions.length,
                totalAttempts,
                totalCorrect,
                byType,
                worstQuizzes
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /getQuiz/:id - retrieve a quiz by its ID
    router.get('/getQuiz/:id', requireUser, async (req, res) => {
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

    // POST /updateQuiz - update quiz counters
    // Body: { id: string, wasCorrect?: boolean, ignored?: boolean }
    router.post('/updateQuiz', requireUser, async (req, res) => {
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

    // GET /quizAnalysis/limits - the depths the quiz analysis panel offers, and the
    // depth at which an analysis is saved as the quiz's deep analysis
    router.get('/quizAnalysis/limits', requireUser, (req, res) => {
        res.json(quizAnalysisLimits());
    });

    // POST /quizAnalysis - analysis of a quiz position for the quiz page's panel:
    // all plays (kind 'move'), one play searched deeper ('deepen', with move), the
    // cube decision ('cube'), or a rollout ('rollout-move', 'rollout-cube', with
    // mode). An analysis deeper than the quiz's own is also saved.
    // Body: { id: string, kind?: string, plies?: number, move?: string, answer?: string, mode?: string }
    // Returns { analysis, quiz, answer }: quiz is the updated quiz if it was saved,
    // answer the play answered in the quiz in the engine's notation.
    router.post('/quizAnalysis', requireUser, async (req, res) => {
        try {
            const { id, kind, plies, move, answer, mode } = req.body || {};
            if (!id || typeof id !== 'string') {
                return res.status(400).json({ error: 'id (string) is required' });
            }
            const result = await analyzeQuizPosition(req.userContext.storageKey, id, { kind, plies, move, answer, mode });
            if (!result) return res.status(404).json({ error: 'quiz not found' });
            res.json(result);
        } catch (error) {
            if (error instanceof localAnalysis.AnalysisError) return res.status(error.status).json({ error: error.message });
            res.status(engineErrorStatus(error)).json({ error: error.message });
        }
    });

    // GET /legalPlays/:id - all legal plays of a checker quiz, for moving checkers on the board
    router.get('/legalPlays/:id', requireUser, async (req, res) => {
        try {
            const result = await getLegalPlays(req.userContext.storageKey, req.params.id);
            if (!result) return res.status(404).json({ error: 'quiz not found' });
            res.json(result);
        } catch (error) {
            res.status(engineErrorStatus(error)).json({ error: error.message });
        }
    });

    // POST /evaluateMove - rate a checker play that is not one of the quiz's answer options
    // Body: { id: string, move: string }
    router.post('/evaluateMove', requireUser, async (req, res) => {
        try {
            const { id, move } = req.body || {};
            if (!id || typeof id !== 'string' || typeof move !== 'string') {
                return res.status(400).json({ error: 'id (string) and move (string) are required' });
            }
            const result = await evaluateQuizMove(req.userContext.storageKey, id, move);
            if (!result) return res.status(404).json({ error: 'quiz not found' });
            res.json(result);
        } catch (error) {
            if (error?.code === 'QUIZ_MOVE_NOT_RECOGNIZED') return res.status(400).json({ error: error.message });
            res.status(engineErrorStatus(error)).json({ error: error.message });
        }
    });

    // POST /addLastMatchesAndSave - retrieve last matches, analyze and save
    router.post('/addLastMatchesAndSave', requireUser, (req, res) => {
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
    router.get('/addLastMatchesAndSave/stream', (req, res) => {
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

    return router;
}

module.exports = { createQuizRoutes };
