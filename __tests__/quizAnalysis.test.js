'use strict';

const {
    UnrecognizedPlayedMoveError,
    applyHedgehogAnalysis,
    applyHedgehogCubeAnalysis,
    candidateForStorage
} = require('../src/quizAnalysis');

const evaluation = (overrides = {}) => ({
    win: 0.55,
    gammonWin: 0.15,
    backgammonWin: 0.02,
    gammonLoss: 0.1,
    backgammonLoss: 0.01,
    ...overrides
});

describe('applyHedgehogCubeAnalysis()', () => {
    const cubeResult = {
        ogid: 'cube-ogid',
        available: true,
        action: 'Double/Take',
        shouldDouble: true,
        shouldTake: true,
        noDoubleEquity: 0.1,
        doubleTakeEquity: 0.3,
        doublePassEquity: 1,
        noDoubleNormEq: 0.1,
        doubleTakeNormEq: 0.3,
        doublePassNormEq: 1,
        takePoint: 0.25,
        doublePoint: 0.65,
        winProb: 0.6,
        engineMetadata: {
            model: { id: 'fox-v0.3', name: 'FOX v0.3' },
            hashes: { model: 'cube-hash' },
            engineVersion: '1.2.3',
            cubePly: 2
        }
    };

    it('creates a binary missed-double quiz with cube provenance', () => {
        const updated = applyHedgehogCubeAnalysis({
            type: 'cube-offer',
            ogid: 'cube-ogid',
            user: { name: 'alice', action: 'no-double' },
            context: { cubeValue: 1 }
        }, cubeResult, { threshold: 0.08, analyzedAt: '2026-08-15T10:00:00.000Z' });

        expect(updated.active).toBe(true);
        expect(updated.best).toMatchObject({ action: 'double', equity: 0.3 });
        expect(updated.user).toMatchObject({ action: 'no-double', equity: 0.1 });
        expect(updated.options).toHaveLength(2);
        expect(updated.context.equityDiff).toBeCloseTo(0.2);
        expect(updated.context.equityUnit).toBe('normalized');
        expect(updated.cubeAnalysis).toMatchObject({
            equityUnit: 'normalized',
            noDoubleEquity: 0.1,
            noDoubleNormEq: 0.1
        });
        expect(updated.analysis).toMatchObject({
            engine: 'hedgehog',
            model: { id: 'fox-v0.3' },
            cubePly: 2
        });
    });

    it('grades a take/pass decision from the responder perspective', () => {
        const updated = applyHedgehogCubeAnalysis({
            type: 'cube-response',
            ogid: 'cube-ogid',
            user: { name: 'bob', action: 'pass' },
            context: { cubeValue: 1 }
        }, cubeResult, { threshold: 0.08 });

        expect(updated.active).toBe(true);
        expect(updated.best).toMatchObject({ action: 'take', equity: -0.3 });
        expect(updated.user).toMatchObject({ action: 'pass', equity: -1 });
        expect(updated.context.equityDiff).toBeCloseTo(0.7);
    });

    it('ignores positions where the cube is disabled', () => {
        expect(applyHedgehogCubeAnalysis({
            type: 'cube-offer', user: { action: 'no-double' }, context: {}
        }, { ...cubeResult, cubeDisabled: true })).toMatchObject({
            active: false,
            inactiveReason: 'cube-disabled'
        });
    });

    it('uses normalized equity loss when match-winning chances are compressed', () => {
        const updated = applyHedgehogCubeAnalysis({
            type: 'cube-offer',
            ogid: 'long-match-ogid',
            user: { name: 'alice', action: 'no-double' },
            context: { cubeValue: 1 }
        }, {
            ...cubeResult,
            noDoubleEquity: 0.5160447955131531,
            doubleTakeEquity: 0.5228452086448669,
            noDoubleNormEq: 0.657360315322876,
            doubleTakeNormEq: 0.858140230178833
        }, { threshold: 0.08 });

        expect(updated.active).toBe(true);
        expect(updated.best.equity).toBeCloseTo(0.858140230178833);
        expect(updated.user.equity).toBeCloseTo(0.657360315322876);
        expect(updated.context.equityDiff).toBeCloseTo(0.20077991485595703);
        expect(updated.context.equityDiff).toBeGreaterThan(0.08);
        expect(updated.cubeAnalysis.doubleTakeEquity - updated.cubeAnalysis.noDoubleEquity)
            .toBeLessThan(0.08);
    });

    it('requires normalized equities for match play but supports money-play raw equity', () => {
        const withoutNormalized = {
            ...cubeResult,
            noDoubleNormEq: undefined,
            doubleTakeNormEq: undefined,
            doublePassNormEq: undefined
        };
        expect(() => applyHedgehogCubeAnalysis({
            type: 'cube-offer',
            user: { action: 'no-double' },
            context: { cubeValue: 1, matchLength: 7 }
        }, withoutNormalized)).toThrow('incomplete normalized cube equities for match play');

        const moneyQuiz = applyHedgehogCubeAnalysis({
            type: 'cube-offer',
            user: { action: 'no-double' },
            context: { cubeValue: 1, matchLength: 0 }
        }, withoutNormalized, { threshold: 0.08 });
        expect(moneyQuiz.active).toBe(true);
        expect(moneyQuiz.context.equityDiff).toBeCloseTo(0.2);
        expect(moneyQuiz.cubeAnalysis.normalizedEquitySource).toBe('raw-money-equity');
    });
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

    it('matches equivalent move notation by resulting checker placement', () => {
        const updated = applyHedgehogAnalysis({
            id: 'q-equivalent',
            ogid: '3ggghhiijjjkkll:4455666677888mm:N0N:53:B:R:0:0:21:0',
            user: { name: 'alice', move: '9/6 6/1' },
            context: {}
        }, {
            ...result,
            moves: [{
                ...candidate('9/4 4/1', 0.254),
                resultingOgid: '3gghhiijjjkkllo:4455666677888mm:N0N::B:IW:0:0:0:0'
            }]
        });

        expect(updated.user.move).toBe('9/4 4/1');
        expect(updated.active).toBe(false);
        expect(updated.inactiveReason).toBe('played-move-is-best');
    });

    it('rejects missing played moves and invalid probability hierarchies', () => {
        let unrecognized;
        try {
            applyHedgehogAnalysis({
                id: 'q4', user: { move: '24/18 13/11' }, context: {}
            }, result);
        } catch (error) {
            unrecognized = error;
        }
        expect(unrecognized).toBeInstanceOf(UnrecognizedPlayedMoveError);
        expect(unrecognized.code).toBe('QUIZ_MOVE_NOT_RECOGNIZED');
        expect(() => applyHedgehogAnalysis({
            id: 'q4', user: { move: '24/18 13/11' }, context: {}
        }, result)).toThrow('did not recognize played move');

        expect(() => candidateForStorage(candidate('13/7', 0.1, {
            gammonWin: 0.6
        }))).toThrow('inconsistent winning probabilities');
    });
});
