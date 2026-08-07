'use strict';

const { applyHedgehogAnalysis, candidateForStorage } = require('../src/quizAnalysis');

const evaluation = (overrides = {}) => ({
    win: 0.55,
    gammonWin: 0.15,
    backgammonWin: 0.02,
    gammonLoss: 0.1,
    backgammonLoss: 0.01,
    ...overrides
});

const candidate = (move, equity, overrides = {}) => ({
    move,
    equity,
    resultingOgid: `result-${move}`,
    evaluation: evaluation(overrides),
    ply: 2
});

const result = {
    ogid: 'source-ogid',
    moves: [
        candidate('13/7 8/7', 0.20),
        candidate('13/7 6/5', 0.15),
        candidate('13/7 13/12', 0.05),
        candidate('8/2 6/5', -0.10)
    ],
    engineMetadata: {
        model: { id: 'aureus-v0.1', name: 'Aureus v0.1' },
        hashes: { model: 'model-sha256' },
        engineVersion: '1.2.3',
        ply: 2
    }
};

describe('applyHedgehogAnalysis()', () => {
    it('stores equities, all probabilities, candidate OGIDs, and provenance', () => {
        const position = {
            id: 'q1',
            ogid: 'source-ogid',
            user: { name: 'alice', move: '13/7 13/12' },
            context: {},
            quiz: { playCount: 2, correctAnswers: 1 }
        };

        const updated = applyHedgehogAnalysis(position, result, {
            threshold: 0.08,
            analyzedAt: '2026-08-07T12:00:00.000Z'
        });

        expect(updated.id).toBe('q1');
        expect(updated.active).toBe(true);
        expect(updated.best.evaluation).toEqual(evaluation());
        expect(updated.user.evaluation.backgammonLoss).toBe(0.01);
        expect(updated.user.rank).toBe(3);
        expect(updated.best.resultingOgid).toBe('result-13/7 8/7');
        expect(updated.higherSample.move).toBe('13/7 6/5');
        expect(updated.lowerSample.move).toBe('8/2 6/5');
        expect(updated.analysis).toEqual({
            engine: 'hedgehog',
            model: { id: 'aureus-v0.1', name: 'Aureus v0.1' },
            modelHash: 'model-sha256',
            engineVersion: '1.2.3',
            ply: 2,
            analyzedAt: '2026-08-07T12:00:00.000Z'
        });
        expect(updated.context.equityDiff).toBeCloseTo(0.15);
        expect(updated.quiz).toEqual({ playCount: 2, correctAnswers: 1 });
    });

    it('archives and resets learning progress when the best move changes', () => {
        const updated = applyHedgehogAnalysis({
            id: 'q2',
            best: { move: '24/18 13/11' },
            user: { name: 'alice', move: '13/7 13/12' },
            context: {},
            quiz: { playCount: 9, correctAnswers: 6 }
        }, result, { threshold: 0.08, analyzedAt: '2026-08-07T12:00:00.000Z' });

        expect(updated.quiz.playCount).toBe(0);
        expect(updated.quiz.correctAnswers).toBe(0);
        expect(updated.quiz.history).toEqual([{
            playCount: 9,
            correctAnswers: 6,
            endedAt: '2026-08-07T12:00:00.000Z',
            reason: 'best-move-changed-after-analysis-upgrade'
        }]);
    });

    it('retains but deactivates a position that is no longer a mistake', () => {
        const updated = applyHedgehogAnalysis({
            id: 'q3',
            user: { name: 'alice', move: '13/7 8/7' },
            context: {}
        }, result, { threshold: 0.08 });

        expect(updated.active).toBe(false);
        expect(updated.inactiveReason).toBe('played-move-is-best');
    });

    it('rejects missing played moves and invalid probability hierarchies', () => {
        expect(() => applyHedgehogAnalysis({
            id: 'q4', user: { move: '24/18 13/11' }, context: {}
        }, result)).toThrow('did not recognize played move');

        expect(() => candidateForStorage(candidate('13/7', 0.1, {
            gammonWin: 0.6
        }))).toThrow('inconsistent winning probabilities');
    });
});
