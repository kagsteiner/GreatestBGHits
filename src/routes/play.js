'use strict';

// Playing against the engine, a player's account and their match history.

const express = require('express');
const { MATCH_LENGTHS, getPlayMatches } = require('../playMatch');
const { AccountError } = require('../playStore');
const { matchToMat } = require('../matExport');
const { buildReview } = require('../matchReview');
const localAnalysis = require('../localAnalysis');
const { log } = require('../log');
const { sendMatchError } = require('./errors');
const { playStore, requirePlayAccess, requirePlayUser } = require('./playAccess');

const router = express.Router();

function sendAccount(req, res, result) {
    // A match started before logging in continues under the account.
    getPlayMatches().adopt(req.playBrowser, `user:${result.user.id}`, result.user);
    res.json({ token: result.token, name: result.user.name });
}

router.post('/play/register', requirePlayAccess, (req, res) => {
    try {
        const result = playStore.register(req.body?.name, req.body?.password);
        log(`play account '${result.user.name}' registered`);
        sendAccount(req, res, result);
    } catch (error) {
        res.status(error instanceof AccountError ? error.status : 500).json({ error: error.message });
    }
});

router.post('/play/login', requirePlayAccess, (req, res) => {
    try {
        sendAccount(req, res, playStore.login(req.body?.name, req.body?.password));
    } catch (error) {
        res.status(error instanceof AccountError ? error.status : 500).json({ error: error.message });
    }
});

router.post('/play/logout', requirePlayAccess, (req, res) => {
    playStore.logout(req.get('X-Play-Session'));
    res.json({ ok: true });
});

router.get('/play/history', requirePlayAccess, requirePlayUser, (req, res) => {
    res.json({ matches: playStore.listMatches(req.playUser.id) });
});

// GET /play/history/:id/review - one match as review steps for stepping through it
router.get('/play/history/:id/review', requirePlayAccess, requirePlayUser, (req, res) => {
    const match = playStore.getMatch(req.playUser.id, req.params.id);
    if (!match) return res.status(404).json({ error: 'match not found' });
    const { games, ...summary } = match;
    res.json({
        match: summary,
        player: req.playUser.name,
        games: buildReview(match),
        analysis: localAnalysis.viewLimits()
    });
});

// GET /play/running/review - the player's match as it stands, as review steps:
// the decisions made so far (none that is still to be made)
router.get('/play/running/review', requirePlayAccess, (req, res) => {
    const running = getPlayMatches().runningReview(req.playPlayer);
    if (!running) return res.status(404).json({ error: 'no match is running' });
    const { games, ...summary } = running;
    res.json({
        match: summary,
        player: req.playUser ? req.playUser.name : 'You',
        games: buildReview(running),
        analysis: localAnalysis.viewLimits(),
        running: true
    });
});

// GET /play/history/:id/mat - one match as a .mat file for XG or gnubg
router.get('/play/history/:id/mat', requirePlayAccess, requirePlayUser, (req, res) => {
    const match = playStore.getMatch(req.playUser.id, req.params.id);
    if (!match) return res.status(404).json({ error: 'match not found' });
    const date = match.startedAt.slice(0, 10);
    res.attachment(`secondroll-${date}-${match.length}pt-vs-darkbghelmet.mat`);
    res.type('text/plain');
    res.send(matchToMat(match, req.playUser.name));
});

router.get('/play/state', requirePlayAccess, (req, res) => {
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

router.post('/play/new', requirePlayAccess, async (req, res) => {
    try {
        const length = Number(req.body?.length);
        const matches = getPlayMatches();
        const plies = req.body?.plies === undefined ? matches.defaultLevel : Number(req.body.plies);
        const state = await matches.start(req.playPlayer, length, plies, req.playUser);
        const who = req.playUser ? `'${req.playUser.name}'` : req.playPlayer.slice(0, 15);
        log(`${who} started a ${length}-point match against the engine at ${plies}-ply`);
        res.json({ match: state });
    } catch (error) {
        sendMatchError(res, error);
    }
});

// POST /play/mark - mark a graded decision of the current match for the review
// Body: { id: string, marked: boolean }
router.post('/play/mark', requirePlayAccess, requirePlayUser, (req, res) => {
    try {
        const { id, marked } = req.body || {};
        if (typeof id !== 'string') return res.status(400).json({ error: 'id (string) is required' });
        res.json(getPlayMatches().mark(req.playPlayer, id, marked !== false));
    } catch (error) {
        sendMatchError(res, error);
    }
});

router.post('/play/action', requirePlayAccess, async (req, res) => {
    try {
        const state = await getPlayMatches().act(req.playPlayer, req.body || {});
        res.json({ match: state });
    } catch (error) {
        sendMatchError(res, error);
    }
});

module.exports = router;
