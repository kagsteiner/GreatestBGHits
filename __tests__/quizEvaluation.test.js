'use strict';

const {
    CLOSE_ENOUGH_EQUITY_LOSS,
    evaluateSelection
} = require('../shared/quizEvaluation');

const best = { key: 'best', equity: 0.5, correct: true };

describe('quiz answer evaluation', () => {
    it('solves the quiz when the best move is selected', () => {
        expect(evaluateSelection(best, best)).toEqual({
            isSolved: true,
            quality: 'best',
            message: 'Correct!',
            equityLoss: 0
        });
    });

    it('accepts an alternative exactly 0.02 equity below the best move', () => {
        const result = evaluateSelection({ key: 'alternative', equity: 0.48 }, best);

        expect(CLOSE_ENOUGH_EQUITY_LOSS).toBe(0.02);
        expect(result.isSolved).toBe(true);
        expect(result.quality).toBe('close');
        expect(result.message).toBe('Pretty good!');
    });

    it('accepts an alternative less than 0.02 equity below the best move', () => {
        expect(evaluateSelection({ key: 'alternative', equity: 0.481 }, best).isSolved).toBe(true);
    });

    it('does not accept an alternative more than 0.02 equity below the best move', () => {
        expect(evaluateSelection({ key: 'alternative', equity: 0.479 }, best)).toEqual({
            isSolved: false,
            quality: 'incorrect',
            message: 'Not quite.'
        });
    });

    it('does not apply the tolerance when either equity is unavailable', () => {
        expect(evaluateSelection({ key: 'alternative' }, best).isSolved).toBe(false);
    });
});
