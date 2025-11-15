'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runGnuBgAnalysis = require('./gnubgRunner');
const { DEFAULT_MISTAKE_THRESHOLD } = require('./constants');
const BackgammonBoard = require('./board');
const BackgammonParser = require('../backgammon-parser');
const DailyGammonRetriever = require('../DailyGammonRetriever');

const fsp = fs.promises;
const QUIZZES_PATH = path.resolve(__dirname, '..', 'quizzes.json');
const ANALYZED_MATCHES_PATH = path.resolve(__dirname, '..', 'analyzed_matches.json');

// Debug flag for comprehensive logging in addQuizzesAndSave
const DEBUG_ADD_QUIZ = process.env.DEBUG_ADD_QUIZ === 'true' || process.env.DEBUG_ADD_QUIZ === '1';

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
 * @param {{ userName?: string, threshold?: number, onPosition?: (p:any)=>Promise<void>|void }} [options]
 * @returns {Promise<{ engineAvailable: boolean, threshold: number, positions: Array<any> }>}
 */
async function buildGamePositions(matchJson, options = {}) {
    const threshold = typeof options.threshold === 'number' ? options.threshold : DEFAULT_MISTAKE_THRESHOLD;
    const onPosition = typeof options.onPosition === 'function' ? options.onPosition : null;
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
                    threshold,
                    onPosition
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
                    threshold,
                    onPosition
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
        threshold,
        onPosition
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
 * Load the set of analyzed match ids from disk.
 * @returns {Promise<Set<string>>}
 */
async function loadAnalyzedMatches() {
    try {
        const raw = await fsp.readFile(ANALYZED_MATCHES_PATH, 'utf8');
        const data = JSON.parse(raw);
        const arr = Array.isArray(data) ? data : Array.isArray(data?.matches) ? data.matches : [];
        return new Set(arr.map(String));
    } catch (err) {
        if (err && err.code === 'ENOENT') return new Set();
        throw err;
    }
}

/**
 * Persist the set of analyzed match ids to disk.
 * @param {Set<string>} analyzed
 * @returns {Promise<void>}
 */
async function saveAnalyzedMatches(analyzed) {
    const out = { matches: Array.from(analyzed.values()).sort() };
    await fsp.writeFile(ANALYZED_MATCHES_PATH, JSON.stringify(out, null, 2), 'utf8');
}

/**
 * Read quizzes JSON from disk. Returns a normalized structure.
 * @returns {Promise<{ engineAvailable: boolean, threshold: number, positions: any[] }>}
 */
async function loadQuizzes() {
    try {
        const raw = await fsp.readFile(QUIZZES_PATH, 'utf8');
        const data = JSON.parse(raw);
        const positions = Array.isArray(data?.positions) ? data.positions : [];
        for (const pos of positions) ensureQuizFields(pos);
        const threshold =
            typeof data?.threshold === 'number' ? data.threshold : DEFAULT_MISTAKE_THRESHOLD;
        const engineAvailable = Boolean(data?.engineAvailable);
        return { engineAvailable, threshold, positions };
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            // File not found: create empty structure
            return { engineAvailable: true, threshold: DEFAULT_MISTAKE_THRESHOLD, positions: [] };
        }
        throw err;
    }
}

/**
 * Write quizzes JSON to disk with duplicate handling by id.
 * If duplicates exist, merges quiz counters and keeps the first instance's content.
 * @param {{ engineAvailable?: boolean, threshold?: number, positions: any[] }} quizzes
 * @returns {Promise<void>}
 */
async function saveQuizzes(quizzes) {
    const engineAvailable = Boolean(quizzes?.engineAvailable);
    const threshold =
        typeof quizzes?.threshold === 'number' ? quizzes.threshold : DEFAULT_MISTAKE_THRESHOLD;
    const positions = Array.isArray(quizzes?.positions) ? quizzes.positions : [];

    // Normalize and de-duplicate
    const byId = new Map();
    for (const original of positions) {
        const p = ensureQuizFields({ ...original });
        const id = p.id;
        if (!id) continue;
        if (!byId.has(id)) {
            byId.set(id, p);
        } else {
            const existing = byId.get(id);
            existing.quiz.playCount += p.quiz.playCount || 0;
            existing.quiz.correctAnswers += p.quiz.correctAnswers || 0;
            byId.set(id, existing);
        }
    }

    const out = {
        engineAvailable,
        threshold,
        positions: Array.from(byId.values())
    };

    const json = JSON.stringify(out, null, 2);
    await fsp.writeFile(QUIZZES_PATH, json, 'utf8');
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
async function getNextQuiz(playerFilter = null) {
    const data = await loadQuizzes();
    let positions = data.positions || [];

    // Filter by player if specified
    if (playerFilter && playerFilter.trim()) {
        positions = positions.filter(p => {
            const playerName = p?.user?.name;
            return playerName === playerFilter.trim();
        });
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
async function getQuizById(id) {
    if (!id || typeof id !== 'string') return null;
    const data = await loadQuizzes();
    const positions = data.positions || [];
    return positions.find((p) => p && p.id === id) || null;
}

/**
 * Get all unique player names from quizzes.
 * @returns {Promise<string[]>}
 */
async function getAllPlayers() {
    const data = await loadQuizzes();
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
 * Connect to DailyGammon, retrieve last matches, analyze and append quiz positions.
 * Writes update file and saves merged quizzes to quizzes.json.
 * Supports optional progress callback for UI.
 * @param {{ onProgress?: (p: any) => void }} [options]
 * @returns {Promise<{ added: number, total: number, matchesTotal: number }>}
 */
async function addQuizzesAndSave(options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    // Prepare quizzes
    const quizzes = await loadQuizzes();
    const seenIds = new Set();
    for (const p of quizzes.positions) {
        ensureQuizFields(p);
        if (p.id) seenIds.add(p.id);
    }

    // Prepare analyzed matches tracker
    const analyzedMatches = await loadAnalyzedMatches();

    // Step 1: Retrieve finished matches metadata (to know total count early)
    if (onProgress) onProgress({ phase: 'login_and_list' });
    const retriever = new DailyGammonRetriever();
    const username = process.env.DG_USERNAME || 'your_username';
    const password = process.env.DG_PASSWORD || 'your_password';
    const days = parseInt(process.env.DG_DAYS) || 30;
    const userId = process.env.DG_USER_ID || '36594';
    const exportLinks = await retriever.getFinishedMatches(username, password, days, userId);
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
            await buildGamePositions(matchRec.match, {
                threshold: quizzes.threshold,
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
                    await saveQuizzes(quizzes);
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
            const matchId = extractMatchIdFromUrl(url);
            if (matchId) {
                analyzedMatches.add(String(matchId));
                await saveAnalyzedMatches(analyzedMatches);
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
        await fsp.writeFile(path.resolve(__dirname, '..', 'update.json'), JSON.stringify(parsedMatchesOut, null, 2), 'utf8');
    } catch (_) {
        // best-effort; ignore file errors
    }

    // Step 4: Save merged quizzes
    await saveQuizzes(quizzes);

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
    parseBoardIdToGnuId,
    // storage-related exports
    loadQuizzes,
    saveQuizzes,
    getNextQuiz,
    getQuizById,
    getAllPlayers,
    addQuizzesAndSave
};



