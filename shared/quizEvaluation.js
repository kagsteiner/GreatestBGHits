(function exposeQuizEvaluation(root, factory) {
    const evaluation = factory();
    if (typeof module === 'object' && module.exports) module.exports = evaluation;
    else root.quizEvaluation = evaluation;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createQuizEvaluation() {
    'use strict';

    const CLOSE_ENOUGH_EQUITY_LOSS = 0.02;
    const FLOATING_POINT_EPSILON = 1e-9;

    function evaluateSelection(selectedOption, bestOption) {
        if (!selectedOption || !bestOption) {
            return { isSolved: false, quality: 'incorrect', message: 'Not quite.' };
        }

        if (selectedOption.key === bestOption.key || selectedOption.correct === true) {
            return { isSolved: true, quality: 'best', message: 'Correct!', equityLoss: 0 };
        }

        const selectedEquity = selectedOption.equity;
        const bestEquity = bestOption.equity;
        if (Number.isFinite(selectedEquity) && Number.isFinite(bestEquity)) {
            const equityLoss = bestEquity - selectedEquity;
            if (equityLoss <= CLOSE_ENOUGH_EQUITY_LOSS + FLOATING_POINT_EPSILON) {
                return { isSolved: true, quality: 'close', message: 'Pretty good!', equityLoss };
            }
        }

        return { isSolved: false, quality: 'incorrect', message: 'Not quite.' };
    }

    return { CLOSE_ENOUGH_EQUITY_LOSS, evaluateSelection };
}));
