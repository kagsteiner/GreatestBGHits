'use strict';

// Who may play (not linked anywhere).
// Only enabled when PLAY_ACCESS_KEY is set, and only for requests that send
// that key in the X-Play-Key header. No DailyGammon account is needed: each
// browser identifies itself with a random id (X-Play-Player), which keeps its
// match apart from other players' matches. Players may register a play
// account (X-Play-Session) to keep a history of their matches; their match
// then follows the account from device to device.

const crypto = require('crypto');
const { createPlayStore } = require('../playStore');
const { getPlayMatches } = require('../playMatch');
const { database } = require('../storage');

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

module.exports = { playStore, requirePlayAccess, requirePlayUser };
