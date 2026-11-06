'use strict';

// A friendly match between two people (friend.html, not linked anywhere).
// Behind the same access key as playing against the engine. The first two
// browsers at the table play each other; the server grades both, keeps the
// unfinished match to go on with later, and a history of the finished ones.

const express = require('express');
const { getFriendTable } = require('../friendMatch');
const { createFriendStore } = require('../friendStore');
const { matchToMat } = require('../matExport');
const { buildReview, friendMatchView } = require('../matchReview');
const localAnalysis = require('../localAnalysis');
const { database } = require('../storage');
const { log } = require('../log');
const { sendMatchError } = require('./errors');
const { requirePlayAccess } = require('./playAccess');

const router = express.Router();
const friendStore = createFriendStore(database);
getFriendTable().store = friendStore;

router.get('/friend/state', requirePlayAccess, (req, res) => {
    res.json(getFriendTable().state(req.playBrowser));
});

// POST /friend/join - take a seat at the table, or your own again under your name.
// Body: { name: string, takeOver?: boolean } (takeOver: from the browser now using that seat)
router.post('/friend/join', requirePlayAccess, (req, res) => {
    try {
        const state = getFriendTable().join(req.playBrowser, req.body?.name, { takeOver: req.body?.takeOver === true });
        log(`'${req.body?.name}' joined the friend table`);
        res.json(state);
    } catch (error) {
        sendMatchError(res, error);
    }
});

router.post('/friend/leave', requirePlayAccess, (req, res) => {
    try {
        res.json(getFriendTable().leave(req.playBrowser));
    } catch (error) {
        sendMatchError(res, error);
    }
});

// POST /friend/abort - end the running match for both players, without saving it
router.post('/friend/abort', requirePlayAccess, (req, res) => {
    try {
        const state = getFriendTable().abort(req.playBrowser);
        log(`friend match aborted by '${state.seats[state.you]?.name}'`);
        res.json(state);
    } catch (error) {
        sendMatchError(res, error);
    }
});

// POST /friend/length - choose the match length; it starts once both chose the same. Body: { length }
router.post('/friend/length', requirePlayAccess, async (req, res) => {
    try {
        res.json(await getFriendTable().chooseLength(req.playBrowser, Number(req.body?.length)));
    } catch (error) {
        sendMatchError(res, error);
    }
});

// POST /friend/action - Body: { type: 'roll'|'double'|'take'|'pass'|'move'|'next-game', key? }
router.post('/friend/action', requirePlayAccess, async (req, res) => {
    try {
        res.json(await getFriendTable().act(req.playBrowser, req.body || {}));
    } catch (error) {
        sendMatchError(res, error);
    }
});

// POST /friend/tentative - the checkers of the player on move so far, for the other player to watch.
// Body: { seq: number, points: number[], moved: number }
router.post('/friend/tentative', requirePlayAccess, (req, res) => {
    try {
        res.json(getFriendTable().tentative(req.playBrowser, req.body));
    } catch (error) {
        sendMatchError(res, error);
    }
});

// POST /friend/mark - Body: { id: string, marked: boolean }
router.post('/friend/mark', requirePlayAccess, (req, res) => {
    try {
        const { id, marked } = req.body || {};
        if (typeof id !== 'string') return res.status(400).json({ error: 'id (string) is required' });
        res.json(getFriendTable().mark(req.playBrowser, id, marked !== false));
    } catch (error) {
        sendMatchError(res, error);
    }
});

router.get('/friend/history', requirePlayAccess, (req, res) => {
    res.json({ matches: friendStore.listMatches(), analysis: localAnalysis.viewLimits() });
});

/** A finished friend match from one player's side: ?as=player2 is the second player, else the first. */
function friendMatchFor(req) {
    const match = friendStore.getMatch(req.params.id);
    if (!match?.games) return null;
    return { match, view: friendMatchView(match, req.query.as === 'player2' ? 'player2' : 'player1') };
}

// GET /friend/running/review - the match at the table as it stands, from your
// seat, as review steps: the decisions made so far (none that is still to be made)
router.get('/friend/running/review', requirePlayAccess, (req, res) => {
    const running = getFriendTable().runningReview(req.playBrowser);
    if (!running) return res.status(404).json({ error: 'no match is running' });
    const { record, you, yourTurn, finished } = running;
    const view = friendMatchView(record, you);
    res.json({
        match: {
            id: record.id, startedAt: record.startedAt, length: record.length, status: finished ? 'finished' : 'running',
            score: { you: view.you.score, engine: view.opponent.score }, pr: view.you.pr, opponentPr: view.opponent.pr
        },
        player: view.you.name,
        opponent: view.opponent.name,
        games: buildReview(view),
        analysis: localAnalysis.viewLimits(),
        running: !finished,
        yourTurn
    });
});

// GET /friend/history/:id/review - one match as review steps for stepping through it
router.get('/friend/history/:id/review', requirePlayAccess, (req, res) => {
    const found = friendMatchFor(req);
    if (!found) return res.status(404).json({ error: 'match not found' });
    const { match, view } = found;
    res.json({
        match: {
            id: match.id, startedAt: match.startedAt, length: match.length, status: 'finished',
            score: { you: view.you.score, engine: view.opponent.score }, pr: view.you.pr, opponentPr: view.opponent.pr
        },
        player: view.you.name,
        opponent: view.opponent.name,
        games: buildReview(view),
        analysis: localAnalysis.viewLimits()
    });
});

// GET /friend/history/:id/mat - one match as a .mat file for XG or gnubg
router.get('/friend/history/:id/mat', requirePlayAccess, (req, res) => {
    const found = friendMatchFor(req);
    if (!found) return res.status(404).json({ error: 'match not found' });
    const { match, view } = found;
    res.attachment(`secondroll-${match.startedAt.slice(0, 10)}-${match.length}pt-friendly.mat`);
    res.type('text/plain');
    res.send(matchToMat({ length: view.length, games: view.games, opponent: view.opponent.name }, view.you.name));
});

module.exports = router;
