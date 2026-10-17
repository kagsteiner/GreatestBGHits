'use strict';

const BackgammonBoard = require('../src/board');
const checkerPlay = require('../shared/checkerPlay');

const { BAR, OFF, positionFromBoard, positionKey, step, applyMoveText, createPlay } = checkerPlay;

const START = [0, -2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5, 5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2, 0];

function position(entries, oppBar = 0) {
    const points = new Array(26).fill(0);
    for (const [point, count] of Object.entries(entries)) points[Number(point)] = count;
    points[0] = oppBar;
    return points;
}

function playsFor(start, moves) {
    return moves.map((move) => ({ move, key: positionKey(applyMoveText(start, move)) }));
}

describe('positionFromBoard()', () => {
    it('matches the engine view of the starting position for either player', () => {
        for (const turn of ['player1', 'player2']) {
            expect(positionFromBoard(BackgammonBoard.starting(turn))).toEqual(START);
        }
    });
});

describe('step()', () => {
    it('moves to an open point and refuses a blocked one', () => {
        expect(step(START, 24, 6)).toMatchObject({ from: 24, to: 18, hit: false });
        expect(step(START, 24, 5)).toBeNull();
        expect(step(START, 7, 1)).toBeNull();
    });

    it('hits a blot and sends it to the opponent bar', () => {
        const points = position({ 13: 2, 8: -1 });
        const moved = step(points, 13, 5);
        expect(moved).toMatchObject({ from: 13, to: 8, hit: true });
        expect(moved.points[8]).toBe(1);
        expect(moved.points[0]).toBe(1);
        expect(moved.points[13]).toBe(1);
    });

    it('requires entering from the bar first', () => {
        const points = position({ [BAR]: 1, 13: 2, 22: -2 });
        expect(step(points, 13, 1)).toBeNull();
        expect(step(points, BAR, 3)).toBeNull(); // 22-point is made
        expect(step(points, BAR, 4)).toMatchObject({ to: 21 });
    });

    it('bears off only when all checkers are home, and with a larger die only from the highest point', () => {
        expect(step(position({ 7: 1, 3: 2 }), 3, 3)).toBeNull();
        const home = position({ 5: 1, 3: 2 });
        expect(step(home, 3, 3)).toMatchObject({ to: OFF });
        expect(step(home, 3, 6)).toBeNull();
        expect(step(home, 5, 6)).toMatchObject({ to: OFF });
    });
});

describe('applyMoveText()', () => {
    it('reads chains, counts, bar and off', () => {
        const a = applyMoveText(START, '24/23 23/18');
        const b = applyMoveText(START, '24/18');
        expect(positionKey(a)).toBe(positionKey(b));
        expect(applyMoveText(START, '8/5(2)')[5]).toBe(2);
        const home = position({ 6: 2 });
        expect(applyMoveText(home, '6/off(2)')[6]).toBe(0);
        expect(applyMoveText(position({ [BAR]: 1, 22: -1 }), 'bar/22*')[0]).toBe(1);
        expect(applyMoveText(START, '13/12')).toBeNull(); // blocked by five opposing checkers
    });
});

describe('createPlay()', () => {
    // Opening 6-5: a subset of the legal plays is enough to test the tracking.
    const plays = playsFor(START, ['24/13', '13/7 13/8', '24/18 13/8']);

    it('offers only moves that can still end in a listed play, combining dice for one checker', () => {
        const play = createPlay(START, [6, 5], plays);
        expect(play.movableFrom().sort((a, b) => a - b)).toEqual([13, 24]);
        expect(play.destinationsFrom(24).map((entry) => entry.to).sort((a, b) => a - b)).toEqual([13, 18]);
        expect(play.destinationsFrom(8)).toEqual([]);
    });

    it('completes a play, reports the engine move, and undoes moves', () => {
        const play = createPlay(START, [6, 5], plays);
        expect(play.move(24, 13)).toMatchObject({ to: 13 });
        expect(play.isComplete()).toBe(true);
        expect(play.finalMove()).toBe('24/13');
        expect(play.movableFrom()).toEqual([]);

        expect(play.undo()).toBe(true);
        expect(play.move(13, 7).steps).toHaveLength(1);
        expect(play.remaining).toEqual([5]);
        expect(play.isComplete()).toBe(false);
        expect(play.move(13, 8)).not.toBeNull();
        expect(play.finalMove()).toBe('13/7 13/8');
        play.reset();
        expect(play.points).toEqual(START);
        expect(play.moveCount).toBe(0);
    });

    it('lets a bear-off continue after a position that is already a legal play', () => {
        // 5-1: bearing off from 5 with the 5 ends where 5/4/off ends, but the
        // 1 can still be played (3/2 or 1/off).
        const start = position({ 5: 1, 3: 3, 1: 2, 22: -3, 13: -5, 12: -2 });
        const play = createPlay(start, [1, 5], playsFor(start, ['5/off 3/2', '5/off 1/off', '5/4/off']));
        expect(play.move(5, OFF).steps.map((entry) => entry.die)).toEqual([5]);
        expect(play.isComplete()).toBe(true);
        expect(play.finalMove()).toBe('5/4/off');
        expect(play.movableFrom().sort((a, b) => a - b)).toEqual([1, 3]);
        expect(play.move(3, 2)).not.toBeNull();
        expect(play.finalMove()).toBe('5/off 3/2');
    });

    it('treats a position with no legal move as complete', () => {
        const closed = position({ [BAR]: 1, 19: -2, 20: -2, 21: -2, 22: -2, 23: -2, 24: -2 });
        const play = createPlay(closed, [3, 1], [{ move: '', key: positionKey(closed) }]);
        expect(play.isComplete()).toBe(true);
        expect(play.finalMove()).toBe('');
    });

    it('prefers a route without an intermediate hit', () => {
        // 6-4 from 24 to 14: via 20 hits a blot, via 18 does not.
        const start = position({ 24: 1, 6: 14, 20: -1 });
        const viaHit = applyMoveText(start, '24/20* 20/14');
        const quiet = applyMoveText(start, '24/18 18/14');
        const play = createPlay(start, [6, 4], [
            { move: '24/20*/14', key: positionKey(viaHit) },
            { move: '24/14', key: positionKey(quiet) }
        ]);
        play.move(24, 14);
        expect(play.finalMove()).toBe('24/14');
    });
});
