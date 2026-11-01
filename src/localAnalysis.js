'use strict';

// Analysis for reviewing matches. On the server: searches up to 4-ply; with
// LOCAL_ANALYSIS=1 (a fast local machine) up to 7-ply and rollouts. For a page
// that runs the engine itself (src/engineBridge.js): what that browser
// computes in about a minute, from the speed it measured
// (shared/engineBudget.js). The limits are enforced here, so neither a small
// VPS nor a slow phone is asked for more.

const BackgammonBoard = require('./board');
const { getBridges } = require('./engineBridge');

// 3-ply is preselected everywhere: quick, and the depth play is graded at by default.
const LOCAL_LIMITS = { maxPlies: 7, defaultPlies: 3, rollouts: true };
const SERVER_LIMITS = { maxPlies: 4, defaultPlies: 3, rollouts: false };
const ROLLOUT_MODES = {
    quick: { trials: 1296 },
    precise: { trials: 1296, variance_reduction: true },
    deep: { trials: 5184, variance_reduction: true }
};

const ROLLOUTS_UNAVAILABLE = 'Rollouts need the engine in your browser, which is still loading, cannot run here or is too slow for them';

class AnalysisError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'AnalysisError';
        this.status = status;
    }
}

function isLocal() {
    return ['1', 'true', 'yes'].includes(String(process.env.LOCAL_ANALYSIS || '').toLowerCase());
}

/**
 * What may be asked for: depths, the default depth, and the rollout modes.
 * For the current request: a request from a page with its engine ready gets
 * what that browser can do; `server: true` asks for the server's own limits.
 */
function limits({ server = false } = {}) {
    const own = server ? null : getBridges().currentLimits({ maxPlies: LOCAL_LIMITS.maxPlies });
    if (own) {
        const rolloutModes = Object.keys(ROLLOUT_MODES).filter((mode) => own.rollouts.includes(mode));
        return {
            maxPlies: own.maxPlies,
            defaultPlies: Math.min(LOCAL_LIMITS.defaultPlies, own.maxPlies),
            rollouts: rolloutModes.length > 0,
            rolloutModes
        };
    }
    const allowed = isLocal() ? LOCAL_LIMITS : SERVER_LIMITS;
    return { ...allowed, rolloutModes: allowed.rollouts ? Object.keys(ROLLOUT_MODES) : [] };
}

/**
 * The limits for an analysis view as the page loads: the server's. Once the
 * page's engine is ready, the page offers what it measured it can do
 * (public/engineBridge.js), which the server then allows as well.
 */
function viewLimits() {
    const { defaultPlies, maxPlies, rolloutModes } = limits({ server: true });
    return { plies: defaultPlies, maxPlies, rollouts: rolloutModes };
}

function boardFrom(ogid) {
    try {
        return BackgammonBoard.fromOgid(String(ogid || ''));
    } catch (error) {
        throw new AnalysisError(`Invalid position: ${error.message}`);
    }
}

function depth(plies) {
    const { maxPlies, defaultPlies } = limits();
    if (plies === undefined || plies === null) return defaultPlies;
    const value = Number(plies);
    if (!Number.isInteger(value) || value < 1 || value > maxPlies) {
        throw new AnalysisError(`Depth must be 1 to ${maxPlies} plies`);
    }
    return value;
}

function rolloutOptions(mode, extra = {}) {
    const { rollouts, rolloutModes } = limits();
    if (!rollouts) throw new AnalysisError(ROLLOUTS_UNAVAILABLE, 403);
    const options = ROLLOUT_MODES[mode];
    if (!options) throw new AnalysisError(`Rollout mode must be one of ${Object.keys(ROLLOUT_MODES).join(', ')}`);
    if (!rolloutModes.includes(mode)) throw new AnalysisError(`This device offers only ${rolloutModes.join(', ')} rollouts`, 403);
    return { ...options, ...extra };
}

/** The dice to analyse: given ones (quizzes store them apart), else the position's. */
function diceFor(board, dice) {
    const chosen = dice || board.dice;
    if (!chosen) throw new AnalysisError('The position has no dice');
    return chosen;
}

/** A checker analysis from the engine as the analysis views show it. */
function moveResult(result) {
    return {
        kind: 'move',
        plies: result.plies,
        legalMoves: result.legalMoves,
        moves: result.moves.map(({ points, ...move }) => move),
        played: result.played,
        durationMs: result.durationMs
    };
}

/** Candidate plays for the position's dice, with your play ranked. */
async function analyzeMove(engine, { ogid, dice, played, plies }) {
    const board = boardFrom(ogid);
    const result = await engine.analyzeChecker({
        ogid, dice: diceFor(board, dice), played: typeof played === 'string' && played ? played : undefined,
        plies: depth(plies), maxMoves: 10
    });
    return moveResult(result);
}

/**
 * One play searched to the full depth, e.g. a play the engine's move filter
 * left at a shallower depth. The engine always searches the "played" play
 * fully, so the play is named as played and taken from the full list.
 */
async function deepenMove(engine, { ogid, dice, move, plies }) {
    const board = boardFrom(ogid);
    const chosen = diceFor(board, dice);
    if (typeof move !== 'string') throw new AnalysisError('Name the play to search');
    const result = await engine.analyzeChecker({ ogid, dice: chosen, played: move, plies: depth(plies), maxMoves: 1000 });
    const played = result.played?.move ?? move;
    const entry = result.moves.find((candidate) => candidate.move === played && candidate.ply === result.plies)
        || result.moves.find((candidate) => candidate.move === played);
    if (!entry) throw new AnalysisError(`The engine did not return '${move}'`);
    const { points, ...rest } = entry;
    return { kind: 'deepen', plies: result.plies, requested: move, move: rest, durationMs: result.durationMs };
}

/**
 * The cube decision of the player on roll in the position (before rolling),
 * or of `player` (quizzes name the doubler).
 */
async function analyzeCube(engine, { ogid, player, plies }) {
    const board = boardFrom(ogid);
    const result = await engine.analyzeCube({ ogid, player: player || board.turn, plies: depth(plies) });
    return cubeResult(result);
}

/** A cube analysis from the engine as the analysis views show it. */
function cubeResult(result) {
    return {
        kind: 'cube',
        plies: result.plies,
        available: result.available,
        decision: result.decision,
        take: result.take,
        equity: { noDouble: result.noDoubleEquity, doubleTake: result.doubleTakeEquity, doublePass: result.doublePassEquity },
        mwc: result.mwc,
        evaluation: result.evaluation,
        durationMs: result.durationMs
    };
}

/**
 * Rollout of the best candidate plays for the given dice, else the
 * position's; or of the given `plays` (a quiz's answers).
 */
async function rolloutMove(engine, { ogid, dice, mode, candidates, plays }) {
    const board = boardFrom(ogid);
    const chosen = diceFor(board, dice);
    if (Array.isArray(plays)) {
        if (!plays.length || plays.length > 10) throw new AnalysisError('Name 1 to 10 plays to roll out');
        const result = await engine.rolloutPlays({ ogid, dice: chosen, plays, options: rolloutOptions(mode) });
        return { kind: 'rollout-move', mode, ...result };
    }
    const count = Math.min(10, Math.max(1, Number(candidates) || 5));
    const result = await engine.rollout({ ogid, dice: chosen, options: rolloutOptions(mode, { candidates: count }) });
    return { kind: 'rollout-move', mode, ...result };
}

/**
 * Rollout of the cube decision of the player on roll, or of `player` (quizzes
 * name the doubler), compared in match winning chances: "no double" rolls the
 * position out as it is; "double, take" with the cube doubled and owned by
 * the taker; "double, pass" is exact from the match equity table.
 */
async function rolloutCube(engine, { ogid, player: doubler, mode }) {
    const board = boardFrom(ogid);
    const player = doubler || board.turn;
    const options = rolloutOptions(mode);
    const exact = await engine.analyzeCube({ ogid, player, plies: 1 });
    if (!exact.mwc) throw new AnalysisError('Cube rollouts are available in match play only');
    const noDouble = await engine.rollout({ ogid, player, options });
    const doubleTake = await engine.rollout({
        ogid, player, options, cube: { value: Math.max(1, board.cube) * 2, owner: 'opponent' }
    });
    const nd = noDouble.mwc?.cubeful;
    const dt = doubleTake.mwc?.cubeful;
    const dp = exact.mwc.doublePass;
    const doubled = Math.min(dt, dp);
    return {
        kind: 'rollout-cube',
        mode,
        available: exact.available,
        mwc: { noDouble: nd, doubleTake: dt, doublePass: dp },
        stdError: { noDouble: noDouble.stdError?.cubeful ?? null, doubleTake: doubleTake.stdError?.cubeful ?? null },
        evaluation: noDouble.evaluation,
        verdict: {
            double: doubled > nd,
            take: dt < dp,
            text: `${doubled > nd ? 'Double' : 'No double'}, ${dt < dp ? 'take' : 'pass'}`
        },
        trials: noDouble.trials,
        durationMs: (noDouble.durationMs || 0) + (doubleTake.durationMs || 0)
    };
}

const KINDS = {
    move: analyzeMove,
    deepen: deepenMove,
    cube: analyzeCube,
    'rollout-move': rolloutMove,
    'rollout-cube': rolloutCube
};

async function analyze(engine, request) {
    const run = KINDS[request?.kind];
    if (!run) throw new AnalysisError(`Unknown analysis '${request?.kind}'`);
    if (request.kind.startsWith('rollout-') && !limits().rollouts) {
        throw new AnalysisError(ROLLOUTS_UNAVAILABLE, 403);
    }
    return run(engine, request);
}

module.exports = {
    AnalysisError,
    ROLLOUT_MODES,
    analyze,
    cubeResult,
    depth,
    isLocal,
    limits,
    moveResult,
    viewLimits
};
