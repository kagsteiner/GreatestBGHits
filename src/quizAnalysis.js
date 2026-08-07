'use strict';

const BackgammonBoard = require('./board');
const { moveNotationToParts, moveSignature } = require('./engines/moveUtils');
const { DEFAULT_MISTAKE_THRESHOLD } = require('./constants');

const PROBABILITY_FIELDS = [
    'win',
    'gammonWin',
    'backgammonWin',
    'gammonLoss',
    'backgammonLoss'
];

class UnrecognizedPlayedMoveError extends Error {
    constructor(move, quizId) {
        super(`Hedgehog did not recognize played move '${move}' for quiz '${quizId}'`);
        this.name = 'UnrecognizedPlayedMoveError';
        this.code = 'QUIZ_MOVE_NOT_RECOGNIZED';
    }
}

function validateEvaluation(evaluation, label = '?') {
    if (!evaluation || !PROBABILITY_FIELDS.every(
        (field) => Number.isFinite(evaluation[field]) && evaluation[field] >= 0 && evaluation[field] <= 1
    )) {
        throw new Error(`Hedgehog returned invalid probabilities for move '${label}'`);
    }
    if (evaluation.backgammonWin > evaluation.gammonWin || evaluation.gammonWin > evaluation.win) {
        throw new Error(`Hedgehog returned inconsistent winning probabilities for move '${label}'`);
    }
    if (evaluation.backgammonLoss > evaluation.gammonLoss || evaluation.gammonLoss > 1 - evaluation.win + 1e-6) {
        throw new Error(`Hedgehog returned inconsistent losing probabilities for move '${label}'`);
    }
    return true;
}

function candidateForStorage(candidate, fallbackPly = null) {
    if (!candidate) return null;
    const evaluation = candidate.evaluation;
    validateEvaluation(evaluation, candidate.move || '?');
    if (!Number.isFinite(candidate.equity)) {
        throw new Error(`Hedgehog returned a non-numeric equity for move '${candidate.move || '?'}'`);
    }
    return {
        move: candidate.move,
        equity: candidate.equity,
        resultingOgid: candidate.resultingOgid || null,
        evaluation: {
            win: evaluation.win,
            gammonWin: evaluation.gammonWin,
            backgammonWin: evaluation.backgammonWin,
            gammonLoss: evaluation.gammonLoss,
            backgammonLoss: evaluation.backgammonLoss
        },
        ply: candidate.ply || fallbackPly
    };
}

function checkerPlacementKey(ogid) {
    const canonical = BackgammonBoard.fromOgid(ogid).toOgid();
    return canonical.split(':').slice(0, 2).join(':');
}

function playedMovePlacementKey(sourceOgid, move) {
    if (typeof sourceOgid !== 'string' || !sourceOgid || typeof move !== 'string') return null;
    const parts = moveNotationToParts(move);
    if (!parts.length) return null;

    try {
        const board = BackgammonBoard.fromOgid(sourceOgid);
        for (const part of parts) {
            if (board.points[board.turn][part.from] <= 0) return null;
            board.applyMoveParts(board.turn, [part]);
        }
        return checkerPlacementKey(board.toOgid());
    } catch (_) {
        return null;
    }
}

function findCandidateIndex(candidates, move, sourceOgid = null) {
    const signature = moveSignature(move);
    if (signature) {
        const playedPlacement = playedMovePlacementKey(sourceOgid, move);
        if (playedPlacement) {
            const resultingIndex = candidates.findIndex((candidate) => {
                if (typeof candidate.resultingOgid !== 'string' || !candidate.resultingOgid) return false;
                try {
                    return checkerPlacementKey(candidate.resultingOgid) === playedPlacement;
                } catch (_) {
                    return false;
                }
            });
            if (resultingIndex >= 0) return resultingIndex;
        }
        return candidates.findIndex((candidate) => moveSignature(candidate.move) === signature);
    }

    // Hedgehog represents a forced pass with an empty move notation. DailyGammon
    // likewise parses a roll with no legal checker play as an empty move list.
    // Match only an explicitly empty engine candidate so malformed non-empty
    // notation cannot accidentally be treated as a pass.
    if (typeof move === 'string' && !move.trim()) {
        return candidates.findIndex(
            (candidate) => typeof candidate.move === 'string' && !candidate.move.trim()
        );
    }
    return -1;
}

function selectSample(candidates, existingMove, allowed, excluded) {
    const existingIndex = findCandidateIndex(candidates, existingMove);
    if (existingIndex >= 0 && allowed(existingIndex) && !excluded.has(existingIndex)) return existingIndex;
    for (let index = 0; index < candidates.length; index++) {
        if (allowed(index) && !excluded.has(index)) return index;
    }
    return -1;
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

function applyHedgehogAnalysis(position, result, options = {}) {
    const candidates = Array.isArray(result?.moves) ? result.moves : [];
    if (!candidates.length) throw new Error(`Hedgehog returned no candidates for quiz '${position.id || '?'}'`);
    const userIndex = findCandidateIndex(candidates, position.user?.move, position.ogid);
    if (userIndex < 0) {
        throw new UnrecognizedPlayedMoveError(position.user?.move, position.id || '?');
    }
    const best = candidates[0];
    const userCandidate = candidates[userIndex];
    if (!Number.isFinite(best.equity) || !Number.isFinite(userCandidate.equity)) {
        throw new Error(`Hedgehog returned a non-numeric equity for quiz '${position.id || '?'}'`);
    }

    const analyzedAt = options.analyzedAt || new Date().toISOString();
    const metadata = result.engineMetadata || {};
    const fallbackPly = metadata.ply || null;
    const oldBest = position.best?.move || null;
    const bestChanged = Boolean(oldBest && moveSignature(oldBest) !== moveSignature(best.move));
    const equityDiff = best.equity - userCandidate.equity;
    const threshold = Number.isFinite(options.threshold)
        ? options.threshold
        : DEFAULT_MISTAKE_THRESHOLD;

    const excluded = new Set([0, userIndex]);
    const higherIndex = selectSample(
        candidates,
        position.higherSample?.move,
        (index) => index < userIndex,
        excluded
    );
    if (higherIndex >= 0) excluded.add(higherIndex);
    let lowerIndex = selectSample(
        candidates,
        position.lowerSample?.move,
        (index) => index > userIndex,
        excluded
    );
    if (lowerIndex < 0) {
        lowerIndex = selectSample(candidates, null, () => true, excluded);
    }

    const active = userIndex > 0 && equityDiff >= threshold;
    return {
        ...position,
        ogid: result.ogid || position.ogid,
        active,
        inactiveReason: active ? null : (userIndex === 0 ? 'played-move-is-best' : 'below-mistake-threshold'),
        best: candidateForStorage(best, fallbackPly),
        user: {
            ...position.user,
            ...candidateForStorage(userCandidate, fallbackPly),
            rank: userIndex + 1
        },
        higherSample: candidateForStorage(candidates[higherIndex], fallbackPly),
        lowerSample: candidateForStorage(candidates[lowerIndex], fallbackPly),
        analysis: {
            engine: 'hedgehog',
            model: metadata.model || null,
            modelHash: metadata.hashes?.model || null,
            engineVersion: metadata.engineVersion || null,
            ply: fallbackPly,
            analyzedAt
        },
        context: { ...position.context, equityDiff },
        quiz: archiveLearningProgress(position, bestChanged, analyzedAt)
    };
}

module.exports = {
    PROBABILITY_FIELDS,
    UnrecognizedPlayedMoveError,
    applyHedgehogAnalysis,
    candidateForStorage,
    findCandidateIndex,
    validateEvaluation
};
