'use strict';

const crypto = require('crypto');
const runGnuBgAnalysis = require('./gnubgRunner');
const { DEFAULT_MISTAKE_THRESHOLD } = require('./constants');
const BackgammonBoard = require('./board');

/**
 * Normalize a move string by collapsing whitespace.
 * @param {string} s
 */
function normalizeMoveText(s) {
    return typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '';
}

/**
 * Convert a single token to GNUBG CLI notation (bar/off, keep '*').
 * @param {string} token
 */
function convertTokenForGnuBg(token) {
    if (!token) return token;
    let hit = '';
    if (token.endsWith('*')) {
        hit = '*';
        token = token.slice(0, -1);
    }
    if (!token.includes('/')) return token + hit;
    let [fromPt, toPt] = token.split('/');
    if (fromPt === '25') fromPt = 'bar';
    if (toPt === '0') toPt = 'off';
    return `${fromPt}/${toPt}${hit}`;
}

/**
 * Convert a full move string (space-separated tokens) to GNUBG CLI notation.
 * @param {string} moveText
 */
function convertMoveForGnuBg(moveText) {
    const tokens = (moveText || '').split(' ').filter(Boolean);
    return tokens.map(convertTokenForGnuBg).join(' ');
}

/**
 * Expand shorthand counts like X/Y(n) into n copies of X/Y.
 * @param {string} token
 * @returns {string[]}
 */
function expandCountsToken(token) {
    if (typeof token !== 'string' || !token) return [];
    const m = token.match(/^([^()\s]+)\((\d+)\)$/);
    if (!m) return [token];
    const base = m[1];
    const count = Number(m[2]);
    const out = [];
    for (let i = 0; i < count; i++) out.push(base);
    return out;
}

/**
 * Convert a move string into an expanded array of CLI tokens with counts expanded
 * and bar/off normalized.
 * @param {string} moveText
 * @returns {string[]}
 */
function getExpandedCliTokens(moveText) {
    if (typeof moveText !== 'string' || !moveText.trim()) return [];
    const rawTokens = moveText.trim().split(/\s+/);
    const expanded = [];
    for (const t of rawTokens) {
        const parts = expandCountsToken(t);
        for (const p of parts) {
            expanded.push(convertTokenForGnuBg(p));
        }
    }
    return expanded;
}

/**
 * Represent a move as an order-insensitive multiset of tokens for matching.
 * @param {string} moveText
 * @returns {string[]}
 */
function moveToTokenMultiset(moveText) {
    if (!moveText) return [];
    const tokens = getExpandedCliTokens(moveText);
    tokens.sort(); // order-insensitive
    return tokens;
}

/**
 * Extract positionId and matchId from a GNUBG 'board id' output and return
 * combined GNU ID in the form positionId:matchId. Returns null if not found.
 * @param {string} boardIdText
 * @returns {string|null}
 */
function parseBoardIdToGnuId(boardIdText) {
    if (typeof boardIdText !== 'string' || !boardIdText.trim()) return null;
    const posMatch = boardIdText.match(/Position\s*ID\s*:\s*([A-Za-z0-9+/=]+)/i);
    const matchMatch = boardIdText.match(/Match\s*ID\s*:\s*([A-Za-z0-9+/=]+)/i);
    if (!posMatch || !matchMatch) return null;
    const posId = posMatch[1].trim();
    const matchId = matchMatch[1].trim();
    if (!posId || !matchId) return null;
    return `${posId}:${matchId}`;
}

/**
 * Choose one index uniformly from [start, end] inclusive. Returns null if invalid.
 */
function chooseIndex(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    const span = end - start + 1;
    const rnd = crypto.randomInt(0, span); // cryptographically strong selection
    return start + rnd;
}

/**
 * Join move parts (from parsed DG move) into space-separated tokens like '13/7 8/7'.
 * @param {Array<{from:number,to:number,hit?:boolean}>} parts
 * @returns {string}
 */
function joinMoveParts(parts) {
    if (!Array.isArray(parts) || !parts.length) return '';
    return parts
        .map((p) => {
            if (!p || typeof p.from !== 'number' || typeof p.to !== 'number') return null;
            const hit = p.hit ? '*' : '';
            return `${p.from}/${p.to}${hit}`;
        })
        .filter(Boolean)
        .join(' ');
}

/**
 * Build "game positions" by constructing the board at each ply, generating a
 * GNU Position ID, and invoking the per-position analyzer (same logic as the
 * server's analyzePositionFromMatch endpoint). No pre-supplied GNU IDs needed.
 *
 * @param {object} matchJson Full match object or single game object
 * @param {{ userName?: string, threshold?: number }} [options]
 * @returns {Promise<{ engineAvailable: boolean, threshold: number, positions: Array<any> }>}
 */
async function buildGamePositions(matchJson, options = {}) {
    const threshold = typeof options.threshold === 'number' ? options.threshold : DEFAULT_MISTAKE_THRESHOLD;
    const positions = [];
    const games = Array.isArray(matchJson?.games) ? matchJson.games : (Array.isArray(matchJson?.moves) ? [matchJson] : []);

    // Try to resolve player names at match level; fall back to per-game.
    const matchLevelPlayers = matchJson && matchJson.players ? matchJson.players : null;

    for (const game of games) {
        const moves = Array.isArray(game?.moves) ? game.moves : [];
        const gamePlayers = matchLevelPlayers || game.players || {};

        // Construct board state incrementally through the game
        let board = BackgammonBoard.starting('player1');
        // Set match context if available
        if (Number.isFinite(matchJson?.matchLength)) board.matchLength = matchJson.matchLength;
        if (game?.startingScore && Number.isFinite(game.startingScore.player1) && Number.isFinite(game.startingScore.player2)) {
            board.score = { player1: game.startingScore.player1, player2: game.startingScore.player2 };
        }
        for (const moveRec of moves) {
            // Player 1 move analysis on pre-move board
            if (moveRec?.player1?.type === 'move') {
                board.turn = 'player1';
                board.dice = moveRec.player1.dice || null;
                const gnuId = board.toGnuId();
                await analyzeAndCollect({
                    gnuId,
                    dice: moveRec.player1.dice || null,
                    userName: gamePlayers.player1 || 'player1',
                    filterUserName: options.userName,
                    userMoveParts: moveRec.player1.moves || [],
                    gameNumber: game.gameNumber,
                    plyIndex: moveRec.moveNumber,
                    playerKey: 'player1',
                    positions,
                    threshold
                });
                // Apply the actual move to advance board
                board.applyMoveParts('player1', moveRec.player1.moves || []);
            }
            // Player 2 move analysis on pre-move board
            if (moveRec?.player2?.type === 'move') {
                board.turn = 'player2';
                board.dice = moveRec.player2.dice || null;
                const gnuId = board.toGnuId();
                await analyzeAndCollect({
                    gnuId,
                    dice: moveRec.player2.dice || null,
                    userName: gamePlayers.player2 || 'player2',
                    filterUserName: options.userName,
                    userMoveParts: moveRec.player2.moves || [],
                    gameNumber: game.gameNumber,
                    plyIndex: moveRec.moveNumber,
                    playerKey: 'player2',
                    positions,
                    threshold
                });
                // Apply the actual move
                board.applyMoveParts('player2', moveRec.player2.moves || []);
            }
        }
    }

    // Sort positions by equity difference desc
    positions.sort((a, b) => (b?.context?.equityDiff || 0) - (a?.context?.equityDiff || 0));

    return { engineAvailable: true, threshold, positions };
}

async function analyzeAndCollect(ctx) {
    const {
        gnuId,
        dice,
        userName,
        filterUserName,
        userMoveParts,
        gameNumber,
        plyIndex,
        playerKey,
        positions,
        threshold
    } = ctx;

    // Filter user
    if (filterUserName && String(filterUserName).trim() && String(userName) !== String(filterUserName)) {
        return;
    }

    // Require a GNU ID to analyze the position
    if (!gnuId || typeof gnuId !== 'string' || !gnuId.includes(':')) {
        return;
    }

    // Call the same analyzer used by server endpoint
    const analysis = await runGnuBgAnalysis({ matchId: gnuId, dice });
    const candidates = Array.isArray(analysis?.moves) ? analysis.moves : [];
    if (!candidates.length) return;

    // Build user move text and compare to candidates
    const userMoveText = joinMoveParts(userMoveParts);
    const userMoveCli = normalizeMoveText(convertMoveForGnuBg(userMoveText));
    const userTokens = moveToTokenMultiset(userMoveCli);

    const best = candidates[0];
    let userRankIdx = -1;
    let userEquity = null;
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const cTokens = moveToTokenMultiset(normalizeMoveText(c.move || c.moveText || ''));
        if (cTokens.length === userTokens.length && cTokens.every((t, idx) => t === userTokens[idx])) {
            userRankIdx = i;
            userEquity = typeof c.equity === 'number' ? c.equity : null;
            break;
        }
    }

    if (typeof best?.equity !== 'number' || userEquity === null) return;
    const equityDiff = best.equity - userEquity;
    if (!(equityDiff >= threshold)) return;

    // Higher-ranked sample
    let higherSample = null;
    if (userRankIdx > 0) {
        let pickIdx;
        if (userRankIdx === 1) {
            pickIdx = 2 < candidates.length ? 2 : 0;
        } else {
            const chosen = chooseIndex(0, userRankIdx - 1);
            pickIdx = chosen === null ? 0 : chosen;
        }
        higherSample = candidates[pickIdx] || null;
    }

    // Lower-ranked sample
    let lowerSample = null;
    if (userRankIdx >= 0 && userRankIdx + 1 < candidates.length) {
        const start = userRankIdx + 1;
        const end = Math.min(userRankIdx + 2, candidates.length - 1);
        const idx = chooseIndex(start, end);
        lowerSample = typeof idx === 'number' ? (candidates[idx] || null) : null;
    }

    positions.push({
        type: 'move',
        gnuId,
        best: best ? { move: best.move, equity: best.equity } : null,
        user: {
            name: userName,
            move: userMoveCli,
            equity: userEquity,
            rank: userRankIdx >= 0 ? userRankIdx + 1 : null
        },
        higherSample: higherSample ? { move: higherSample.move, equity: higherSample.equity } : null,
        lowerSample: lowerSample ? { move: lowerSample.move, equity: lowerSample.equity } : null,
        context: { gameNumber, plyIndex, player: playerKey, dice, equityDiff }
    });
}

module.exports = {
    buildGamePositions,
    normalizeMoveText,
    parseBoardIdToGnuId
};



