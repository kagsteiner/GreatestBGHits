'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const bgEngine = require('./src/engines/bgEngine');
const { isAvailableQuiz } = require('./src/quizAnalysis');
const {
    getNextQuiz,
    getQuizById,
    getAllPlayers,
    getAllMatches,
    loadQuizzes,
    addQuizzesAndSave,
    recordQuizResult,
    analyzeQuizPosition,
    quizAnalysisLimits,
    getLegalPlays,
    evaluateQuizMove
} = require('./src/gameCore');
const { normalizeUsername, getAllUsersStats, recordActivity, getActivityStats, consumeAdminNotice, database } = require('./src/storage');
const { getActiveAdminNotice } = require('./src/adminNotice');
const CrawlerQueue = require('./src/crawlerQueue');
const { MATCH_LENGTHS, PlayError, getPlayMatches } = require('./src/playMatch');
const { AccountError, createPlayStore } = require('./src/playStore');
const { FriendError, getFriendTable } = require('./src/friendMatch');
const { createFriendStore } = require('./src/friendStore');
const { matchToMat } = require('./src/matExport');
const { buildReview } = require('./src/matchReview');
const localAnalysis = require('./src/localAnalysis');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3033;
const crawlerQueue = new CrawlerQueue(addQuizzesAndSave);
app.locals.crawlerQueue = crawlerQueue;

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
app.use('/shared', express.static(path.join(__dirname, 'shared')));

// Healthcheck
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', analysis: bgEngine.getClient().getStatus() });
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

// GET /getQuiz - retrieve the JSON of the next quiz
// Query params: player, match, mode=checker|cube|mixed, afterType=checker|cube
app.get('/getQuiz', requireUser, async (req, res) => {
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

function engineErrorStatus(error) {
    return /unreachable|queue is full|timed out/i.test(error.message) ? 503 : 500;
}

// GET /quizAnalysis/limits - the depths the quiz analysis panel offers, and the
// depth at which an analysis is saved as the quiz's deep analysis
app.get('/quizAnalysis/limits', requireUser, (req, res) => {
    res.json(quizAnalysisLimits());
});

// POST /quizAnalysis - analysis of a quiz position for the quiz page's panel:
// all plays (kind 'move'), one play searched deeper ('deepen', with move), or
// the cube decision ('cube'). At the deep depth the result is also saved.
// Body: { id: string, kind?: string, plies?: number, move?: string, answer?: string }
// Returns { analysis, quiz, answer }: quiz is the updated quiz if it was saved,
// answer the play answered in the quiz in the engine's notation.
app.post('/quizAnalysis', requireUser, async (req, res) => {
    try {
        const { id, kind, plies, move, answer } = req.body || {};
        if (!id || typeof id !== 'string') {
            return res.status(400).json({ error: 'id (string) is required' });
        }
        const result = await analyzeQuizPosition(req.userContext.storageKey, id, { kind, plies, move, answer });
        if (!result) return res.status(404).json({ error: 'quiz not found' });
        res.json(result);
    } catch (error) {
        if (error instanceof localAnalysis.AnalysisError) return res.status(error.status).json({ error: error.message });
        res.status(engineErrorStatus(error)).json({ error: error.message });
    }
});

// GET /legalPlays/:id - all legal plays of a checker quiz, for moving checkers on the board
app.get('/legalPlays/:id', requireUser, async (req, res) => {
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
app.post('/evaluateMove', requireUser, async (req, res) => {
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

// --- Play against the engine (not linked anywhere) ---
// Only enabled when PLAY_ACCESS_KEY is set, and only for requests that send
// that key in the X-Play-Key header. No DailyGammon account is needed: each
// browser identifies itself with a random id (X-Play-Player), which keeps its
// match apart from other players' matches. Players may register a play
// account (X-Play-Session) to keep a history of their matches; their match
// then follows the account from device to device.
const playStore = createPlayStore(database);
getPlayMatches().store = playStore;
// Matches live in memory, so after a restart unfinished ones are over.
playStore.abandonInProgress();

function requirePlayAccess(req, res, next) {
    const expected = process.env.PLAY_ACCESS_KEY || '';
    const given = String(req.get('X-Play-Key') || '');
    const ok = expected.length > 0
        && given.length === expected.length
        && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) return res.status(404).json({ error: 'Not found' });
    const player = String(req.get('X-Play-Player') || '');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(player)) return res.status(400).json({ error: 'Missing player id' });
    req.playBrowser = `player:${player}`;
    req.playUser = playStore.userForToken(req.get('X-Play-Session'));
    req.playPlayer = req.playUser ? `user:${req.playUser.id}` : req.playBrowser;
    next();
}

function requirePlayUser(req, res, next) {
    if (!req.playUser) return res.status(401).json({ error: 'Please log in' });
    next();
}

function sendAccount(req, res, result) {
    // A match started before logging in continues under the account.
    getPlayMatches().adopt(req.playBrowser, `user:${result.user.id}`, result.user);
    res.json({ token: result.token, name: result.user.name });
}

app.post('/play/register', requirePlayAccess, (req, res) => {
    try {
        const result = playStore.register(req.body?.name, req.body?.password);
        log(`play account '${result.user.name}' registered`);
        sendAccount(req, res, result);
    } catch (error) {
        res.status(error instanceof AccountError ? error.status : 500).json({ error: error.message });
    }
});

app.post('/play/login', requirePlayAccess, (req, res) => {
    try {
        sendAccount(req, res, playStore.login(req.body?.name, req.body?.password));
    } catch (error) {
        res.status(error instanceof AccountError ? error.status : 500).json({ error: error.message });
    }
});

app.post('/play/logout', requirePlayAccess, (req, res) => {
    playStore.logout(req.get('X-Play-Session'));
    res.json({ ok: true });
});

app.get('/play/history', requirePlayAccess, requirePlayUser, (req, res) => {
    res.json({ matches: playStore.listMatches(req.playUser.id) });
});

// GET /play/history/:id/review - one match as review steps for stepping through it
app.get('/play/history/:id/review', requirePlayAccess, requirePlayUser, (req, res) => {
    const match = playStore.getMatch(req.playUser.id, req.params.id);
    if (!match) return res.status(404).json({ error: 'match not found' });
    const { games, ...summary } = match;
    res.json({
        match: summary,
        player: req.playUser.name,
        games: buildReview(match),
        analysis: (() => {
            const { defaultPlies, maxPlies, rolloutModes } = localAnalysis.limits();
            return { plies: defaultPlies, maxPlies, rollouts: rolloutModes };
        })()
    });
});

// POST /play/analysis - analysis of a position: up to 4-ply, or with
// LOCAL_ANALYSIS=1 up to 7-ply and rollouts (see src/localAnalysis.js)
// Body: { kind: 'move'|'deepen'|'cube'|'rollout-move'|'rollout-cube', ogid, played?, move?, plies?, mode?, candidates? }
app.post('/play/analysis', requirePlayAccess, requirePlayUser, async (req, res) => {
    try {
        res.json(await localAnalysis.analyze(bgEngine.getClient(), req.body || {}));
    } catch (error) {
        if (error instanceof localAnalysis.AnalysisError) return res.status(error.status).json({ error: error.message });
        res.status(engineErrorStatus(error)).json({ error: error.message });
    }
});

// GET /play/history/:id/mat - one match as a .mat file for XG or gnubg
app.get('/play/history/:id/mat', requirePlayAccess, requirePlayUser, (req, res) => {
    const match = playStore.getMatch(req.playUser.id, req.params.id);
    if (!match) return res.status(404).json({ error: 'match not found' });
    const date = match.startedAt.slice(0, 10);
    res.attachment(`secondroll-${date}-${match.length}pt-vs-darkbghelmet.mat`);
    res.type('text/plain');
    res.send(matchToMat(match, req.playUser.name));
});

function sendPlayError(res, error) {
    if (error instanceof PlayError) return res.status(error.status).json({ error: error.message });
    res.status(engineErrorStatus(error)).json({ error: error.message });
}

app.get('/play/state', requirePlayAccess, (req, res) => {
    const matches = getPlayMatches();
    const state = matches.state(req.playPlayer);
    res.json({
        match: state,
        user: req.playUser ? req.playUser.name : null,
        matchLengths: MATCH_LENGTHS,
        levels: matches.levels,
        defaultLevel: matches.defaultLevel
    });
});

app.post('/play/new', requirePlayAccess, async (req, res) => {
    try {
        const length = Number(req.body?.length);
        const matches = getPlayMatches();
        const plies = req.body?.plies === undefined ? matches.defaultLevel : Number(req.body.plies);
        const state = await matches.start(req.playPlayer, length, plies, req.playUser);
        const who = req.playUser ? `'${req.playUser.name}'` : req.playPlayer.slice(0, 15);
        log(`${who} started a ${length}-point match against the engine at ${plies}-ply`);
        res.json({ match: state });
    } catch (error) {
        sendPlayError(res, error);
    }
});

// POST /play/mark - mark a graded decision of the current match for the review
// Body: { id: string, marked: boolean }
app.post('/play/mark', requirePlayAccess, requirePlayUser, (req, res) => {
    try {
        const { id, marked } = req.body || {};
        if (typeof id !== 'string') return res.status(400).json({ error: 'id (string) is required' });
        res.json(getPlayMatches().mark(req.playPlayer, id, marked !== false));
    } catch (error) {
        sendPlayError(res, error);
    }
});

app.post('/play/action', requirePlayAccess, async (req, res) => {
    try {
        const state = await getPlayMatches().act(req.playPlayer, req.body || {});
        res.json({ match: state });
    } catch (error) {
        sendPlayError(res, error);
    }
});

// --- A friendly match between two people (friend.html, not linked anywhere) ---
// Behind the same access key as playing against the engine. The first two
// browsers at the table play each other; the server grades both and keeps
// a history of the finished matches.
const friendStore = createFriendStore(database);
getFriendTable().store = friendStore;

function sendFriendError(res, error) {
    if (error instanceof FriendError) return res.status(error.status).json({ error: error.message });
    res.status(engineErrorStatus(error)).json({ error: error.message });
}

app.get('/friend/state', requirePlayAccess, (req, res) => {
    res.json(getFriendTable().state(req.playBrowser));
});

// POST /friend/join - take a seat at the table. Body: { name: string }
app.post('/friend/join', requirePlayAccess, (req, res) => {
    try {
        const state = getFriendTable().join(req.playBrowser, req.body?.name);
        log(`'${req.body?.name}' joined the friend table`);
        res.json(state);
    } catch (error) {
        sendFriendError(res, error);
    }
});

app.post('/friend/leave', requirePlayAccess, (req, res) => {
    try {
        res.json(getFriendTable().leave(req.playBrowser));
    } catch (error) {
        sendFriendError(res, error);
    }
});

// POST /friend/length - choose the match length; it starts once both chose the same. Body: { length }
app.post('/friend/length', requirePlayAccess, async (req, res) => {
    try {
        res.json(await getFriendTable().chooseLength(req.playBrowser, Number(req.body?.length)));
    } catch (error) {
        sendFriendError(res, error);
    }
});

// POST /friend/action - Body: { type: 'roll'|'double'|'take'|'pass'|'move'|'next-game', key? }
app.post('/friend/action', requirePlayAccess, async (req, res) => {
    try {
        res.json(await getFriendTable().act(req.playBrowser, req.body || {}));
    } catch (error) {
        sendFriendError(res, error);
    }
});

// POST /friend/mark - Body: { id: string, marked: boolean }
app.post('/friend/mark', requirePlayAccess, (req, res) => {
    try {
        const { id, marked } = req.body || {};
        if (typeof id !== 'string') return res.status(400).json({ error: 'id (string) is required' });
        res.json(getFriendTable().mark(req.playBrowser, id, marked !== false));
    } catch (error) {
        sendFriendError(res, error);
    }
});

app.get('/friend/history', requirePlayAccess, (req, res) => {
    const { defaultPlies, maxPlies } = localAnalysis.limits();
    res.json({ matches: friendStore.listMatches(), analysis: { plies: defaultPlies, maxPlies } });
});

// POST /friend/analysis - analysis of a marked position (as /play/analysis)
app.post('/friend/analysis', requirePlayAccess, async (req, res) => {
    try {
        res.json(await localAnalysis.analyze(bgEngine.getClient(), req.body || {}));
    } catch (error) {
        if (error instanceof localAnalysis.AnalysisError) return res.status(error.status).json({ error: error.message });
        res.status(engineErrorStatus(error)).json({ error: error.message });
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
