'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bgEngine = require('./engines/bgEngine');
const {
    DEFAULT_MISTAKE_THRESHOLD,
    DEFAULT_CUBE_MISTAKE_THRESHOLD,
    MATCH_ANALYSIS_VERSION
} = require('./constants');
const BackgammonBoard = require('./board');
const BackgammonParser = require('../backgammon-parser');
const DailyGammonRetriever = require('../DailyGammonRetriever');
const userStorage = require('./storage');
const checkerPlay = require('../shared/checkerPlay');
const {
    analyzeCheckerQuiz,
    analyzeQuiz,
    applyCubeAnalysis,
    applyQuizAnalysis,
    cubeRequestFor,
    isAvailableQuiz
} = require('./quizAnalysis');
const localAnalysis = require('./localAnalysis');

const deepAnalysisJobs = new Map();
// Users with a quiz analysis running: one at a time each, to spare the engine.
const quizAnalysisUsers = new Set();

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
 * Build quiz positions by constructing the board at each ply and asking the
 * backgammon engine to judge every checker play and cube decision.
 *
 * @param {object} matchJson Full match object or single game object
 * @param {{ userName?: string, threshold?: number, dgGameId?: string, onPosition?: (p:any)=>Promise<void>|void }} [options]
 * @returns {Promise<{ threshold: number, positions: Array<any> }>}
 */
async function buildGamePositions(matchJson, options = {}) {
    const threshold = typeof options.threshold === 'number' ? options.threshold : DEFAULT_MISTAKE_THRESHOLD;
    const cubeThreshold = typeof options.cubeThreshold === 'number'
        ? options.cubeThreshold
        : DEFAULT_CUBE_MISTAKE_THRESHOLD;
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

    let crawfordUsed = false;
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
        const matchLength = Number.isFinite(matchJson?.matchLength) ? matchJson.matchLength : 0;
        const inferredCrawford = matchLength > 1
            && !crawfordUsed
            && (board.score.player1 === matchLength - 1 || board.score.player2 === matchLength - 1);
        const isCrawford = game?.crawford === true || inferredCrawford;
        if (isCrawford) crawfordUsed = true;
        board.ogidMetadata.crawford = isCrawford;
        let openingCheckerPlayed = false;
        let pendingDouble = null;

        const playerName = (playerKey) => gamePlayers[playerKey] || playerKey;
        const opponentKey = (playerKey) => playerKey === 'player1' ? 'player2' : 'player1';
        const includesPlayer = (playerKey) => !options.userName
            || !String(options.userName).trim()
            || String(playerName(playerKey)) === String(options.userName);
        const mayOfferCube = (playerKey) => !isCrawford
            && matchLength !== 1
            && (board.cubeOwner === null || board.cubeOwner === playerKey);

        const addCubeQuiz = async (position, analysis) => {
            const analyzed = applyCubeAnalysis(position, analysis, { threshold: cubeThreshold });
            if (!analyzed?.active) return;
            if (Number.isFinite(matchJson?.matchLength)) analyzed.matchLength = matchJson.matchLength;
            analyzed.opponent = playerName(opponentKey(position.context.player));
            if (dgGameId && dgMoveNumber) {
                analyzed.dgGameId = dgGameId;
                analyzed.dgMoveNumber = dgMoveNumber;
            }
            positions.push(analyzed);
            if (onPosition) await onPosition(analyzed);
        };

        const analyzeOffer = async (playerKey, playedAction, moveNumber) => {
            board.turn = playerKey;
            board.dice = null;
            const ogid = board.toOgid({ crawford: isCrawford });
            const analysis = await bgEngine.getClient().analyzeCube({ ogid, player: playerKey });
            if (includesPlayer(playerKey)) {
                await addCubeQuiz({
                    type: 'cube-offer',
                    ogid,
                    user: { name: playerName(playerKey), action: playedAction },
                    context: {
                        gameNumber: game.gameNumber,
                        plyIndex: moveNumber,
                        player: playerKey,
                        onRoll: playerKey,
                        cubeValue: board.cube,
                        cubeOwner: board.cubeOwner,
                        offeredCubeValue: board.cube * 2,
                        matchLength,
                        isCrawford
                    },
                    variant
                }, analysis);
            }
            return { analysis, ogid, offeredBy: playerKey, cubeValue: board.cube, cubeOwner: board.cubeOwner };
        };

        const processAction = async (action, playerKey, moveNumber) => {
            if (!action || action.type === 'no_move' || action.type === 'win') return;
            if (action.type === 'move') {
                if (openingCheckerPlayed && !pendingDouble && mayOfferCube(playerKey) && includesPlayer(playerKey)) {
                    await analyzeOffer(playerKey, 'no-double', moveNumber);
                }
                openingCheckerPlayed = true;
                dgMoveNumber += 2;
                board.turn = playerKey;
                board.dice = action.dice || null;
                const ogid = board.toOgid({ crawford: isCrawford });
                await analyzeAndCollect({
                    ogid,
                    board,
                    dice: action.dice || null,
                    userName: playerName(playerKey),
                    filterUserName: options.userName,
                    userMoveParts: action.moves || [],
                    gameNumber: game.gameNumber,
                    plyIndex: moveNumber,
                    playerKey,
                    positions,
                    threshold,
                    onPosition,
                    dgGameId,
                    dgMoveNumber,
                    matchLength: matchJson?.matchLength,
                    opponent: playerName(opponentKey(playerKey)),
                    variant
                });
                board.applyMoveParts(playerKey, action.moves || []);
                board.dice = null;
                return;
            }
            if (action.type === 'double') {
                dgMoveNumber++;
                if (!mayOfferCube(playerKey)) {
                    throw new Error(`${playerName(playerKey)} offered an illegal cube in game ${game.gameNumber}`);
                }
                pendingDouble = await analyzeOffer(playerKey, 'double', moveNumber);
                return;
            }
            if (action.type === 'take' || action.type === 'drop') {
                dgMoveNumber++;
                if (!pendingDouble) {
                    throw new Error(`Cube response without an offer in game ${game.gameNumber}`);
                }
                const playedAction = action.type === 'take' ? 'take' : 'pass';
                if (includesPlayer(playerKey)) {
                    await addCubeQuiz({
                        type: 'cube-response',
                        ogid: pendingDouble.ogid,
                        user: { name: playerName(playerKey), action: playedAction },
                        context: {
                            gameNumber: game.gameNumber,
                            plyIndex: moveNumber,
                            player: playerKey,
                            onRoll: pendingDouble.offeredBy,
                            offeredBy: pendingDouble.offeredBy,
                            cubeValue: pendingDouble.cubeValue,
                            cubeOwner: pendingDouble.cubeOwner,
                            offeredCubeValue: pendingDouble.cubeValue * 2,
                            matchLength,
                            isCrawford
                        },
                        variant
                    }, pendingDouble.analysis);
                }
                if (action.type === 'take') {
                    board.cube = pendingDouble.cubeValue * 2;
                    board.cubeOwner = playerKey;
                }
                pendingDouble = null;
            }
        };

        for (const moveRec of moves) {
            await processAction(moveRec?.player1, 'player1', moveRec?.moveNumber);
            await processAction(moveRec?.player2, 'player2', moveRec?.moveNumber);
        }
    }

    // Sort positions by equity difference desc
    positions.sort((a, b) => (b?.context?.equityDiff || 0) - (a?.context?.equityDiff || 0));

    return { threshold, cubeThreshold, positions };
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

    // Build user move text and let the engine judge it
    const userMoveText = joinMoveParts(userMoveParts);
    const normalizedUserMove = normalizeMoveText(userMoveText);
    const { position: positionObj, result: analysis } = await analyzeCheckerQuiz(bgEngine.getClient(), {
        type: 'move',
        ogid,
        user: {
            name: userName,
            move: normalizedUserMove
        },
        context: { gameNumber, plyIndex, player: playerKey, dice },
        variant: variant === 'nackgammon' ? 'nackgammon' : 'backgammon'
    }, { threshold });

    // Debug logging: log the engine's ranking of the plays
    if (DEBUG_ADD_QUIZ) {
        const candidates = Array.isArray(analysis?.moves) ? analysis.moves : [];
        console.log(`[DEBUG]   Legal plays: ${analysis?.legalMoves}; best ${candidates.length} listed:`);
        candidates.forEach((move, idx) => {
            const moveText = move.move || '(forced pass)';
            const equity = typeof move.equity === 'number' ? move.equity.toFixed(4) : 'N/A';
            console.log(`[DEBUG]     ${idx + 1}. ${moveText.padEnd(30)} Equity: ${equity} (${move.ply}-ply)`);
        });
        if (analysis?.played) {
            console.log(`[DEBUG]   Played ${analysis.played.move}: rank ${analysis.played.rank}, diff ${analysis.played.diff.toFixed(4)}`);
        }
        console.log('-'.repeat(80));
    }

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
    const typePrefix = p?.type && p.type !== 'move' ? `${p.type}|` : '';
    const key =
        typePrefix +
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
    if (payload?.analysisVersion !== MATCH_ANALYSIS_VERSION) return new Set();
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
    const out = {
        analysisVersion: MATCH_ANALYSIS_VERSION,
        matches: Array.from(analyzed.values()).sort()
    };
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
    const cubeThreshold = typeof payload?.cubeThreshold === 'number'
        ? payload.cubeThreshold
        : DEFAULT_CUBE_MISTAKE_THRESHOLD;
    return { schemaVersion: 2, threshold, cubeThreshold, positions };
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
        cubeThreshold:
            typeof incoming?.cubeThreshold === 'number'
                ? incoming.cubeThreshold
                : (typeof existing?.cubeThreshold === 'number'
                    ? existing.cubeThreshold
                    : DEFAULT_CUBE_MISTAKE_THRESHOLD),
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

function fastAnalysisSnapshot(position) {
    return {
        analysis: position.analysis || null,
        active: position.active,
        inactiveReason: position.inactiveReason || null,
        best: position.best || null,
        user: position.user || null,
        higherSample: position.higherSample || null,
        lowerSample: position.lowerSample || null,
        options: position.options || null,
        cubeAnalysis: position.cubeAnalysis || null,
        contextEquityDiff: position.context?.equityDiff ?? null
    };
}

function deepAnalysisSummary(result, analyzedAt) {
    const metadata = result?.engineMetadata || {};
    return {
        version: 2,
        status: 'complete',
        engine: bgEngine.ENGINE_ID,
        engineVersion: metadata.version || null,
        network: metadata.network || null,
        plies: result?.plies ?? metadata.plies ?? null,
        completedAt: analyzedAt
    };
}

async function runDeepAnalysisForQuiz(userKey, id) {
    const source = await getQuizById(userKey, id);
    if (!source) return null;
    if (source.deepAnalysis?.status === 'complete') return { quiz: source, result: null };

    const client = bgEngine.getClient();
    const analyzedAt = new Date().toISOString();
    const isCube = quizGroup(source) === 'cube';
    const quizzes = await loadQuizzes(userKey);
    const threshold = isCube ? quizzes.cubeThreshold : quizzes.threshold;
    const options = { plies: client.config.deepPlies, threshold, analyzedAt };
    const { result, alternatives } = await analyzeQuiz(client, source, options);

    let saved = null;
    const updated = userStorage.updateUserData(userKey, ({ quizzes: stored, analyzedMatches }) => {
        const positions = Array.isArray(stored.positions) ? stored.positions.slice() : [];
        const index = positions.findIndex((position) => position?.id === id);
        if (index < 0) return { quizzes: stored, analyzedMatches };
        const latest = positions[index];
        if (latest.deepAnalysis?.status === 'complete') {
            saved = latest;
            return { quizzes: stored, analyzedMatches };
        }
        if (latest.ogid !== source.ogid) {
            throw new Error('Quiz position changed while deep analysis was running');
        }
        // Apply to the latest copy so answers recorded meanwhile are kept.
        saved = {
            ...applyQuizAnalysis(latest, result, { ...options, alternatives }),
            fastAnalysis: latest.fastAnalysis || fastAnalysisSnapshot(latest),
            deepAnalysis: deepAnalysisSummary(result, analyzedAt)
        };
        positions[index] = saved;
        return {
            quizzes: { ...stored, positions },
            analyzedMatches
        };
    });
    if (!saved) {
        const savedPositions = Array.isArray(updated?.quizzes?.positions) ? updated.quizzes.positions : [];
        saved = savedPositions.find((position) => position?.id === id) || null;
    }
    return { quiz: saved, result };
}

/** The running or a new deep analysis of a quiz: resolves to { quiz, result }, or null. */
function deepAnalysisJob(userKey, id) {
    const jobKey = `${userKey}\0${id}`;
    if (deepAnalysisJobs.has(jobKey)) return deepAnalysisJobs.get(jobKey);
    const job = runDeepAnalysisForQuiz(userKey, id)
        .finally(() => deepAnalysisJobs.delete(jobKey));
    deepAnalysisJobs.set(jobKey, job);
    return job;
}

async function deepAnalyzeQuiz(username, id) {
    const userKey = requireUserKey(username);
    if (!id || typeof id !== 'string') return null;
    const done = await deepAnalysisJob(userKey, id);
    return done ? done.quiz : null;
}

/** What the analysis panel of the quiz page may ask for. */
function quizAnalysisLimits() {
    const { maxPlies, defaultPlies } = localAnalysis.limits();
    return { plies: defaultPlies, maxPlies, savePlies: bgEngine.getClient().config.deepPlies };
}

/**
 * The analysis panel of a quiz: all plays of a checker quiz ('move', and
 * 'deepen' to search one play to the full depth) or the cube decision
 * ('cube'), for the quiz's own position, dice and doubler. The first full
 * analysis at the deep depth (BG_ENGINE_DEEP_PLIES) is also saved as the
 * quiz's deep analysis, like the former "Deep Analysis" button.
 * A checker analysis always contains `answer` (the play answered in the
 * quiz) at the full depth; the response names it in the engine's notation.
 *
 * @param {{ kind?: string, plies?: number, move?: string, answer?: string }} request
 * @returns {Promise<{ analysis: object, quiz: object|null, answer: string|null }|null>}
 *   `quiz` is the updated quiz when this analysis was saved; null when there is no such quiz
 */
async function analyzeQuizPosition(username, id, request = {}) {
    const userKey = requireUserKey(username);
    if (!id || typeof id !== 'string') return null;
    const quiz = await getQuizById(userKey, id);
    if (!quiz) return null;
    const isCube = quizGroup(quiz) === 'cube';
    const kind = request.kind || (isCube ? 'cube' : 'move');
    if (!(isCube ? ['cube'] : ['move', 'deepen']).includes(kind)) {
        throw new localAnalysis.AnalysisError(`A ${isCube ? 'cube' : 'checker'} quiz has no '${kind}' analysis`);
    }
    const plies = localAnalysis.depth(request.plies);
    if (quizAnalysisUsers.has(userKey)) {
        throw new localAnalysis.AnalysisError('Another analysis is still running', 429);
    }
    quizAnalysisUsers.add(userKey);
    try {
        const client = bgEngine.getClient();
        const position = {
            ogid: quiz.ogid,
            plies,
            dice: isCube ? undefined : quiz.context?.dice,
            player: isCube ? cubeRequestFor(quiz).player : undefined
        };
        const answer = typeof request.answer === 'string' && request.answer.trim() ? request.answer.trim() : null;
        if (kind !== 'deepen' && plies === client.config.deepPlies && quiz.deepAnalysis?.status !== 'complete') {
            const done = await deepAnalysisJob(userKey, id);
            if (done?.result && isCube) {
                return { analysis: localAnalysis.cubeResult(done.result), quiz: done.quiz, answer: null };
            }
            if (done?.result) {
                // The saved analysis ranks the match play; search the answer too.
                const analysis = localAnalysis.moveResult(done.result);
                let answerMove = null;
                if (answer && normalizeMoveText(answer) === normalizeMoveText(quiz.user?.move)) {
                    answerMove = analysis.played?.move ?? null;
                } else if (answer) {
                    const deepened = await localAnalysis.analyze(client, { ...position, kind: 'deepen', move: answer });
                    const index = analysis.moves.findIndex((entry) => entry.move === deepened.move.move);
                    if (index >= 0) analysis.moves[index] = deepened.move;
                    else analysis.moves.push(deepened.move);
                    answerMove = deepened.move.move;
                }
                return { analysis, quiz: done.quiz, answer: answerMove };
            }
        }
        // The engine searches the "played" play fully: the answer, else the match play.
        const analysis = await localAnalysis.analyze(client, {
            ...position,
            kind,
            played: kind === 'move' ? (answer || quiz.user?.move) : undefined,
            move: kind === 'deepen' ? request.move : undefined
        });
        return { analysis, quiz: null, answer: kind === 'move' && answer ? (analysis.played?.move ?? null) : null };
    } finally {
        quizAnalysisUsers.delete(userKey);
    }
}

const LEGAL_PLAYS_CACHE_SIZE = 500;
const legalPlaysCache = new Map();
const CHECKER_OPTION_KEYS = ['best', 'user', 'higherSample', 'lowerSample'];

async function cachedLegalPlays(quiz) {
    const dice = quiz.context?.dice || null;
    const cacheKey = `${quiz.ogid}|${dice?.die1}|${dice?.die2}`;
    if (legalPlaysCache.has(cacheKey)) return legalPlaysCache.get(cacheKey);
    const result = await bgEngine.getClient().listLegalPlays({ ogid: quiz.ogid, dice });
    if (legalPlaysCache.size >= LEGAL_PLAYS_CACHE_SIZE) {
        legalPlaysCache.delete(legalPlaysCache.keys().next().value);
    }
    legalPlaysCache.set(cacheKey, result);
    return result;
}

/**
 * All legal plays of a checker quiz, each with a key for the position it
 * leads to, plus the keys of the multiple-choice answers. The board uses this
 * to accept only legal checker moves and to recognise an answer option.
 *
 * @returns {Promise<object|null>} null when the quiz does not exist
 */
async function getLegalPlays(username, id) {
    const userKey = requireUserKey(username);
    const quiz = await getQuizById(userKey, id);
    if (!quiz) return null;
    if (quizGroup(quiz) !== 'checker') throw new Error('Legal plays exist only for checker quizzes');
    const { position, dice, plays } = await cachedLegalPlays(quiz);
    const keyed = plays.map((play) => ({ move: play.move, key: checkerPlay.positionKey(play.points) }));
    const legalKeys = new Set(keyed.map((play) => play.key));
    // Match by final position: stored answers may use other notation for the
    // same play (e.g. "24/23 23/18*" for the engine's "24/18*").
    const options = {};
    for (const optionKey of CHECKER_OPTION_KEYS) {
        const move = quiz[optionKey]?.move;
        if (typeof move !== 'string') continue;
        const after = checkerPlay.applyMoveText(position, move);
        const key = after ? checkerPlay.positionKey(after) : null;
        options[optionKey] = key && legalKeys.has(key) ? key : null;
    }
    return { id: quiz.id, position, dice, plays: keyed, options };
}

/**
 * Rate a checker play that is not one of the quiz's answer options, at the
 * depth the quiz was analysed with, so its equity compares fairly with them.
 *
 * @returns {Promise<object|null>} null when the quiz does not exist
 */
async function evaluateQuizMove(username, id, move) {
    const userKey = requireUserKey(username);
    const quiz = await getQuizById(userKey, id);
    if (!quiz) return null;
    if (quizGroup(quiz) !== 'checker') throw new Error('Only checker quizzes have plays to rate');
    const client = bgEngine.getClient();
    const plies = Number.isInteger(quiz.analysis?.plies) ? quiz.analysis.plies : client.config.plies;
    const result = await client.analyzeChecker({
        ogid: quiz.ogid,
        dice: quiz.context?.dice,
        played: move,
        plies,
        maxMoves: 1
    });
    const played = result.played;
    if (!played || !Number.isFinite(played.equity)) {
        throw new Error(`The engine returned no rating for '${move}'`);
    }
    return {
        move: played.move,
        equity: played.equity,
        rank: played.rank ?? null,
        isBest: played.isBest === true,
        plies: played.ply ?? result.plies,
        legalMoves: result.legalMoves
    };
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
function quizGroup(position) {
    return position?.type === 'cube-offer' || position?.type === 'cube-response'
        ? 'cube'
        : 'checker';
}

async function getNextQuiz(username, playerFilter = null, matchFilter = null, mode = 'mixed', afterType = null) {
    const data = await loadQuizzes(username);
    let positions = (data.positions || []).filter(isAvailableQuiz);

    if (mode === 'checker') positions = positions.filter((position) => quizGroup(position) === 'checker');
    if (mode === 'cube') positions = positions.filter((position) => quizGroup(position) === 'cube');

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

    const selectHighestPriority = (candidates) => {
        let best = null;
        let bestScore = -Infinity;
        for (const p of candidates) {
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
        return best;
    };

    if (mode === 'mixed' && (afterType === 'checker' || afterType === 'cube')) {
        const preferred = afterType === 'checker' ? 'cube' : 'checker';
        const preferredPositions = positions.filter((position) => quizGroup(position) === preferred);
        if (preferredPositions.length) return selectHighestPriority(preferredPositions);
    }
    return selectHighestPriority(positions) || null;
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
    let checkerQuizzesAdded = 0;
    let cubeQuizzesAdded = 0;
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
                cubeThreshold: quizzes.cubeThreshold,
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
                    const addedQuizType = quizGroup(pos);
                    if (addedQuizType === 'cube') cubeQuizzesAdded += 1;
                    else checkerQuizzesAdded += 1;
                    // Frequent save as requested
                    await saveQuizzes(userKey, quizzes);
                    if (onProgress) {
                        onProgress({
                            phase: 'processing',
                            matchesTotal,
                            processedMatches,
                            quizzesAdded: addedCount,
                            lastQuizId: pos.id,
                            quizType: addedQuizType,
                            checkerQuizzesAdded,
                            cubeQuizzesAdded
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
                quizzesAdded: addedCount,
                checkerQuizzesAdded,
                cubeQuizzesAdded
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
            checkerQuizzesAdded,
            cubeQuizzesAdded,
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
    deepAnalyzeQuiz,
    analyzeQuizPosition,
    quizAnalysisLimits,
    getLegalPlays,
    evaluateQuizMove,
    ensureQuizFields,
    quizGroup
};
