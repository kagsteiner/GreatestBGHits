'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runGnuBgAnalysis = require('./gnubgRunner');
const { DEFAULT_MISTAKE_THRESHOLD } = require('./constants');
const BackgammonBoard = require('./board');
const BackgammonParser = require('../backgammon-parser');
const DailyGammonRetriever = require('../DailyGammonRetriever');
const userStorage = require('./storage');

// Debug flag for comprehensive logging in addQuizzesAndSave
const DEBUG_ADD_QUIZ = process.env.DEBUG_ADD_QUIZ === 'true' || process.env.DEBUG_ADD_QUIZ === '1';

function requireUserKey(username) {
    const key = userStorage.normalizeUsername(username);
    if (!key) {
        throw new Error('A username is required for this operation');
    }
    return key;
}

/**
 * Generate ASCII representation of a backgammon board.
 * @param {BackgammonBoard} board
 * @returns {string}
 */
function boardToAscii(board) {
    if (!board || !board.points) return '';
    const p1 = board.points.player1;
    const p2 = board.points.player2;

    const lines = [];
    lines.push('┌─────────────────────────────────────────────────────────────┐');

    // Top row: absolute points 13-24 (player1's outer board, player2's home board)
    // Player1 stores at absolute index, player2 stores mirrored (their point 1 = abs 24, their point 12 = abs 13)
    const topRow = [];
    for (let absPt = 13; absPt <= 24; absPt++) {
        const p1Count = p1[absPt] || 0;
        const p2Count = p2[absPt] || 0; // player2's point (25-absPt) is stored at absPt
        let cell = '';
        if (p1Count > 0 && p2Count > 0) {
            cell = `1:${p1Count},2:${p2Count}`.padEnd(8);
        } else if (p1Count > 0) {
            cell = `1:${p1Count}`.padEnd(8);
        } else if (p2Count > 0) {
            cell = `2:${p2Count}`.padEnd(8);
        } else {
            cell = '        ';
        }
        topRow.push(cell);
    }
    lines.push('│ ' + topRow.join(' ') + ' │');

    // Bar row
    const p1Bar = p1[25] || 0;
    const p2Bar = p2[25] || 0;
    const barStr = `Bar: P1=${p1Bar} P2=${p2Bar}`.padEnd(59);
    lines.push('│ ' + barStr + ' │');

    // Bottom row: absolute points 12-1 (player1's home board, player2's outer board)
    const bottomRow = [];
    for (let absPt = 12; absPt >= 1; absPt--) {
        const p1Count = p1[absPt] || 0;
        const p2Count = p2[absPt] || 0; // player2's point (25-absPt) is stored at absPt
        let cell = '';
        if (p1Count > 0 && p2Count > 0) {
            cell = `1:${p1Count},2:${p2Count}`.padEnd(8);
        } else if (p1Count > 0) {
            cell = `1:${p1Count}`.padEnd(8);
        } else if (p2Count > 0) {
            cell = `2:${p2Count}`.padEnd(8);
        } else {
            cell = '        ';
        }
        bottomRow.push(cell);
    }
    lines.push('│ ' + bottomRow.join(' ') + ' │');

    // Bear off
    const p1Off = p1[0] || 0;
    const p2Off = p2[0] || 0;
    const offStr = `Off: P1=${p1Off} P2=${p2Off}`.padEnd(59);
    lines.push('│ ' + offStr + ' │');

    lines.push('└─────────────────────────────────────────────────────────────┘');

    // Additional info
    const turnStr = `Turn: ${board.turn}`;
    const cubeStr = `Cube: ${board.cube}${board.cubeOwner ? ` (${board.cubeOwner})` : ''}`;
    const diceStr = board.dice ? `Dice: ${board.dice.die1},${board.dice.die2}` : 'Dice: not set';
    lines.push(`  ${turnStr} | ${cubeStr} | ${diceStr}`);

    return lines.join('\n');
}

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
 * Special handling for captures: 8/7*(2) expands to '8/7* 8/7' (only first captures).
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
    // If base ends with *, only first move should capture
    const hasAsterisk = base.endsWith('*');
    const baseWithoutAsterisk = hasAsterisk ? base.slice(0, -1) : base;
    for (let i = 0; i < count; i++) {
        // First move keeps asterisk if present, subsequent moves don't
        out.push(i === 0 && hasAsterisk ? base : baseWithoutAsterisk);
    }
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
 * @param {{ userName?: string, threshold?: number, dgGameId?: string, onPosition?: (p:any)=>Promise<void>|void }} [options]
 * @returns {Promise<{ engineAvailable: boolean, threshold: number, positions: Array<any> }>}
 */
async function buildGamePositions(matchJson, options = {}) {
    const threshold = typeof options.threshold === 'number' ? options.threshold : DEFAULT_MISTAKE_THRESHOLD;
    const onPosition = typeof options.onPosition === 'function' ? options.onPosition : null;
    const dgGameId = options.dgGameId || null;
    const positions = [];
    const games = Array.isArray(matchJson?.games) ? matchJson.games : (Array.isArray(matchJson?.moves) ? [matchJson] : []);

    // Try to resolve player names at match level; fall back to per-game.
    const matchLevelPlayers = matchJson && matchJson.players ? matchJson.players : null;

    // DailyGammon move number counter (cumulative across the entire match)
    // Counting rules:
    // 1. A checker move counts as 2 moves (rolling dice = 1, making the move = 1)
    // 2. Offering a double counts as 1 move
    // 3. Accepting/rejecting a double counts as 1 move
    // 4. Starting the next game of a match counts as 1 move
    // So first move is #2, opponent's first move is #4, etc.
    let dgMoveNumber = 0;

    for (let gameIdx = 0; gameIdx < games.length; gameIdx++) {
        const game = games[gameIdx];
        const moves = Array.isArray(game?.moves) ? game.moves : [];
        const gamePlayers = matchLevelPlayers || game.players || {};

        // Starting a new game counts as a move (except the first game)
        if (gameIdx > 0) {
            dgMoveNumber++;
        }

        // Construct board state incrementally through the game
        let board = BackgammonBoard.starting('player1');
        // Set match context if available
        if (Number.isFinite(matchJson?.matchLength)) board.matchLength = matchJson.matchLength;
        if (game?.startingScore && Number.isFinite(game.startingScore.player1) && Number.isFinite(game.startingScore.player2)) {
            board.score = { player1: game.startingScore.player1, player2: game.startingScore.player2 };
        }
        for (const moveRec of moves) {
            // Player 1 action
            if (moveRec?.player1) {
                const p1Type = moveRec.player1.type;
                if (p1Type === 'move') {
                    dgMoveNumber += 2; // Roll + move = 2 in DailyGammon's numbering
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
                        threshold,
                        onPosition,
                        dgGameId,
                        dgMoveNumber,
                        matchLength: matchJson?.matchLength,
                        opponent: gamePlayers.player2 || null
                    });
                    // Apply the actual move to advance board
                    board.applyMoveParts('player1', moveRec.player1.moves || []);
                } else if (p1Type === 'double') {
                    dgMoveNumber++; // Offering a double counts as a move
                } else if (p1Type === 'take' || p1Type === 'drop') {
                    dgMoveNumber++; // Accepting/rejecting a double counts as a move
                }
            }
            // Player 2 action
            if (moveRec?.player2) {
                const p2Type = moveRec.player2.type;
                if (p2Type === 'move') {
                    dgMoveNumber += 2; // Roll + move = 2 in DailyGammon's numbering
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
                        threshold,
                        onPosition,
                        dgGameId,
                        dgMoveNumber,
                        matchLength: matchJson?.matchLength,
                        opponent: gamePlayers.player1 || null
                    });
                    // Apply the actual move
                    board.applyMoveParts('player2', moveRec.player2.moves || []);
                } else if (p2Type === 'double') {
                    dgMoveNumber++; // Offering a double counts as a move
                } else if (p2Type === 'take' || p2Type === 'drop') {
                    dgMoveNumber++; // Accepting/rejecting a double counts as a move
                }
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
        threshold,
        onPosition,
        dgGameId,
        dgMoveNumber,
        matchLength,
        opponent
    } = ctx;

    // Filter user
    if (filterUserName && String(filterUserName).trim() && String(userName) !== String(filterUserName)) {
        return;
    }

    // Require a GNU ID to analyze the position
    if (!gnuId || typeof gnuId !== 'string' || !gnuId.includes(':')) {
        return;
    }

    // Debug logging: log position info before analysis
    if (DEBUG_ADD_QUIZ) {
        try {
            const board = BackgammonBoard.fromGnuId(gnuId);
            const diceStr = dice ? `${dice.die1},${dice.die2}` : 'not set';
            const playerName = userName || playerKey;

            console.log('\n' + '-'.repeat(80));
            console.log(`[DEBUG] Position Analysis:`);
            console.log(`[DEBUG]   GNU-ID: ${gnuId}`);
            console.log(`[DEBUG]   Player to play: ${playerName} (${playerKey})`);
            console.log(`[DEBUG]   Dice: ${diceStr}`);
            console.log(`[DEBUG]   Game: ${gameNumber}, Ply: ${plyIndex}`);
            console.log(`[DEBUG]   Board state:`);
            console.log(boardToAscii(board));
        } catch (e) {
            console.error(`[DEBUG] Error creating board from GNU-ID ${gnuId}:`, e.message);
        }
    }

    // Call the same analyzer used by server endpoint
    const analysis = await runGnuBgAnalysis({ matchId: gnuId, dice });
    const candidates = Array.isArray(analysis?.moves) ? analysis.moves : [];

    // Debug logging: log all possible moves and their equity
    if (DEBUG_ADD_QUIZ) {
        console.log(`[DEBUG]   All possible moves (${candidates.length} total):`);
        if (candidates.length === 0) {
            console.log(`[DEBUG]     WARNING: No moves returned from Gnu!`);
        } else {
            candidates.forEach((move, idx) => {
                const moveText = move.move || move.moveText || 'N/A';
                const equity = typeof move.equity === 'number' ? move.equity.toFixed(4) : (move.mwc !== undefined ? `MWC:${move.mwc.toFixed(4)}` : 'N/A');
                const rank = idx + 1;
                console.log(`[DEBUG]     ${rank}. ${moveText.padEnd(30)} Equity: ${equity}`);
            });
        }
        console.log('-'.repeat(80));
    }

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

    const positionObj = {
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
    };

    // Add match metadata
    if (Number.isFinite(matchLength)) {
        positionObj.matchLength = matchLength;
    }
    if (opponent) {
        positionObj.opponent = opponent;
    }

    // Add DailyGammon link info if available
    if (dgGameId && dgMoveNumber) {
        positionObj.dgGameId = dgGameId;
        positionObj.dgMoveNumber = dgMoveNumber;
    }

    positions.push(positionObj);

    // Notify per-position, if provided
    if (onPosition) {
        const last = positions[positions.length - 1];
        await onPosition(last);
    }
}

/**
 * Compute a stable quiz-position identifier based on deterministic context.
 * Uses GNU ID, player, gameNumber, plyIndex and user name.
 * @param {any} p
 * @returns {string}
 */
function computePositionId(p) {
    const key =
        String(p?.gnuId || '') +
        '|' +
        String(p?.context?.player || '') +
        '|' +
        String(p?.context?.gameNumber ?? '') +
        '|' +
        String(p?.context?.plyIndex ?? '') +
        '|' +
        String(p?.user?.name || '');
    const h = crypto.createHash('sha1').update(key).digest('hex');
    return h.slice(0, 16);
}

/**
 * Ensure quiz bookkeeping fields exist on a position.
 * Adds { id, quiz: { playCount, correctAnswers } } if missing.
 * @param {any} p
 * @returns {any}
 */
function ensureQuizFields(p) {
    if (!p) return p;
    if (!p.quiz || typeof p.quiz !== 'object') {
        p.quiz = { playCount: 0, correctAnswers: 0 };
    } else {
        const pc = Number.isFinite(p.quiz.playCount) ? p.quiz.playCount : 0;
        const ca = Number.isFinite(p.quiz.correctAnswers) ? p.quiz.correctAnswers : 0;
        p.quiz.playCount = pc;
        p.quiz.correctAnswers = ca;
    }
    if (!p.id) {
        p.id = computePositionId(p);
    }
    return p;
}

/**
 * Extract DailyGammon match id from an export URL.
 * Example: http://dailygammon.com/bg/export/5151240 -> "5151240"
 * @param {string} url
 * @returns {string|null}
 */
function extractMatchIdFromUrl(url) {
    if (typeof url !== 'string') return null;
    const m = url.match(/\/bg\/export\/([^/?#]+)/);
    return m ? m[1] : null;
}

/**
 * Load the set of analyzed match ids from storage.
 * @param {string} username
 * @returns {Promise<Set<string>>}
 */
async function loadAnalyzedMatches(username) {
    const userKey = requireUserKey(username);
    const payload = userStorage.readAnalyzedMatches(userKey);
    const arr = Array.isArray(payload?.matches) ? payload.matches : [];
    return new Set(arr.map((m) => String(m)));
}

/**
 * Persist the set of analyzed match ids to storage.
 * @param {string} username
 * @param {Set<string>} analyzed
 * @returns {Promise<void>}
 */
async function saveAnalyzedMatches(username, analyzed) {
    const userKey = requireUserKey(username);
    const out = { matches: Array.from(analyzed.values()).sort() };
    userStorage.writeAnalyzedMatches(userKey, out);
}

/**
 * Read quizzes JSON for the given user. Returns a normalized structure.
 * @param {string} username
 * @returns {Promise<{ engineAvailable: boolean, threshold: number, positions: any[] }>}
 */
async function loadQuizzes(username) {
    const userKey = requireUserKey(username);
    const payload = userStorage.readQuizzes(userKey);
    const positions = Array.isArray(payload?.positions) ? payload.positions : [];
    for (const pos of positions) ensureQuizFields(pos);
    const threshold =
        typeof payload?.threshold === 'number' ? payload.threshold : DEFAULT_MISTAKE_THRESHOLD;
    const engineAvailable =
        payload?.engineAvailable === undefined ? true : Boolean(payload.engineAvailable);
    return { engineAvailable, threshold, positions };
}

function mergeQuizzesPayload(existing, incoming) {
    const existingPositions = Array.isArray(existing?.positions) ? existing.positions : [];
    const incomingPositions = Array.isArray(incoming?.positions) ? incoming.positions : [];
    const byId = new Map();

    for (const original of existingPositions) {
        const p = ensureQuizFields({ ...original });
        if (p?.id) byId.set(p.id, p);
    }
    for (const original of incomingPositions) {
        const p = ensureQuizFields({ ...original });
        if (!p?.id) continue;
        if (!byId.has(p.id)) {
            byId.set(p.id, p);
        } else {
            const existingEntry = byId.get(p.id);
            existingEntry.quiz.playCount = Math.max(
                Number(existingEntry.quiz.playCount) || 0,
                Number(p.quiz.playCount) || 0
            );
            existingEntry.quiz.correctAnswers = Math.max(
                Number(existingEntry.quiz.correctAnswers) || 0,
                Number(p.quiz.correctAnswers) || 0
            );
            if (existingEntry.quiz.correctAnswers > existingEntry.quiz.playCount) {
                existingEntry.quiz.correctAnswers = existingEntry.quiz.playCount;
            }
        }
    }

    const merged = {
        engineAvailable:
            incoming?.engineAvailable !== undefined
                ? Boolean(incoming.engineAvailable)
                : (existing?.engineAvailable === undefined
                    ? true
                    : Boolean(existing.engineAvailable)),
        threshold:
            typeof incoming?.threshold === 'number'
                ? incoming.threshold
                : (typeof existing?.threshold === 'number'
                    ? existing.threshold
                    : DEFAULT_MISTAKE_THRESHOLD),
        positions: Array.from(byId.values())
    };
    return merged;
}

/**
 * Persist quizzes for the given user, merging with existing records to avoid overwriting
 * concurrent updates.
 * @param {string} username
 * @param {{ engineAvailable?: boolean, threshold?: number, positions: any[] }} quizzes
 * @returns {Promise<{ engineAvailable: boolean, threshold: number, positions: any[] }>}
 */
async function saveQuizzes(username, quizzes) {
    const userKey = requireUserKey(username);
    const existing = userStorage.readQuizzes(userKey);
    const merged = mergeQuizzesPayload(existing, quizzes);
    userStorage.writeQuizzes(userKey, merged);
    return merged;
}

/**
 * Increment quiz statistics atomically for the given quiz id.
 * @param {string} username
 * @param {string} id
 * @param {boolean} wasCorrect
 * @returns {Promise<any|null>}
 */
async function recordQuizResult(username, id, wasCorrect) {
    const userKey = requireUserKey(username);
    if (!id) return null;
    let targetId = null;
    const updated = userStorage.updateUserData(userKey, ({ quizzes, analyzedMatches }) => {
        const positions = Array.isArray(quizzes.positions) ? quizzes.positions : [];
        const idx = positions.findIndex((p) => p && p.id === id);
        if (idx < 0) {
            return { quizzes, analyzedMatches };
        }
        const record = ensureQuizFields(positions[idx]);
        record.quiz.playCount = (Number(record.quiz.playCount) || 0) + 1;
        if (wasCorrect) {
            record.quiz.correctAnswers = (Number(record.quiz.correctAnswers) || 0) + 1;
            if (record.quiz.correctAnswers > record.quiz.playCount) {
                record.quiz.correctAnswers = record.quiz.playCount;
            }
        }
        positions[idx] = record;
        targetId = id;
        return {
            quizzes: { ...quizzes, positions },
            analyzedMatches
        };
    });
    if (!targetId) return null;
    const savedPositions = Array.isArray(updated?.quizzes?.positions) ? updated.quizzes.positions : [];
    return savedPositions.find((p) => p && p.id === id) || null;
}

/**
 * Pick the next quiz by maximizing importance:
 * importance = equityDiff / (1 + correctAnswers² × 10 + playCount × 2)
 * 
 * This formula ensures:
 * - Solving a quiz heavily reduces its priority (exponential penalty)
 * - Just seeing a quiz (even without solving) moderately reduces priority
 * - Unsolved quizzes won't keep appearing repeatedly
 * 
 * @returns {Promise<any|null>}
 */
async function getNextQuiz(username, playerFilter = null, matchFilter = null) {
    const data = await loadQuizzes(username);
    let positions = data.positions || [];

    // Filter by player if specified
    if (playerFilter && playerFilter.trim()) {
        positions = positions.filter(p => {
            const playerName = p?.user?.name;
            return playerName === playerFilter.trim();
        });
    }

    // Filter by match if specified
    if (matchFilter && matchFilter.trim()) {
        positions = positions.filter(p => p?.dgGameId === matchFilter.trim());
    }

    if (!positions.length) return null;

    let best = null;
    let bestScore = -Infinity;
    for (const p of positions) {
        const equityLoss = Number(p?.context?.equityDiff) || 0;
        const correctAnswers = Number(p?.quiz?.correctAnswers) || 0;
        const playCount = Number(p?.quiz?.playCount) || 0;

        // Exponential penalty for solved quizzes, linear penalty for seen quizzes
        const denom = 1 + (correctAnswers * correctAnswers * 10) + (playCount * 2);
        const score = equityLoss / denom;

        if (score > bestScore) {
            bestScore = score;
            best = p;
        }
    }
    return best || null;
}

/**
 * Get a quiz by its ID.
 * @param {string} id - The quiz ID to look up
 * @returns {Promise<any|null>}
 */
async function getQuizById(username, id) {
    if (!id || typeof id !== 'string') return null;
    const data = await loadQuizzes(username);
    const positions = data.positions || [];
    return positions.find((p) => p && p.id === id) || null;
}

/**
 * Get a quiz by its ID from ANY user (for debugging purposes).
 * Searches across all users' quizzes.
 * @param {string} id - The quiz ID to look up
 * @returns {Promise<any|null>}
 */
async function getAnyQuizById(id) {
    if (!id || typeof id !== 'string') return null;
    return userStorage.getQuizByIdFromAllUsers(id);
}

/**
 * Get all unique player names from quizzes.
 * @returns {Promise<string[]>}
 */
async function getAllPlayers(username) {
    const data = await loadQuizzes(username);
    const positions = data.positions || [];
    const players = new Set();
    for (const p of positions) {
        const playerName = p?.user?.name;
        if (playerName && typeof playerName === 'string') {
            players.add(playerName);
        }
    }
    return Array.from(players).sort();
}

/**
 * Get all unique matches from quizzes with metadata.
 * Groups positions by dgGameId and extracts matchLength and opponent.
 * The opponent is determined as the player who is NOT currentUsername.
 * For legacy positions without matchLength, decodes it from gnuId.
 * For legacy positions without opponent, uses "?".
 * @param {string} storageKey
 * @param {string} [currentUsername] - The logged-in user's name, used to identify the opponent
 * @returns {Promise<Array<{ matchId: string, matchLength: number|null, opponent: string, positionCount: number }>>}
 */
async function getAllMatches(storageKey, currentUsername) {
    const data = await loadQuizzes(storageKey);
    const positions = data.positions || [];
    const matchMap = new Map();

    for (const p of positions) {
        const matchId = p?.dgGameId;
        if (!matchId) continue;

        if (!matchMap.has(matchId)) {
            matchMap.set(matchId, {
                matchId,
                matchLength: null,
                playerNames: new Set(),
                positionCount: 0
            });
        }

        const entry = matchMap.get(matchId);
        entry.positionCount++;

        // Collect all player names from both user.name and opponent fields
        if (p.user?.name && typeof p.user.name === 'string') {
            entry.playerNames.add(p.user.name);
        }
        if (p.opponent && typeof p.opponent === 'string') {
            entry.playerNames.add(p.opponent);
        }

        // Determine matchLength: prefer stored field, fall back to gnuId decode
        if (entry.matchLength === null) {
            if (Number.isFinite(p.matchLength)) {
                entry.matchLength = p.matchLength;
            } else if (p.gnuId && typeof p.gnuId === 'string' && p.gnuId.includes(':')) {
                try {
                    const board = BackgammonBoard.fromGnuId(p.gnuId);
                    if (Number.isFinite(board.matchLength)) {
                        entry.matchLength = board.matchLength;
                    }
                } catch {
                    // ignore decode errors
                }
            }
        }
    }

    // Resolve opponent: the player name that is NOT the current user
    const results = [];
    for (const entry of matchMap.values()) {
        let opponent = '?';
        if (currentUsername && entry.playerNames.size > 0) {
            const others = [...entry.playerNames].filter(n => n !== currentUsername);
            if (others.length > 0) {
                opponent = others[0];
            } else if (entry.playerNames.size === 1) {
                // All positions are from the same player; opponent unknown
                opponent = '?';
            }
        } else if (entry.playerNames.size > 0) {
            // No currentUsername provided; pick the first name as a fallback
            opponent = [...entry.playerNames][0];
        }
        results.push({
            matchId: entry.matchId,
            matchLength: entry.matchLength,
            opponent,
            positionCount: entry.positionCount
        });
    }

    // Sort by matchId descending (numeric sort)
    results.sort((a, b) => {
        const aNum = Number(a.matchId) || 0;
        const bNum = Number(b.matchId) || 0;
        return bNum - aNum;
    });
    return results;
}

/**
 * Connect to DailyGammon, retrieve last matches, analyze and append quiz positions.
 * Writes update file and saves merged quizzes to persistent storage.
 * Supports optional progress callback for UI.
 * @param {{
 *  username?: string,
 *  storageKey?: string,
 *  dgCredentials?: { username?: string, password?: string, userId?: string },
 *  days?: number,
 *  onProgress?: (p: any) => void
 * }} [options]
 * @returns {Promise<{ added: number, total: number, matchesTotal: number }>}
 */
async function addQuizzesAndSave(options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const storageUsername = options.username || options.storageKey;
    const userKey = requireUserKey(storageUsername);

    const credOptions = options.dgCredentials || {};
    const dgUsername = credOptions.username;
    const dgPassword = credOptions.password;
    let dgUserId = credOptions.userId || null;

    if (!dgUsername || !dgPassword) {
        throw new Error('DailyGammon credentials are required to crawl matches');
    }

    const days =
        options.days !== undefined && options.days !== null
            ? parseInt(String(options.days), 10)
            : (parseInt(process.env.DG_DAYS, 10) || 30);

    // Prepare quizzes
    const quizzes = await loadQuizzes(userKey);
    const seenIds = new Set();
    for (const p of quizzes.positions) {
        ensureQuizFields(p);
        if (p.id) seenIds.add(p.id);
    }

    // Prepare analyzed matches tracker
    const analyzedMatches = await loadAnalyzedMatches(userKey);

    // Step 1: Retrieve finished matches metadata (to know total count early)
    if (onProgress) onProgress({ phase: 'login_and_list' });
    const retriever = new DailyGammonRetriever();
    const dgOptions = onProgress ? { onProgress } : {};
    const exportLinks = await retriever.getFinishedMatches(dgUsername, dgPassword, days, dgUserId, dgOptions);
    const allFullUrls = retriever.getFullExportUrls(exportLinks);
    // Filter out matches we already analyzed
    const fullUrls = allFullUrls.filter((url) => {
        const id = extractMatchIdFromUrl(url);
        return id && !analyzedMatches.has(id);
    });
    const matchesTotal = fullUrls.length;

    if (onProgress) onProgress({ phase: 'found_links', matchesTotal, processedMatches: 0, quizzesAdded: 0 });

    // Step 2: Parse matches one by one, analyze, accumulate progress
    const parser = new BackgammonParser();
    let processedMatches = 0;
    let addedCount = 0;
    const parsedMatchesOut = [];

    for (const url of fullUrls) {
        // Parse single match
        let matchRec;
        try {
            const parsed = await parser.downloadAndParseMatch(url, retriever.session);
            matchRec = { url, match: parsed, parseDate: new Date().toISOString() };

            if (DEBUG_ADD_QUIZ) {
                const matchId = extractMatchIdFromUrl(url);
                const player1Name = parsed?.players?.player1 || parsed?.games?.[0]?.players?.player1 || 'player1';
                const player2Name = parsed?.players?.player2 || parsed?.games?.[0]?.players?.player2 || 'player2';
                console.log('\n' + '='.repeat(80));
                console.log(`[DEBUG] Starting analysis of match: ${matchId || url}`);
                console.log(`[DEBUG] Players: ${player1Name} vs ${player2Name}`);
                console.log(`[DEBUG] Match URL: ${url}`);
                console.log('='.repeat(80));
            }
        } catch (e) {
            matchRec = { url, error: e.message, parseDate: new Date().toISOString() };
            if (DEBUG_ADD_QUIZ) {
                console.error(`[DEBUG] Error parsing match ${url}:`, e.message);
            }
        }
        parsedMatchesOut.push(matchRec);

        // Report Nackgammon matches to the user
        if (matchRec.error && matchRec.error.includes('Nackgammon')) {
            if (onProgress) {
                onProgress({
                    phase: 'nackgammon_skipped',
                    matchesTotal,
                    processedMatches,
                    quizzesAdded: addedCount,
                    message: `Skipped Nackgammon match: ${extractMatchIdFromUrl(url) || url}`
                });
            }
        }

        // Analyze and append
        if (!matchRec.error && matchRec.match) {
            const matchId = extractMatchIdFromUrl(url);
            await buildGamePositions(matchRec.match, {
                threshold: quizzes.threshold,
                dgGameId: matchId || null,
                onPosition: async (pos) => {
                    ensureQuizFields(pos);
                    if (!pos.id) return;
                    if (seenIds.has(pos.id)) {
                        // already present; don't re-add
                        return;
                    }
                    quizzes.positions.push(pos);
                    seenIds.add(pos.id);
                    addedCount += 1;
                    // Frequent save as requested
                    await saveQuizzes(userKey, quizzes);
                    if (onProgress) {
                        onProgress({
                            phase: 'processing',
                            matchesTotal,
                            processedMatches,
                            quizzesAdded: addedCount,
                            lastPositionId: pos.id
                        });
                    }
                }
            });
            // Mark match as analyzed and persist immediately
            if (matchId) {
                analyzedMatches.add(String(matchId));
                await saveAnalyzedMatches(userKey, analyzedMatches);
            }
        }

        processedMatches += 1;
        if (onProgress) {
            onProgress({
                phase: 'processing',
                matchesTotal,
                processedMatches,
                quizzesAdded: addedCount
            });
        }
    }

    // Step 3: Persist update.json like the previous behavior expected
    try {
        await fs.promises.writeFile(
            path.resolve(__dirname, '..', 'update.json'),
            JSON.stringify(parsedMatchesOut, null, 2),
            'utf8'
        );
    } catch (_) {
        // best-effort; ignore file errors
    }

    // Step 4: Save merged quizzes
    await saveQuizzes(userKey, quizzes);

    if (onProgress) {
        onProgress({
            phase: 'done',
            matchesTotal,
            processedMatches,
            quizzesAdded: addedCount,
            totalQuizzes: quizzes.positions.length
        });
    }

    return { added: addedCount, total: quizzes.positions.length, matchesTotal };
}

/**
 * Remove quizzes that come from Nackgammon matches.
 * For each quiz with a dgGameId, fetches the match from DailyGammon and checks for "Illegal play".
 * Returns progress via callback and final stats.
 * @param {{
 *  username?: string,
 *  storageKey?: string,
 *  dgCredentials?: { username?: string, password?: string },
 *  onProgress?: (p: any) => void
 * }} [options]
 * @returns {Promise<{ removed: number, total: number, checkedMatches: number }>}
 */
async function removeNackgammonQuizzes(options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const storageUsername = options.username || options.storageKey;
    const userKey = requireUserKey(storageUsername);

    const credOptions = options.dgCredentials || {};
    const dgUsername = credOptions.username;
    const dgPassword = credOptions.password;

    if (!dgUsername || !dgPassword) {
        throw new Error('DailyGammon credentials are required to check for Nackgammon matches');
    }

    // Load quizzes
    const quizzes = await loadQuizzes(userKey);
    const positions = quizzes.positions || [];
    const originalCount = positions.length;

    if (onProgress) {
        onProgress({ phase: 'loading', totalQuizzes: originalCount });
    }

    // Group quizzes by dgGameId
    const quizzesByGameId = new Map();
    for (const pos of positions) {
        if (pos.dgGameId) {
            if (!quizzesByGameId.has(pos.dgGameId)) {
                quizzesByGameId.set(pos.dgGameId, []);
            }
            quizzesByGameId.get(pos.dgGameId).push(pos.id);
        }
    }

    const uniqueGameIds = Array.from(quizzesByGameId.keys());
    const totalMatches = uniqueGameIds.length;

    if (onProgress) {
        onProgress({ phase: 'found_matches', totalQuizzes: originalCount, matchesToCheck: totalMatches });
    }

    if (totalMatches === 0) {
        return { removed: 0, total: originalCount, checkedMatches: 0 };
    }

    // Login to DailyGammon
    const retriever = new DailyGammonRetriever();
    const dgOptions = onProgress ? { onProgress } : {};
    const loginSuccess = await retriever.login(dgUsername, dgPassword, dgOptions);
    if (!loginSuccess) {
        throw new Error('Failed to login to DailyGammon');
    }

    // Check each unique game for Nackgammon
    const nackgammonGameIds = new Set();
    let checkedMatches = 0;

    for (const gameId of uniqueGameIds) {
        try {
            const exportUrl = `http://dailygammon.com/bg/export/${gameId}`;
            const response = await retriever.session.get(exportUrl);
            const fileContent = response.data;

            if (typeof fileContent === 'string' && fileContent.includes('Illegal play')) {
                nackgammonGameIds.add(gameId);
                if (onProgress) {
                    onProgress({
                        phase: 'checking',
                        checkedMatches: checkedMatches + 1,
                        matchesToCheck: totalMatches,
                        message: `Found Nackgammon match: ${gameId}`
                    });
                }
            }
        } catch (error) {
            // If we can't fetch a match, skip it
            console.error(`Error checking match ${gameId}:`, error.message);
        }

        checkedMatches++;
        if (onProgress && !nackgammonGameIds.has(gameId)) {
            onProgress({
                phase: 'checking',
                checkedMatches,
                matchesToCheck: totalMatches
            });
        }
    }

    // Remove quizzes from Nackgammon matches
    const quizIdsToRemove = new Set();
    for (const gameId of nackgammonGameIds) {
        const quizIds = quizzesByGameId.get(gameId) || [];
        for (const id of quizIds) {
            quizIdsToRemove.add(id);
        }
    }

    if (quizIdsToRemove.size === 0) {
        if (onProgress) {
            onProgress({ phase: 'done', removed: 0, total: originalCount, checkedMatches });
        }
        return { removed: 0, total: originalCount, checkedMatches };
    }

    // Filter out the Nackgammon quizzes
    const filteredPositions = positions.filter(pos => !quizIdsToRemove.has(pos.id));
    quizzes.positions = filteredPositions;

    // Save updated quizzes
    await saveQuizzes(userKey, quizzes);

    const removedCount = quizIdsToRemove.size;

    if (onProgress) {
        onProgress({
            phase: 'done',
            removed: removedCount,
            total: filteredPositions.length,
            checkedMatches,
            nackgammonMatches: nackgammonGameIds.size
        });
    }

    return { removed: removedCount, total: filteredPositions.length, checkedMatches };
}

module.exports = {
    buildGamePositions,
    normalizeMoveText,
    parseBoardIdToGnuId,
    loadQuizzes,
    getNextQuiz,
    getQuizById,
    getAnyQuizById,
    getAllPlayers,
    getAllMatches,
    addQuizzesAndSave,
    recordQuizResult,
    removeNackgammonQuizzes
};



