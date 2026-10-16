'use strict';

const BackgammonBoard = require('../src/board');
const checkerPlay = require('../shared/checkerPlay');
const {
    PlayError,
    PlayMatches,
    cubeErrors,
    gameValue,
    grade,
    setPosition
} = require('../src/playMatch');

/** Dice come from a script; the opening roll uses two values. */
function scriptedDice(values) {
    const queue = values.slice();
    return () => {
        if (!queue.length) throw new Error('Out of scripted dice');
        return queue.shift();
    };
}

const NO_DOUBLE = {
    available: true, decision: 'No double, take', take: 'take',
    noDoubleEquity: 0.1, doubleTakeEquity: 0.05, doublePassEquity: 1
};

/**
 * A fake engine: the human's legal plays are "13/8 6/5" and "24/18 13/8" (or
 * the forced list given), the engine never moves its checkers, and cube
 * answers come from `cube(player)`.
 */
function fakeEngine({ cube = () => NO_DOUBLE, plays = ['13/8 6/5', '24/18 13/8'], fail = false, delayMs = 0 } = {}) {
    const calls = [];
    const depths = [];
    const pause = () => new Promise((resolve) => setTimeout(resolve, delayMs));
    const positionOf = (ogid) => {
        const board = BackgammonBoard.fromOgid(ogid);
        return checkerPlay.positionFromBoard(board, board.turn);
    };
    return {
        calls,
        depths,
        config: { plies: 3 },
        async listLegalPlays({ ogid }) {
            calls.push('legal');
            if (fail) throw new Error('Engine at http://127.0.0.1:3050 is unreachable: ECONNREFUSED');
            const position = positionOf(ogid);
            const board = BackgammonBoard.fromOgid(ogid);
            const list = typeof plays === 'function' ? plays(calls.filter((call) => call === 'legal').length) : plays;
            return {
                position,
                dice: [board.dice.die1, board.dice.die2],
                plays: list.map((move) => ({ move, points: checkerPlay.applyMoveText(position, move) }))
            };
        },
        async analyzeChecker({ ogid, played, plies }) {
            calls.push(played ? `rate ${played}` : 'engine-move');
            depths.push(plies);
            if (delayMs) await pause();
            return {
                moves: [{ move: '13/8 6/5', points: played ? null : positionOf(ogid) }],
                played: played ? { move: played, diff: played === '13/8 6/5' ? 0 : -0.05 } : null
            };
        },
        async analyzeCube({ player, plies }) {
            calls.push(`cube ${player}`);
            depths.push(plies);
            return cube(player);
        }
    };
}

describe('grading helpers', () => {
    it('grades equity losses with XG-style thresholds', () => {
        expect(grade(0.01)).toBeNull();
        expect(grade(0.03)).toBe('doubtful');
        expect(grade(0.05)).toBe('error');
        expect(grade(0.2)).toBe('blunder');
    });

    it('computes cube errors from the doubler\'s equity triple', () => {
        expect(cubeErrors({ noDoubleEquity: 0.5, doubleTakeEquity: 0.7, doublePassEquity: 1 }))
            .toEqual({ ifDoubled: 0, ifNotDoubled: 0.19999999999999996, ifTaken: 0, ifPassed: 0.30000000000000004 });
        // Too good to double: doubling gives up the gammon chances.
        expect(cubeErrors({ noDoubleEquity: 1.3, doubleTakeEquity: 1.8, doublePassEquity: 1 }).ifDoubled).toBeCloseTo(0.3);
    });
});

describe('gameValue()', () => {
    it('scores single games, gammons and backgammons', () => {
        const board = BackgammonBoard.starting();
        board.points.player1 = [15, ...new Array(25).fill(0)];
        board.points.player2 = new Array(26).fill(0);
        board.points.player2[0] = 1;
        board.points.player2[6] = 14;
        expect(gameValue(board, 'player1')).toEqual({ multiplier: 1, kind: 'single' });
        board.points.player2[0] = 0;
        board.points.player2[6] = 15;
        expect(gameValue(board, 'player1')).toEqual({ multiplier: 2, kind: 'gammon' });
        board.points.player2[6] = 14;
        board.points.player2[25] = 1;
        expect(gameValue(board, 'player1')).toEqual({ multiplier: 3, kind: 'backgammon' });
    });
});

describe('setPosition()', () => {
    it('writes a mover-view position back to both sides with borne-off counts', () => {
        const board = BackgammonBoard.starting('player2');
        const start = checkerPlay.positionFromBoard(board, 'player2');
        const after = checkerPlay.applyMoveText(start, '6/off');
        setPosition(board, 'player2', after);
        expect(board.points.player2[6]).toBe(4);
        expect(board.points.player2[0]).toBe(1);
        expect(board.points.player1).toEqual(BackgammonBoard.starting().points.player1);
    });
});

describe('PlayMatches', () => {
    it('lets the human open, rates the move, plays the engine and offers the cube', async () => {
        const engine = fakeEngine();
        // Opening 5-3 (human wins it), then the engine rolls 2-1.
        const matches = new PlayMatches({ engine, randomInt: scriptedDice([5, 3, 2, 1]) });
        let state = await matches.start('me', 5);
        expect(state.phase).toBe('human-move');
        expect(state.events).toEqual([{ type: 'opening', you: 5, engine: 3 }]);
        expect(state.legal.plays.map((play) => play.move)).toEqual(['13/8 6/5', '24/18 13/8']);

        await expect(matches.act('me', { type: 'move', key: 'nonsense' })).rejects.toBeInstanceOf(PlayError);
        await expect(matches.act('me', { type: 'roll' })).rejects.toThrow("'roll' is not possible now");

        state = await matches.act('me', { type: 'move', key: state.legal.plays[1].key });
        expect(state.feedback).toEqual([
            expect.objectContaining({ kind: 'move', action: '24/18 13/8', loss: 0.05, grade: 'error', best: '13/8 6/5' })
        ]);
        expect(state.events.map((event) => event.type)).toEqual(['move', 'roll', 'move']);
        expect(state.phase).toBe('human-turn');
        expect(engine.calls).toEqual(['legal', 'rate 24/18 13/8', 'cube player2', 'engine-move', 'cube player1']);
        expect(state.stats).toMatchObject({ decisions: 1, flagged: 1, equityLost: 0.05 });
    });

    it('plays a forced move for the human and rolls when the cube is not available', async () => {
        // Only the first roll is forced.
        const engine = fakeEngine({
            plays: (count) => (count === 1 ? ['13/8 6/5'] : ['13/8 6/5', '24/18 13/8']),
            cube: () => ({ ...NO_DOUBLE, available: false })
        });
        // Opening 3-5 (engine starts), human rolls 5-3 (forced), engine 2-1, human 6-6.
        const matches = new PlayMatches({ engine, randomInt: scriptedDice([3, 5, 5, 3, 2, 1, 6, 6]) });
        const state = await matches.start('me', 3);
        expect(state.events.map((event) => `${event.type}:${event.who || ''}${event.forced ? ':forced' : ''}`)).toEqual([
            'opening:', 'move:engine', 'roll:you', 'move:you:forced', 'roll:engine', 'move:engine', 'roll:you'
        ]);
        expect(state.phase).toBe('human-move');
        expect(state.feedback).toEqual([]);
    });

    it('ends the game when the human passes a double, and starts the Crawford game at match point', async () => {
        const doubles = (player) => (player === 'player2'
            ? { available: true, decision: 'Double, pass', take: 'pass', noDoubleEquity: 0.9, doubleTakeEquity: 1.4, doublePassEquity: 1 }
            : NO_DOUBLE);
        const engine = fakeEngine({ cube: doubles });
        const matches = new PlayMatches({ engine, randomInt: scriptedDice([5, 3, 6, 1, 6, 2]) });
        let state = await matches.start('me', 3);
        state = await matches.act('me', { type: 'move', key: state.legal.plays[0].key });
        expect(state.phase).toBe('human-respond');
        expect(state.offeredCube).toBe(2);

        state = await matches.act('me', { type: 'pass' });
        expect(state.feedback[0]).toMatchObject({ kind: 'take', action: 'Pass', grade: null });
        expect(state.phase).toBe('game-over');
        expect(state.result).toEqual({ winner: 'engine', points: 1, kind: 'pass' });
        expect(state.score).toEqual({ you: 0, engine: 1 });
        expect(state.nextCrawford).toBe(false);

        // Engine wins another point: 2-away of a 3-point match is match point.
        state = await matches.act('me', { type: 'next-game' });
        state = await matches.act('me', { type: 'move', key: state.legal.plays[0].key });
        state = await matches.act('me', { type: 'pass' });
        expect(state.score).toEqual({ you: 0, engine: 2 });
        expect(state.nextCrawford).toBe(true);

        // In the Crawford game nobody may double, so the engine is not asked.
        engine.calls.length = 0;
        matches.randomInt = scriptedDice([4, 2, 3, 1, 5, 5]);
        state = await matches.act('me', { type: 'next-game' });
        expect(state.crawford).toBe(true);
        state = await matches.act('me', { type: 'move', key: state.legal.plays[0].key });
        expect(engine.calls.some((call) => call.startsWith('cube'))).toBe(false);
        expect(state.phase).toBe('human-move');
    });

    it('lets the engine take the human\'s double and hands it the cube', async () => {
        const engine = fakeEngine({ cube: (player) => (player === 'player1' ? { ...NO_DOUBLE, take: 'take' } : { ...NO_DOUBLE, available: false }) });
        const matches = new PlayMatches({ engine, randomInt: scriptedDice([5, 3, 2, 1, 6, 5]) });
        let state = await matches.start('me', 7);
        state = await matches.act('me', { type: 'move', key: state.legal.plays[0].key });
        expect(state.phase).toBe('human-turn');
        state = await matches.act('me', { type: 'double' });
        expect(state.events.map((event) => event.type)).toEqual(['double', 'take', 'roll']);
        expect(state.cube).toBe(2);
        expect(state.cubeOwner).toBe('engine');
        // Doubling where no double was right is graded as a mistake.
        expect(state.feedback[0]).toMatchObject({ kind: 'cube', action: 'Double', grade: 'error' });
    });

    it('keeps the match unchanged when the engine fails', async () => {
        const engine = fakeEngine();
        const matches = new PlayMatches({ engine, randomInt: scriptedDice([5, 3, 2, 1, 2, 1]) });
        const state = await matches.start('me', 5);
        const key = state.legal.plays[0].key;
        engine.analyzeChecker = async () => { throw new Error('Engine /v1/move timed out after 60000ms'); };
        await expect(matches.act('me', { type: 'move', key })).rejects.toThrow('timed out');
        const again = matches.state('me');
        expect(again.phase).toBe('human-move');
        expect(again.ogid).toBe(state.ogid);
        expect(again.stats.decisions).toBe(0);
    });

    it('plays and grades at the chosen level', async () => {
        const engine = fakeEngine();
        const matches = new PlayMatches({ engine, randomInt: scriptedDice([5, 3, 2, 1]) });
        let state = await matches.start('me', 5, 6);
        expect(state.plies).toBe(6);
        state = await matches.act('me', { type: 'move', key: state.legal.plays[0].key });
        expect(engine.depths).toEqual([6, 6, 6, 6]);
    });

    it('does not ask about the cube when doubling cannot help, as in a 1-point match', async () => {
        const engine = fakeEngine();
        const matches = new PlayMatches({ engine, randomInt: scriptedDice([5, 3, 2, 1, 6, 5]) });
        const state = await matches.start('me', 1);
        await matches.act('me', { type: 'move', key: state.legal.plays[0].key });
        expect(engine.calls.some((call) => call.startsWith('cube'))).toBe(false);
    });

    it('answers with the progress so far when an action takes long, and finishes in the background', async () => {
        const engine = fakeEngine({ delayMs: 60 });
        const matches = new PlayMatches({ engine, randomInt: scriptedDice([5, 3, 2, 1]), waitMs: 10 });
        let state = await matches.start('me', 5);
        // The opening needs no engine search when the human starts.
        expect(state.phase).toBe('human-move');
        state = await matches.act('me', { type: 'move', key: state.legal.plays[0].key });
        expect(state).toMatchObject({ busy: true, phase: 'thinking', legal: null });
        await expect(matches.act('me', { type: 'roll' })).rejects.toMatchObject({ status: 409 });
        await new Promise((resolve) => setTimeout(resolve, 250));
        state = matches.state('me');
        expect(state).toMatchObject({ busy: false, phase: 'human-turn', error: null, actionId: 2 });
        expect(state.events.map((event) => event.type)).toEqual(['move', 'roll', 'move']);
    });

    it('reports a background failure in the state and keeps the match as it was', async () => {
        const engine = fakeEngine({ delayMs: 30 });
        const matches = new PlayMatches({ engine, randomInt: scriptedDice([5, 3, 2, 1]), waitMs: 5 });
        const start = await matches.start('me', 5);
        engine.analyzeCube = async () => { throw new Error('Engine at x is unreachable: ECONNREFUSED'); };
        await matches.act('me', { type: 'move', key: start.legal.plays[0].key });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const state = matches.state('me');
        expect(state.error).toMatch('unreachable');
        expect(state.phase).toBe('human-move');
        expect(state.ogid).toBe(start.ogid);
    });

    it('rejects unknown match lengths, levels, and actions without a match', async () => {
        const matches = new PlayMatches({ engine: fakeEngine() });
        await expect(matches.start('me', 4)).rejects.toThrow('Match length must be one of');
        await expect(matches.start('me', 5, 7)).rejects.toThrow('Engine level must be one of');
        await expect(matches.act('nobody', { type: 'roll' })).rejects.toMatchObject({ status: 404 });
        expect(matches.state('nobody')).toBeNull();
    });
});
