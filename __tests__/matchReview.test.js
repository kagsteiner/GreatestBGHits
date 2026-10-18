'use strict';

const BackgammonBoard = require('../src/board');
const checkerPlay = require('../shared/checkerPlay');
const { buildReview } = require('../src/matchReview');

// A short game: the human opens, the engine replies, the engine doubles and
// the human takes, then a no-double turn and a pass.
function position(board, player) {
    return checkerPlay.positionFromBoard(board, player);
}

function afterMove(board, player, move) {
    const next = board.clone();
    const points = checkerPlay.applyMoveText(position(board, player), move);
    // Write the mover's view back to both sides.
    const opp = player === 'player1' ? 'player2' : 'player1';
    const mine = new Array(26).fill(0);
    const theirs = new Array(26).fill(0);
    for (let point = 1; point <= 24; point++) {
        if (points[point] > 0) mine[point] = points[point];
        else if (points[point] < 0) theirs[25 - point] = -points[point];
    }
    mine[25] = points[25];
    theirs[25] = points[0];
    mine[0] = 15 - mine.slice(1).reduce((a, b) => a + b, 0);
    theirs[0] = 15 - theirs.slice(1).reduce((a, b) => a + b, 0);
    next.points[player] = mine;
    next.points[opp] = theirs;
    return next;
}

function recordedMatch() {
    let board = BackgammonBoard.starting('player1');
    board.matchLength = 5;
    const log = [{ type: 'opening', you: 3, engine: 1 }];
    log.push({ type: 'grade', kind: 'move', action: '8/5 6/5', loss: 0, grade: null, best: '8/5 6/5' });
    board.turn = 'player1';
    board.dice = { die1: 3, die2: 1 };
    board = afterMove(board, 'player1', '8/5 6/5');
    log.push({ type: 'move', who: 'you', move: '8/5 6/5', dice: { die1: 3, die2: 1 }, ogid: board.toOgid() });
    board.turn = 'player2';
    board.dice = { die1: 6, die2: 4 };
    board = afterMove(board, 'player2', '24/14');
    log.push({ type: 'move', who: 'engine', move: '24/14', dice: { die1: 6, die2: 4 }, ogid: board.toOgid() });
    log.push({ type: 'double', who: 'engine', cube: 2 });
    log.push({ type: 'grade', kind: 'take', action: 'Take', loss: 0.05, grade: 'error', best: 'Pass', marked: true });
    log.push({ type: 'take', who: 'you' });
    log.push({ type: 'grade', kind: 'cube', action: 'No double', loss: 0, grade: null, best: 'No redouble, take', rated: false });
    log.push({ type: 'pass', who: 'engine' });
    log.push({ type: 'game-over', winner: 'you', points: 2, kind: 'pass' });
    return { length: 5, games: [{ number: 1, score: { you: 0, engine: 0 }, crawford: false, log }] };
}

describe('buildReview()', () => {
    it('turns a game log into steps with the position before and after each decision', () => {
        const [game] = buildReview(recordedMatch());
        expect(game.steps.map((step) => `${step.type}:${step.who}`)).toEqual([
            'move:you', 'move:engine', 'double:engine', 'take:you', 'no-double:you', 'pass:engine', 'game-over:you'
        ]);
        const [first, second, double, take, noDouble] = game.steps;
        expect(first.grade).toMatchObject({ action: '8/5 6/5' });
        expect(second.grade).toBeNull();

        // Before a move: the mover on roll with the dice; after: the move made.
        const before = BackgammonBoard.fromOgid(first.before);
        expect(before.turn).toBe('player1');
        expect(before.dice).toEqual({ die1: 3, die2: 1 });
        const after = BackgammonBoard.fromOgid(first.after);
        expect(after.points.player1[5]).toBe(2);

        // Cube decisions are seen from the doubler, before the cube changes.
        expect(BackgammonBoard.fromOgid(double.before)).toMatchObject({ turn: 'player2', cube: 1, dice: null });
        expect(BackgammonBoard.fromOgid(take.before)).toMatchObject({ turn: 'player2', cube: 1 });
        expect(take.grade).toMatchObject({ action: 'Take', grade: 'error', marked: true });
        // After the take the human owns the cube at 2.
        expect(BackgammonBoard.fromOgid(noDouble.before)).toMatchObject({ turn: 'player1', cube: 2, cubeOwner: 'player1' });
    });
});
