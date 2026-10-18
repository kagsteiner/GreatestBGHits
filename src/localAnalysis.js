'use strict';

// Analysis for reviewing matches. Everywhere: searches up to 4-ply. With
// LOCAL_ANALYSIS=1 (a fast local machine): up to 7-ply and rollouts. The
// limits are enforced here, so a small VPS is never asked for more.

const BackgammonBoard = require('./board');

// 3-ply is preselected everywhere: quick, and the depth play is graded at by default.
const LOCAL_LIMITS = { maxPlies: 7, defaultPlies: 3, rollouts: true };
const SERVER_LIMITS = { maxPlies: 4, defaultPlies: 3, rollouts: false };
const ROLLOUT_MODES = {
    quick: { trials: 1296 },
    precise: { trials: 1296, variance_reduction: true },
    deep: { trials: 5184, variance_reduction: true }
};

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

/** What this server allows: depths, the default depth, and whether rollouts run. */
function limits() {
    const allowed = isLocal() ? LOCAL_LIMITS : SERVER_LIMITS;
    return { ...allowed, rolloutModes: allowed.rollouts ? Object.keys(ROLLOUT_MODES) : [] };
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
    if (!limits().rollouts) throw new AnalysisError('Rollouts are available on a local server only', 403);
    const options = ROLLOUT_MODES[mode];
    if (!options) throw new AnalysisError(`Rollout mode must be one of ${Object.keys(ROLLOUT_MODES).join(', ')}`);
    return { ...options, ...extra };
}

/** Candidate plays for the position's dice, with your play ranked. */
async function analyzeMove(engine, { ogid, played, plies }) {
    const board = boardFrom(ogid);
    if (!board.dice) throw new AnalysisError('The position has no dice');
    const result = await engine.analyzeChecker({
        ogid, played: typeof played === 'string' && played ? played : undefined, plies: depth(plies), maxMoves: 10
    });
    return {
        kind: 'move',
        plies: result.plies,
        legalMoves: result.legalMoves,
        moves: result.moves.map(({ points, ...move }) => move),
        played: result.played,
        durationMs: result.durationMs
    };
}

/**
 * One play searched to the full depth, e.g. a play the engine's move filter
 * left at a shallower depth. The engine always searches the "played" play
 * fully, so the play is named as played and taken from the full list.
 */
async function deepenMove(engine, { ogid, move, plies }) {
    const board = boardFrom(ogid);
    if (!board.dice) throw new AnalysisError('The position has no dice');
    if (typeof move !== 'string') throw new AnalysisError('Name the play to search');
    const result = await engine.analyzeChecker({ ogid, played: move, plies: depth(plies), maxMoves: 1000 });
    const played = result.played?.move ?? move;
    const entry = result.moves.find((candidate) => candidate.move === played && candidate.ply === result.plies)
        || result.moves.find((candidate) => candidate.move === played);
    if (!entry) throw new AnalysisError(`The engine did not return '${move}'`);
    const { points, ...rest } = entry;
    return { kind: 'deepen', plies: result.plies, requested: move, move: rest, durationMs: result.durationMs };
}

/** The cube decision of the player on roll in the position (before rolling). */
async function analyzeCube(engine, { ogid, plies }) {
    const board = boardFrom(ogid);
    const result = await engine.analyzeCube({ ogid, player: board.turn, plies: depth(plies) });
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

/** Rollout of the best candidate plays for the position's dice. */
async function rolloutMove(engine, { ogid, mode, candidates }) {
    const board = boardFrom(ogid);
    if (!board.dice) throw new AnalysisError('The position has no dice');
    const count = Math.min(10, Math.max(1, Number(candidates) || 5));
    const result = await engine.rollout({ ogid, dice: board.dice, options: rolloutOptions(mode, { candidates: count }) });
    return { kind: 'rollout-move', mode, ...result };
}

/**
 * Rollout of a cube decision, compared in match winning chances: "no double"
 * rolls the position out as it is; "double, take" with the cube doubled and
 * owned by the taker; "double, pass" is exact from the match equity table.
 */
async function rolloutCube(engine, { ogid, mode }) {
    const board = boardFrom(ogid);
    const player = board.turn;
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
        throw new AnalysisError('Rollouts are available on a local server only', 403);
    }
    return run(engine, request);
}

module.exports = {
    AnalysisError,
    ROLLOUT_MODES,
    analyze,
    isLocal,
    limits
};
