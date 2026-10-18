'use strict';

const BackgammonBoard = require('../src/board');
const localAnalysis = require('../src/localAnalysis');

function ogid(dice = null) {
    const board = BackgammonBoard.starting('player1');
    board.matchLength = 5;
    board.dice = dice;
    return board.toOgid();
}

function fakeEngine() {
    const calls = [];
    return {
        calls,
        async analyzeChecker(params) {
            calls.push(['checker', params]);
            return {
                plies: params.plies, legalMoves: 15, durationMs: 5, played: { move: '13/10 6/5', rank: 2, diff: -0.02 },
                moves: [{ move: '8/5 6/5', equity: 0.1, diff: 0, points: [1], evaluation: { win: 0.5 } }]
            };
        },
        async analyzeCube(params) {
            calls.push(['cube', params]);
            return {
                plies: params.plies, available: true, decision: 'No double, take', take: 'take',
                noDoubleEquity: 0.3, doubleTakeEquity: 0.2, doublePassEquity: 1,
                mwc: { noDouble: 0.55, doubleTake: 0.54, doublePass: 0.7 }, evaluation: { win: 0.6 }, durationMs: 3
            };
        },
        async rollout(params) {
            calls.push(['rollout', params]);
            if (params.dice) return { moves: [{ move: '8/5 6/5', cubefulEquity: 0.1 }], durationMs: 10 };
            const doubled = Boolean(params.cube);
            return {
                mwc: { cubeful: doubled ? 0.58 : 0.56 }, stdError: { cubeful: 0.002 }, evaluation: { win: 0.61 },
                trials: 1296, durationMs: 4
            };
        }
    };
}

describe('localAnalysis', () => {
    const saved = process.env.LOCAL_ANALYSIS;
    afterEach(() => {
        if (saved === undefined) delete process.env.LOCAL_ANALYSIS;
        else process.env.LOCAL_ANALYSIS = saved;
    });

    it('is off unless LOCAL_ANALYSIS is set', () => {
        delete process.env.LOCAL_ANALYSIS;
        expect(localAnalysis.isEnabled()).toBe(false);
        process.env.LOCAL_ANALYSIS = '1';
        expect(localAnalysis.isEnabled()).toBe(true);
    });

    it('analyses a play at 6-ply by default and checks the depth', async () => {
        const engine = fakeEngine();
        const result = await localAnalysis.analyze(engine, { kind: 'move', ogid: ogid({ die1: 3, die2: 1 }), played: '13/10 6/5' });
        expect(engine.calls[0][1]).toMatchObject({ plies: 6, played: '13/10 6/5', maxMoves: 10 });
        expect(result.moves[0]).not.toHaveProperty('points');
        expect(result.played.rank).toBe(2);
        await expect(localAnalysis.analyze(engine, { kind: 'move', ogid: ogid({ die1: 3, die2: 1 }), plies: 8 }))
            .rejects.toThrow('Depth must be 1 to 7');
        await expect(localAnalysis.analyze(engine, { kind: 'move', ogid: ogid() })).rejects.toThrow('no dice');
    });

    it('rolls out a cube decision as no double and double/take, compared in match winning chances', async () => {
        const engine = fakeEngine();
        const result = await localAnalysis.analyze(engine, { kind: 'rollout-cube', ogid: ogid(), mode: 'precise' });
        const rollouts = engine.calls.filter(([kind]) => kind === 'rollout').map(([, params]) => params);
        expect(rollouts[0]).toMatchObject({ options: { trials: 1296, variance_reduction: true } });
        expect(rollouts[0].cube).toBeUndefined();
        expect(rollouts[1].cube).toEqual({ value: 2, owner: 'opponent' });
        expect(result.mwc).toEqual({ noDouble: 0.56, doubleTake: 0.58, doublePass: 0.7 });
        expect(result.verdict).toEqual({ double: true, take: true, text: 'Double, take' });
        await expect(localAnalysis.analyze(engine, { kind: 'rollout-cube', ogid: ogid(), mode: 'forever' }))
            .rejects.toThrow('Rollout mode must be one of');
    });

    it('rolls out the candidate plays for the dice', async () => {
        const engine = fakeEngine();
        await localAnalysis.analyze(engine, { kind: 'rollout-move', ogid: ogid({ die1: 3, die2: 1 }), mode: 'quick', candidates: 3 });
        expect(engine.calls[0][1]).toMatchObject({ dice: { die1: 3, die2: 1 }, options: { trials: 1296, candidates: 3 } });
    });
});

describe('localAnalysis deepen', () => {
    it('searches one play to the full depth by naming it as played', async () => {
        const calls = [];
        const engine = {
            async analyzeChecker(params) {
                calls.push(params);
                return {
                    plies: params.plies,
                    played: { move: '24/14' },
                    moves: [
                        { move: '8/5 6/5', equity: 0.1, ply: 6, points: [1] },
                        { move: '24/14', equity: 0.02, ply: 6, points: [2], evaluation: { win: 0.48 } }
                    ]
                };
            }
        };
        const board = require('../src/board').starting('player1');
        board.matchLength = 5;
        board.dice = { die1: 6, die2: 4 };
        const result = await localAnalysis.analyze(engine, { kind: 'deepen', ogid: board.toOgid(), move: '24/14', plies: 6 });
        expect(calls[0]).toMatchObject({ played: '24/14', plies: 6, maxMoves: 1000 });
        expect(result).toMatchObject({ kind: 'deepen', plies: 6, move: { move: '24/14', ply: 6, equity: 0.02 } });
        expect(result.move).not.toHaveProperty('points');
    });
});
