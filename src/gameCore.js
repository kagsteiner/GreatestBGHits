'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const analyzePosition = require('./engines/analysisEngine');
const { DEFAULT_MISTAKE_THRESHOLD } = require('./constants');
const BackgammonBoard = require('./board');
const BackgammonParser = require('../backgammon-parser');
const DailyGammonRetriever = require('../DailyGammonRetriever');
const userStorage = require('./storage');
const { applyHedgehogAnalysis } = require('./quizAnalysis');

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
 * Build quiz positions by constructing the board at each ply and invoking the
 * Hedgehog analyzer with the native OGID.
 *
 * @param {object} matchJson Full match object or single game object
 * @param {{ userName?: string, threshold?: number, dgGameId?: string, onPosition?: (p:any)=>Promise<void>|void }} [options]
 * @returns {Promise<{ threshold: number, positions: Array<any> }>}
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

        const variant = (game?.variant || matchJson?.variant) === 'nackgammon'
            ? 'nackgammon'
            : 'backgammon';

        // Construct board state incrementally through the game
        let board = variant === 'nackgammon'
            ? BackgammonBoard.startingNackgammon('player1')
            : BackgammonBoard.starting('player1');
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
                    const ogid = board.toOgid();
                    await analyzeAndCollect({
                        ogid,
                        board,
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
                        opponent: gamePlayers.player2 || null,
                        variant
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
                    const ogid = board.toOgid();
                    await analyzeAndCollect({
                        ogid,
                        board,
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
                        opponent: gamePlayers.player1 || null,
                        variant
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

    return { threshold, positions };
}

async function analyzeAndCollect(ctx) {
    const {
        ogid,
        board,
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
        opponent,
        variant
    } = ctx;

    // Filter user
    if (filterUserName && String(filterUserName).trim() && String(userName) !== String(filterUserName)) {
        return;
    }

    if (!ogid || typeof ogid !== 'string') {
        throw new Error('Cannot analyze a position without OGID');
    }

    // Debug logging: log position info before analysis
    if (DEBUG_ADD_QUIZ) {
        try {
            const diceStr = dice ? `${dice.die1},${dice.die2}` : 'not set';
            const playerName = userName || playerKey;

            console.log('\n' + '-'.repeat(80));
            console.log(`[DEBUG] Position Analysis:`);
            console.log(`[DEBUG]   OGID: ${ogid}`);
            console.log(`[DEBUG]   Player to play: ${playerName} (${playerKey})`);
            console.log(`[DEBUG]   Dice: ${diceStr}`);
            console.log(`[DEBUG]   Game: ${gameNumber}, Ply: ${plyIndex}`);
            console.log(`[DEBUG]   Board state:`);
            console.log(boardToAscii(board));
        } catch (e) {
            console.error(`[DEBUG] Error rendering OGID ${ogid}:`, e.message);
        }
    }

    const analysis = await analyzePosition({ ogid, dice, positionIndex: plyIndex });
    const candidates = Array.isArray(analysis?.moves) ? analysis.moves : [];
    if (!candidates.length) {
        throw new Error(`Hedgehog returned no candidate moves for ${ogid}`);
    }

    // Debug logging: log all possible moves and their equity
    if (DEBUG_ADD_QUIZ) {
        console.log(`[DEBUG]   All possible moves (${candidates.length} total):`);
        candidates.forEach((move, idx) => {
            const moveText = move.move || 'N/A';
            const equity = typeof move.equity === 'number' ? move.equity.toFixed(4) : 'N/A';
            const rank = idx + 1;
            console.log(`[DEBUG]     ${rank}. ${moveText.padEnd(30)} Equity: ${equity}`);
        });
        console.log('-'.repeat(80));
    }

    // Build user move text and compare to candidates
    const userMoveText = joinMoveParts(userMoveParts);
    const normalizedUserMove = normalizeMoveText(userMoveText);
    let positionObj = applyHedgehogAnalysis({
        type: 'move',
        ogid,
        user: {
            name: userName,
            move: normalizedUserMove
        },
        context: { gameNumber, plyIndex, player: playerKey, dice },
        variant: variant === 'nackgammon' ? 'nackgammon' : 'backgammon'
    }, analysis, { threshold });
    if (!positionObj.active) return;

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
 * Uses OGID, player, gameNumber, plyIndex and user name.
 * @param {any} p
 * @returns {string}
 */
function computeQuizId(p) {
    const key =
        String(p?.ogid || '') +
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
        p.id = computeQuizId(p);
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
 * @returns {Promise<{ schemaVersion: number, threshold: number, positions: any[] }>}
 */
async function loadQuizzes(username) {
    const userKey = requireUserKey(username);
    const payload = userStorage.readQuizzes(userKey);
    if (payload?.schemaVersion !== 2) {
        throw new Error('Quiz database schema is not version 2; run npm run migrate:quizzes first');
    }
    const positions = Array.isArray(payload?.positions) ? payload.positions : [];
    for (const pos of positions) ensureQuizFields(pos);
    const threshold =
        typeof payload?.threshold === 'number' ? payload.threshold : DEFAULT_MISTAKE_THRESHOLD;
    return { schemaVersion: 2, threshold, positions };
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
        schemaVersion: 2,
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
 * @param {{ schemaVersion?: number, threshold?: number, positions: any[] }} quizzes
 * @returns {Promise<{ schemaVersion: number, threshold: number, positions: any[] }>}
 */
async function saveQuizzes(username, quizzes) {
    const userKey = requireUserKey(username);
    const updated = userStorage.updateUserData(userKey, ({ quizzes: existing, analyzedMatches }) => ({
        quizzes: mergeQuizzesPayload(existing, quizzes),
        analyzedMatches
    }));
    return updated.quizzes;
}

/** Values used when user ignores a quiz - ensures it never resurfaces. */
const IGNORED_QUIZ_PLAY_COUNT = 100;
const IGNORED_QUIZ_CORRECT_ANSWERS = 100;

function isAvailableQuiz(position) {
    return position?.active === true && position?.analysis?.engine === 'hedgehog';
}

/**
 * Increment quiz statistics atomically for the given quiz id.
 * @param {string} username
 * @param {string} id
 * @param {boolean} wasCorrect
 * @param {boolean} [ignored] - If true, set playCount and correctAnswers to IGNORED_* values so quiz never resurfaces
 * @returns {Promise<any|null>}
 */
async function recordQuizResult(username, id, wasCorrect, ignored = false) {
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
        if (ignored) {
            record.quiz.playCount = IGNORED_QUIZ_PLAY_COUNT;
            record.quiz.correctAnswers = IGNORED_QUIZ_CORRECT_ANSWERS;
        } else {
            record.quiz.playCount = (Number(record.quiz.playCount) || 0) + 1;
            if (wasCorrect) {
                record.quiz.correctAnswers = (Number(record.quiz.correctAnswers) || 0) + 1;
                if (record.quiz.correctAnswers > record.quiz.playCount) {
                    record.quiz.correctAnswers = record.quiz.playCount;
                }
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
    let positions = (data.positions || []).filter(isAvailableQuiz);

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
    const positions = (data.positions || []).filter(isAvailableQuiz);
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
 * For positions without explicit matchLength, decodes it from OGID.
 * For positions without opponent metadata, uses "?".
 * @param {string} storageKey
 * @param {string} [currentUsername] - The logged-in user's name, used to identify the opponent
 * @returns {Promise<Array<{ matchId: string, matchLength: number|null, opponent: string, positionCount: number }>>}
 */
async function getAllMatches(storageKey, currentUsername) {
    const data = await loadQuizzes(storageKey);
    const positions = (data.positions || []).filter(isAvailableQuiz);
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

        // Determine matchLength: prefer stored field, fall back to OGID decode.
        if (entry.matchLength === null) {
            if (Number.isFinite(p.matchLength)) {
                entry.matchLength = p.matchLength;
            } else if (p.ogid && typeof p.ogid === 'string') {
                try {
                    const board = BackgammonBoard.fromOgid(p.ogid);
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
                            lastQuizId: pos.id
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

module.exports = {
    buildGamePositions,
    normalizeMoveText,
    loadQuizzes,
    saveQuizzes,
    getNextQuiz,
    getQuizById,
    getAnyQuizById,
    getAllPlayers,
    getAllMatches,
    addQuizzesAndSave,
    recordQuizResult,
    ensureQuizFields
};
