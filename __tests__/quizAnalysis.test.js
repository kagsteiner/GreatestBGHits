'use strict';

const {
    analyzeCheckerQuiz,
    applyCheckerAnalysis,
    applyCubeAnalysis,
    candidateForStorage,
    isAvailableQuiz,
    selectAlternatives
} = require('../src/quizAnalysis');

const evaluation = (overrides = {}) => ({
    win: 0.55,
    gammonWin: 0.15,
    backgammonWin: 0.02,
    gammonLoss: 0.1,
    backgammonLoss: 0.01,
    ...overrides
});

const engineMetadata = { name: 'DarkBGHelmet', version: '0.1.0', network: 'net-a', plies: 3 };

describe('applyCubeAnalysis()', () => {
    const cubeResult = {
        ogid: 'cube-ogid',
        available: true,
        decision: 'Double, take',
        take: 'take',
        noDoubleEquity: 0.1,
        doubleTakeEquity: 0.3,
        doublePassEquity: 1,
        mwc: null,
        evaluation: evaluation(),
        cubeEfficiency: 0.7,
        plies: 3,
        engineMetadata
    };

    it('creates a binary missed-double quiz with engine provenance', () => {
        const updated = applyCubeAnalysis({
            type: 'cube-offer',
            ogid: 'cube-ogid',
            user: { name: 'alice', action: 'no-double' },
            context: { cubeValue: 1 }
        }, cubeResult, { threshold: 0.08, analyzedAt: '2026-10-10T10:00:00.000Z' });

        expect(updated.active).toBe(true);
        expect(updated.best).toMatchObject({ action: 'double', label: 'Double', equity: 0.3 });
        expect(updated.user).toMatchObject({ action: 'no-double', equity: 0.1 });
        expect(updated.options).toHaveLength(2);
        expect(updated.context.equityDiff).toBeCloseTo(0.2);
        expect(updated.context.equityUnit).toBe('emg');
        expect(updated.cubeAnalysis).toMatchObject({
            decision: 'Double, take',
            shouldDouble: true,
            shouldTake: true,
            noDoubleEquity: 0.1,
            doubleTakeEquity: 0.3,
            doublePassEquity: 1
        });
        expect(updated.analysis).toEqual({
            engine: 'darkbghelmet',
            engineVersion: '0.1.0',
            network: 'net-a',
            plies: 3,
            analyzedAt: '2026-10-10T10:00:00.000Z'
        });
    });

    it('labels a redouble and grades a wrong double as an error', () => {
        const updated = applyCubeAnalysis({
            type: 'cube-offer',
            user: { name: 'alice', action: 'double' },
            context: { cubeValue: 2 }
        }, { ...cubeResult, noDoubleEquity: 0.5, doubleTakeEquity: 0.3 }, { threshold: 0.08 });

        expect(updated.best).toMatchObject({ action: 'no-double', equity: 0.5 });
        expect(updated.user).toMatchObject({ action: 'double', label: 'Redouble', equity: 0.3 });
        expect(updated.active).toBe(true);
        expect(updated.context.equityDiff).toBeCloseTo(0.2);
    });

    it('treats a too-good position as no double and values the double at the pass', () => {
        const updated = applyCubeAnalysis({
            type: 'cube-offer',
            user: { name: 'alice', action: 'double' },
            context: { cubeValue: 1 }
        }, { ...cubeResult, noDoubleEquity: 1.3, doubleTakeEquity: 1.6, doublePassEquity: 1 });

        expect(updated.best.action).toBe('no-double');
        expect(updated.user.equity).toBe(1);
        expect(updated.context.equityDiff).toBeCloseTo(0.3);
        expect(updated.cubeAnalysis).toMatchObject({ shouldDouble: false, shouldTake: false });
    });

    it('grades a take/pass decision from the responder perspective', () => {
        const updated = applyCubeAnalysis({
            type: 'cube-response',
            ogid: 'cube-ogid',
            user: { name: 'bob', action: 'drop' },
            context: { cubeValue: 1 }
        }, cubeResult, { threshold: 0.08 });

        expect(updated.active).toBe(true);
        expect(updated.best).toMatchObject({ action: 'take', equity: -0.3 });
        expect(updated.user).toMatchObject({ action: 'pass', equity: -1 });
        expect(updated.context.equityDiff).toBeCloseTo(0.7);
    });

    it('deactivates positions where the cube is not available', () => {
        const updated = applyCubeAnalysis({
            type: 'cube-offer',
            user: { name: 'alice', action: 'no-double' },
            context: {}
        }, { ...cubeResult, available: false, decision: 'Cube not available' });

        expect(updated.active).toBe(false);
        expect(updated.inactiveReason).toBe('cube-not-available');
        expect(updated.analysis.engine).toBe('darkbghelmet');
    });

    it('keeps a correct or small cube error inactive and rejects incomplete results', () => {
        const correct = applyCubeAnalysis({
            type: 'cube-offer', user: { action: 'double' }, context: {}
        }, cubeResult);
        expect(correct).toMatchObject({ active: false, inactiveReason: 'played-cube-action-is-best' });

        const small = applyCubeAnalysis({
            type: 'cube-offer', user: { action: 'no-double' }, context: {}
        }, { ...cubeResult, noDoubleEquity: 0.27 }, { threshold: 0.08 });
        expect(small).toMatchObject({ active: false, inactiveReason: 'below-cube-mistake-threshold' });

        expect(() => applyCubeAnalysis({ type: 'cube-offer', user: { action: 'double' }, context: {} },
            { ...cubeResult, doublePassEquity: undefined })).toThrow("invalid cube equity 'doublePassEquity'");
        expect(() => applyCubeAnalysis({ type: 'move' }, cubeResult)).toThrow('Unsupported cube quiz type');
    });
});

const candidate = (move, equity, ply = 3, evaluationOverrides = {}) => ({
    move, equity, ply, diff: 0, evaluation: evaluation(evaluationOverrides)
});

const result = {
    ogid: 'source-ogid',
    plies: 3,
    legalMoves: 12,
    moves: [
        candidate('13/7 8/7', 0.1),
        candidate('13/7 6/5', 0.05),
        candidate('13/7 13/12', -0.05),
        candidate('24/18 13/12', -0.08, 1),
        candidate('8/2 6/5', -0.2, 1)
    ],
    played: {
        move: '13/7 13/12', rank: 3, equity: -0.05, diff: -0.15, ply: 3, isBest: false, evaluation: evaluation()
    },
    engineMetadata
};

describe('applyCheckerAnalysis()', () => {
    it('stores equities, probabilities, rank, alternatives, and provenance', () => {
        const position = {
            id: 'q1',
            ogid: 'source-ogid',
            user: { name: 'alice', move: '13/7 13/12' },
            context: { dice: { die1: 6, die2: 1 } },
            quiz: { playCount: 2, correctAnswers: 1 }
        };

        const updated = applyCheckerAnalysis(position, result, {
            threshold: 0.08,
            analyzedAt: '2026-10-10T12:00:00.000Z'
        });

        expect(updated.id).toBe('q1');
        expect(updated.active).toBe(true);
        expect(updated.best).toEqual({ move: '13/7 8/7', equity: 0.1, evaluation: evaluation(), ply: 3 });
        expect(updated.user).toMatchObject({ name: 'alice', move: '13/7 13/12', equity: -0.05, rank: 3 });
        expect(updated.higherSample.move).toBe('13/7 6/5');
        expect(updated.lowerSample.move).toBe('24/18 13/12');
        expect(updated.analysis).toEqual({
            engine: 'darkbghelmet',
            engineVersion: '0.1.0',
            network: 'net-a',
            plies: 3,
            analyzedAt: '2026-10-10T12:00:00.000Z'
        });
        expect(updated.context).toMatchObject({ dice: { die1: 6, die2: 1 } });
        expect(updated.context.equityDiff).toBeCloseTo(0.15);
        expect(updated.quiz).toEqual({ playCount: 2, correctAnswers: 1 });
    });

    it('archives and resets learning progress when the best move changes', () => {
        const updated = applyCheckerAnalysis({
            id: 'q2',
            best: { move: '24/18 13/11' },
            user: { name: 'alice', move: '13/7 13/12' },
            context: {},
            quiz: { playCount: 9, correctAnswers: 6 }
        }, result, { threshold: 0.08, analyzedAt: '2026-10-10T12:00:00.000Z' });

        expect(updated.quiz).toEqual({
            playCount: 0,
            correctAnswers: 0,
            history: [{
                playCount: 9,
                correctAnswers: 6,
                endedAt: '2026-10-10T12:00:00.000Z',
                reason: 'best-move-changed-after-analysis-upgrade'
            }]
        });
    });

    it('does not reset learning progress for a different notation of the same best move', () => {
        const updated = applyCheckerAnalysis({
            id: 'q2b',
            best: { move: '8/7 13/7' },
            user: { name: 'alice', move: '13/7 13/12' },
            context: {},
            quiz: { playCount: 9, correctAnswers: 6 }
        }, result);
        expect(updated.quiz).toEqual({ playCount: 9, correctAnswers: 6 });
    });

    it('retains but deactivates a position that is no longer a mistake', () => {
        const best = applyCheckerAnalysis({ id: 'q3', user: { move: '13/7 8/7' }, context: {} }, {
            ...result,
            played: { ...result.played, move: '13/7 8/7', rank: 1, equity: 0.1, diff: 0, isBest: true }
        });
        expect(best).toMatchObject({ active: false, inactiveReason: 'played-move-is-best' });

        const small = applyCheckerAnalysis({ id: 'q3', user: { move: '13/7 6/5' }, context: {} }, {
            ...result,
            played: { ...result.played, move: '13/7 6/5', rank: 2, equity: 0.05, diff: -0.05 }
        }, { threshold: 0.08 });
        expect(small).toMatchObject({ active: false, inactiveReason: 'below-mistake-threshold' });
    });

    it('marks positions with only one legal play as forced', () => {
        const updated = applyCheckerAnalysis({ id: 'q4', user: { move: '' }, context: {} }, {
            ...result, legalMoves: 1, moves: [candidate('', -0.5)], played: null
        });
        expect(updated).toMatchObject({ active: false, inactiveReason: 'forced-move' });
        expect(updated.best).toBeUndefined();
    });

    it('lets a re-evaluated alternative replace the best play', () => {
        const updated = applyCheckerAnalysis({ id: 'q5', user: { move: '13/7 13/12' }, context: {} }, result, {
            alternatives: [candidate('13/7 6/5', 0.12), candidate('8/2 6/5', -0.21)]
        });
        expect(updated.best.move).toBe('13/7 6/5');
        expect(updated.higherSample.move).toBe('13/7 8/7');
        expect(updated.lowerSample.move).toBe('8/2 6/5');
        expect(updated.context.equityDiff).toBeCloseTo(0.17);
    });

    it('rejects a missing played-move evaluation and invalid probability hierarchies', () => {
        let error;
        try {
            applyCheckerAnalysis({ id: 'q6', user: { move: '24/18 13/11' }, context: {} }, { ...result, played: null });
        } catch (caught) {
            error = caught;
        }
        expect(error.code).toBe('QUIZ_MOVE_NOT_RECOGNIZED');

        expect(() => candidateForStorage(candidate('13/7', 0.1, 3, {
            gammonWin: 0.6
        }))).toThrow('inconsistent winning probabilities');
        expect(candidateForStorage({ move: '13/7', equity: 0.1, ply: 3, evaluation: null }).evaluation).toBeNull();
    });
});

describe('selectAlternatives()', () => {
    it('picks one better and one worse play than the played move', () => {
        expect(selectAlternatives(result, {}).map((move) => move.move)).toEqual(['13/7 6/5', '24/18 13/12']);
    });

    it('keeps previously shown alternatives when they are still candidates', () => {
        const picks = selectAlternatives(result, {
            lowerSample: { move: '6/5 8/2' }
        });
        expect(picks.map((move) => move.move)).toEqual(['13/7 6/5', '8/2 6/5']);
    });

    it('fills both slots from the remaining plays when the played move is near the bottom', () => {
        const picks = selectAlternatives({
            ...result,
            played: { ...result.played, move: '8/2 6/5', equity: -0.2 }
        }, {});
        expect(picks.map((move) => move.move)).toEqual(['13/7 6/5', '13/7 13/12']);
    });
});

describe('analyzeCheckerQuiz()', () => {
    it('re-evaluates shallow alternatives at full depth for an actual mistake', async () => {
        const engine = {
            analyzeChecker: jest.fn(async ({ played }) => (played === '24/18 13/12'
                ? {
                    ...result,
                    played: {
                        move: '24/18 13/12', rank: 4, equity: -0.12, diff: -0.22, ply: 3, isBest: false,
                        evaluation: evaluation({ win: 0.5 })
                    }
                }
                : result))
        };
        const position = {
            id: 'q7',
            ogid: 'source-ogid',
            user: { name: 'alice', move: '13/7 13/12' },
            context: { dice: { die1: 6, die2: 1 } }
        };

        const { position: updated, alternatives } = await analyzeCheckerQuiz(engine, position, { plies: 3 });

        expect(engine.analyzeChecker).toHaveBeenCalledTimes(2);
        expect(engine.analyzeChecker.mock.calls[0][0]).toEqual({
            ogid: 'source-ogid', dice: { die1: 6, die2: 1 }, plies: 3, played: '13/7 13/12'
        });
        expect(engine.analyzeChecker.mock.calls[1][0]).toMatchObject({ played: '24/18 13/12', maxMoves: 10 });
        expect(alternatives).toHaveLength(2);
        expect(updated.lowerSample).toMatchObject({ move: '24/18 13/12', equity: -0.12, ply: 3 });
        expect(updated.lowerSample.evaluation.win).toBe(0.5);
    });

    it('does not ask for alternatives when the played move was fine', async () => {
        const engine = {
            analyzeChecker: jest.fn(async () => ({
                ...result,
                played: { ...result.played, move: '13/7 8/7', rank: 1, equity: 0.1, diff: 0, isBest: true }
            }))
        };
        const { position } = await analyzeCheckerQuiz(engine, {
            ogid: 'source-ogid', user: { move: '13/7 8/7' }, context: { dice: { die1: 6, die2: 1 } }
        });
        expect(engine.analyzeChecker).toHaveBeenCalledTimes(1);
        expect(position.active).toBe(false);
    });
});

describe('isAvailableQuiz()', () => {
    it('serves only active quizzes analysed by the current engine', () => {
        expect(isAvailableQuiz({ active: true, analysis: { engine: 'darkbghelmet' } })).toBe(true);
        expect(isAvailableQuiz({ active: false, analysis: { engine: 'darkbghelmet' } })).toBe(false);
        expect(isAvailableQuiz({ active: true, analysis: { engine: 'hedgehog' } })).toBe(false);
    });
});
