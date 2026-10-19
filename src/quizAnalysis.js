'use strict';

const { ENGINE_ID, PlayedMoveNotLegalError } = require('./engines/bgEngine');
const { moveSignature } = require('./engines/moveUtils');
const { DEFAULT_MISTAKE_THRESHOLD, DEFAULT_CUBE_MISTAKE_THRESHOLD } = require('./constants');

const PROBABILITY_FIELDS = [
    'win',
    'gammonWin',
    'backgammonWin',
    'gammonLoss',
    'backgammonLoss'
];

const EPSILON = 1e-6;

function validateEvaluation(evaluation, label = '?') {
    if (!evaluation || !PROBABILITY_FIELDS.every(
        (field) => Number.isFinite(evaluation[field]) && evaluation[field] >= -EPSILON && evaluation[field] <= 1 + EPSILON
    )) {
        throw new Error(`Engine returned invalid probabilities for move '${label}'`);
    }
    if (evaluation.backgammonWin > evaluation.gammonWin + EPSILON
        || evaluation.gammonWin > evaluation.win + EPSILON) {
        throw new Error(`Engine returned inconsistent winning probabilities for move '${label}'`);
    }
    if (evaluation.backgammonLoss > evaluation.gammonLoss + EPSILON
        || evaluation.gammonLoss > 1 - evaluation.win + EPSILON) {
        throw new Error(`Engine returned inconsistent losing probabilities for move '${label}'`);
    }
    return true;
}

function candidateForStorage(candidate) {
    if (!candidate) return null;
    if (!Number.isFinite(candidate.equity)) {
        throw new Error(`Engine returned a non-numeric equity for move '${candidate.move || '?'}'`);
    }
    // Plays outside the engine's returned list come without probabilities.
    if (candidate.evaluation) validateEvaluation(candidate.evaluation, candidate.move || '?');
    return {
        move: candidate.move,
        equity: candidate.equity,
        evaluation: candidate.evaluation
            ? Object.fromEntries(PROBABILITY_FIELDS.map((field) => [field, candidate.evaluation[field]]))
            : null,
        ply: candidate.ply ?? null
    };
}

function sameMove(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    return a === b || (moveSignature(a) !== '' && moveSignature(a) === moveSignature(b));
}

function archiveLearningProgress(position, bestChanged, analyzedAt) {
    const quiz = position.quiz && typeof position.quiz === 'object'
        ? { ...position.quiz }
        : { playCount: 0, correctAnswers: 0 };
    if (!bestChanged || (!quiz.playCount && !quiz.correctAnswers)) return quiz;
    const history = Array.isArray(quiz.history) ? quiz.history.slice() : [];
    history.push({
        playCount: Number(quiz.playCount) || 0,
        correctAnswers: Number(quiz.correctAnswers) || 0,
        endedAt: analyzedAt,
        reason: 'best-move-changed-after-analysis-upgrade'
    });
    return { playCount: 0, correctAnswers: 0, history };
}

function analysisProvenance(result, analyzedAt) {
    const metadata = result?.engineMetadata || {};
    return {
        engine: ENGINE_ID,
        engineVersion: metadata.version || null,
        network: metadata.network || null,
        plies: result?.plies ?? metadata.plies ?? null,
        analyzedAt
    };
}

/**
 * Pick two alternative plays for the multiple-choice quiz: one rated better
 * than the played move and one rated worse when possible. Previously chosen
 * alternatives are kept when they are still legal candidates, so a
 * re-analysis does not reshuffle a quiz the user already knows.
 *
 * @returns {Array<object>} up to two entries of `result.moves`
 */
function selectAlternatives(result, position = {}) {
    const moves = Array.isArray(result?.moves) ? result.moves : [];
    const best = moves[0];
    const played = result?.played;
    const available = moves.filter((move) => move !== best
        && !sameMove(move.move, played?.move)
        && Number.isFinite(move.equity));
    const userEquity = played?.equity;
    const chosen = [];
    const take = (predicate, previous) => {
        const pool = available.filter((move) => !chosen.includes(move) && predicate(move));
        const kept = previous ? pool.find((move) => sameMove(move.move, previous)) : null;
        const pick = kept || pool[0];
        if (pick) chosen.push(pick);
    };
    take((move) => move.equity >= userEquity, position.higherSample?.move);
    take((move) => move.equity < userEquity, position.lowerSample?.move);
    while (chosen.length < 2) {
        const before = chosen.length;
        take(() => true, null);
        if (chosen.length === before) break;
    }
    return chosen;
}

/**
 * Build the stored checker quiz from an engine result. `alternatives` are the
 * two extra answer options, ideally re-evaluated at the full search depth.
 */
function applyCheckerAnalysis(position, result, options = {}) {
    const moves = Array.isArray(result?.moves) ? result.moves : [];
    if (!moves.length) throw new Error(`Engine returned no candidates for quiz '${position.id || '?'}'`);
    const analyzedAt = options.analyzedAt || new Date().toISOString();
    const threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_MISTAKE_THRESHOLD;
    const analysis = analysisProvenance(result, analyzedAt);

    if (result.legalMoves <= 1) {
        return {
            ...position,
            ogid: result.ogid || position.ogid,
            active: false,
            inactiveReason: 'forced-move',
            analysis
        };
    }
    const played = result.played;
    if (!played || !Number.isFinite(played.equity)) {
        throw new PlayedMoveNotLegalError(position.user?.move ?? '', 'no evaluation for the played move');
    }

    const alternatives = Array.isArray(options.alternatives)
        ? options.alternatives
        : selectAlternatives(result, position);
    // The best play and the alternatives are ranked by equity together: a
    // re-evaluated alternative may, rarely, overtake the original best play.
    const ranked = [moves[0], ...alternatives]
        .filter((move) => move && Number.isFinite(move.equity))
        .sort((a, b) => b.equity - a.equity);
    let best = ranked[0];
    const playedIsBest = played.isBest || sameMove(played.move, best.move) || played.equity >= best.equity;
    if (playedIsBest) best = { ...played, move: played.move };
    const others = ranked.filter((move) => move !== best && !sameMove(move.move, played.move));

    const equityDiff = Math.max(0, best.equity - played.equity);
    const active = !playedIsBest && equityDiff >= threshold;
    const oldBest = position.best?.move || null;
    const bestChanged = Boolean(oldBest && !sameMove(oldBest, best.move));

    return {
        ...position,
        ogid: result.ogid || position.ogid,
        active,
        inactiveReason: active ? null : (playedIsBest ? 'played-move-is-best' : 'below-mistake-threshold'),
        best: candidateForStorage(best),
        user: {
            ...position.user,
            ...candidateForStorage(played),
            rank: played.rank ?? null
        },
        higherSample: candidateForStorage(others[0]),
        lowerSample: candidateForStorage(others[1]),
        analysis,
        context: { ...position.context, equityDiff },
        quiz: archiveLearningProgress(position, bestChanged, analyzedAt)
    };
}

/**
 * Analyse a checker quiz position end to end: judge the played move and, for
 * an actual mistake, re-evaluate the alternative answers at full depth so all
 * options shown to the user have comparable equities.
 *
 * @param {{ analyzeChecker: Function }} engine
 * @param {object} position quiz position with ogid, user.move and context.dice
 * @param {{ plies?: number, threshold?: number, analyzedAt?: string }} [options]
 */
async function analyzeCheckerQuiz(engine, position, options = {}) {
    const request = {
        ogid: position.ogid,
        dice: position.context?.dice,
        plies: options.plies
    };
    const result = await engine.analyzeChecker({ ...request, played: position.user?.move || '' });
    const preliminary = applyCheckerAnalysis(position, result, { ...options, alternatives: [] });
    if (!preliminary.active) return { position: preliminary, result, alternatives: [] };

    const alternatives = [];
    for (const move of selectAlternatives(result, position)) {
        if (move.ply === result.plies) {
            alternatives.push(move);
            continue;
        }
        // The played move is listed among the plays searched at full depth,
        // which the engine returns first; a short list is enough.
        const refined = await engine.analyzeChecker({ ...request, played: move.move, maxMoves: 10 });
        alternatives.push({
            move: refined.played?.move || move.move,
            equity: refined.played?.equity,
            ply: refined.played?.ply ?? null,
            evaluation: refined.played?.evaluation || null
        });
    }
    return {
        position: applyCheckerAnalysis(position, result, { ...options, alternatives }),
        result,
        alternatives
    };
}

/**
 * Grade a cube decision from one /v1/cube result. Equities are from the
 * doubler's view and money-equivalent (EMG) in match play, so the same
 * thresholds apply to money and match play.
 */
function applyCubeAnalysis(position, result, options = {}) {
    const decisionType = position?.type;
    if (decisionType !== 'cube-offer' && decisionType !== 'cube-response') {
        throw new Error(`Unsupported cube quiz type '${decisionType || ''}'`);
    }
    const analyzedAt = options.analyzedAt || new Date().toISOString();
    const analysis = analysisProvenance(result, analyzedAt);
    if (result?.available === false) {
        return {
            ...position,
            active: false,
            inactiveReason: 'cube-not-available',
            analysis
        };
    }
    for (const field of ['noDoubleEquity', 'doubleTakeEquity', 'doublePassEquity']) {
        if (!Number.isFinite(result?.[field])) {
            throw new Error(`Engine returned invalid cube equity '${field}'`);
        }
    }

    const threshold = Number.isFinite(options.threshold)
        ? options.threshold
        : DEFAULT_CUBE_MISTAKE_THRESHOLD;
    const noDouble = result.noDoubleEquity;
    const doubleTake = result.doubleTakeEquity;
    const doublePass = result.doublePassEquity;
    // The opponent answers a double with whatever is worse for the doubler.
    const shouldTake = doubleTake <= doublePass;
    const doubled = Math.min(doubleTake, doublePass);
    const shouldDouble = doubled > noDouble;
    let choices;
    let bestAction;
    let playedAction = position.user?.action;

    if (decisionType === 'cube-offer') {
        bestAction = shouldDouble ? 'double' : 'no-double';
        choices = [
            { action: 'no-double', label: 'No double', equity: noDouble },
            {
                action: 'double',
                label: Number(position.context?.cubeValue) > 1 ? 'Redouble' : 'Double',
                equity: doubled
            }
        ];
    } else {
        bestAction = shouldTake ? 'take' : 'pass';
        playedAction = playedAction === 'drop' ? 'pass' : playedAction;
        choices = [
            { action: 'take', label: 'Take', equity: -doubleTake },
            { action: 'pass', label: 'Pass', equity: -doublePass }
        ];
    }

    const bestChoice = choices.find((choice) => choice.action === bestAction);
    const playedChoice = choices.find((choice) => choice.action === playedAction);
    if (!playedChoice) throw new Error(`Invalid played cube action '${playedAction || ''}'`);
    const equityDiff = Math.max(0, bestChoice.equity - playedChoice.equity);
    const active = playedAction !== bestAction && equityDiff >= threshold;
    const oldBest = position.best?.action || null;
    const bestChanged = Boolean(oldBest && oldBest !== bestAction);

    return {
        ...position,
        ogid: result.ogid || position.ogid,
        active,
        inactiveReason: active
            ? null
            : (playedAction === bestAction ? 'played-cube-action-is-best' : 'below-cube-mistake-threshold'),
        best: { ...bestChoice },
        user: { ...position.user, ...playedChoice, action: playedAction },
        options: choices.map((choice) => ({
            ...choice,
            key: choice.action,
            correct: choice.action === bestAction,
            played: choice.action === playedAction
        })),
        cubeAnalysis: {
            equityUnit: 'emg',
            decision: result.decision || null,
            take: result.take || null,
            shouldDouble,
            shouldTake,
            noDoubleEquity: noDouble,
            doubleTakeEquity: doubleTake,
            doublePassEquity: doublePass,
            mwc: result.mwc || null,
            cubeEfficiency: result.cubeEfficiency ?? null,
            evaluation: result.evaluation || null
        },
        analysis,
        context: { ...position.context, equityDiff, equityUnit: 'emg' },
        quiz: archiveLearningProgress(position, bestChanged, analyzedAt)
    };
}

/** Cube parameters for a stored cube quiz: the doubler is on roll. */
function cubeRequestFor(position) {
    return {
        ogid: position.ogid,
        player: position.context?.onRoll || position.context?.offeredBy || position.context?.player
    };
}

async function analyzeCubeQuiz(engine, position, options = {}) {
    const result = await engine.analyzeCube({ ...cubeRequestFor(position), plies: options.plies });
    return { position: applyCubeAnalysis(position, result, options), result };
}

function isCubeQuiz(position) {
    return position?.type === 'cube-offer' || position?.type === 'cube-response';
}

/**
 * Analyse any stored quiz position (checker or cube) with the given engine.
 * Resolves to `{ position, result, alternatives }`; pass `result` and
 * `alternatives` to applyQuizAnalysis() to apply the same analysis to a
 * fresher copy of the position.
 */
function analyzeQuiz(engine, position, options = {}) {
    return isCubeQuiz(position)
        ? analyzeCubeQuiz(engine, position, options)
        : analyzeCheckerQuiz(engine, position, options);
}

/** Apply a result from analyzeQuiz() to a position without calling the engine. */
function applyQuizAnalysis(position, result, options = {}) {
    return isCubeQuiz(position)
        ? applyCubeAnalysis(position, result, options)
        : applyCheckerAnalysis(position, result, options);
}

/** A quiz can be served once it is an active mistake analysed by the current engine. */
function isAvailableQuiz(position) {
    return position?.active === true && position?.analysis?.engine === ENGINE_ID;
}

module.exports = {
    PROBABILITY_FIELDS,
    analyzeCheckerQuiz,
    analyzeCubeQuiz,
    analyzeQuiz,
    applyCheckerAnalysis,
    applyCubeAnalysis,
    applyQuizAnalysis,
    candidateForStorage,
    cubeRequestFor,
    isAvailableQuiz,
    isCubeQuiz,
    selectAlternatives,
    validateEvaluation
};
