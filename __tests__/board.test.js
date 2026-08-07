'use strict';

const BackgammonBoard = require('../src/board');

describe('BackgammonBoard', () => {
    describe('starting()', () => {
        it('creates a board with 15 checkers per side', () => {
            const board = BackgammonBoard.starting('player1');
            const sum1 = board.points.player1.reduce((a, b) => a + b, 0);
            const sum2 = board.points.player2.reduce((a, b) => a + b, 0);
            expect(sum1).toBe(15);
            expect(sum2).toBe(15);
        });

        it('places checkers on the correct points', () => {
            const board = BackgammonBoard.starting('player1');
            expect(board.points.player1[6]).toBe(5);
            expect(board.points.player1[8]).toBe(3);
            expect(board.points.player1[13]).toBe(5);
            expect(board.points.player1[24]).toBe(2);

            expect(board.points.player2[6]).toBe(5);
            expect(board.points.player2[8]).toBe(3);
            expect(board.points.player2[13]).toBe(5);
            expect(board.points.player2[24]).toBe(2);
        });

        it('respects the turn parameter', () => {
            expect(BackgammonBoard.starting('player1').turn).toBe('player1');
            expect(BackgammonBoard.starting('player2').turn).toBe('player2');
        });

        it('defaults to player1 turn', () => {
            expect(BackgammonBoard.starting().turn).toBe('player1');
        });

        it('starts with cube at 1 centered', () => {
            const board = BackgammonBoard.starting();
            expect(board.cube).toBe(1);
            expect(board.cubeOwner).toBeNull();
        });
    });

    describe('startingNackgammon()', () => {
        it('creates the Nackgammon starting position for both players', () => {
            const board = BackgammonBoard.startingNackgammon();

            for (const player of ['player1', 'player2']) {
                expect(board.points[player][24]).toBe(2);
                expect(board.points[player][23]).toBe(2);
                expect(board.points[player][13]).toBe(4);
                expect(board.points[player][8]).toBe(3);
                expect(board.points[player][6]).toBe(4);
                expect(board.points[player].reduce((a, b) => a + b, 0)).toBe(15);
            }
        });

        it('respects the turn parameter', () => {
            expect(BackgammonBoard.startingNackgammon('player2').turn).toBe('player2');
        });

        it('has a different OGID from regular backgammon', () => {
            expect(BackgammonBoard.startingNackgammon().toOgid())
                .not.toBe(BackgammonBoard.starting().toOgid());
        });
    });

    describe('clone()', () => {
        it('produces an identical board', () => {
            const board = BackgammonBoard.starting('player1');
            board.dice = { die1: 5, die2: 3 };
            const cloned = board.clone();
            expect(cloned.toOgid()).toBe(board.toOgid());
            expect(cloned.dice).toEqual(board.dice);
        });

        it('produces an independent copy', () => {
            const board = BackgammonBoard.starting('player1');
            const cloned = board.clone();
            cloned.points.player1[6] = 0;
            expect(board.points.player1[6]).toBe(5);
        });
    });

    describe('applyMoveParts()', () => {
        it('moves a checker from one point to another', () => {
            const board = BackgammonBoard.starting('player1');
            board.applyMoveParts('player1', [{ from: 6, to: 3, hit: false }]);
            expect(board.points.player1[6]).toBe(4);
            expect(board.points.player1[3]).toBe(1);
        });

        it('handles a hit (opponent to bar)', () => {
            const board = new BackgammonBoard();
            board.points.player1[8] = 1;
            board.points.player2[17] = 1; // opponent's point 17 = 25-8 from player1's view
            board.applyMoveParts('player1', [{ from: 8, to: 5, hit: true }]);
            expect(board.points.player1[8]).toBe(0);
            expect(board.points.player1[5]).toBe(1);
            expect(board.points.player2[17]).toBe(1); // hit flag is on 'to', not 'from'
        });

        it('bears off a checker (to=0)', () => {
            const board = new BackgammonBoard();
            board.points.player1[3] = 2;
            board.applyMoveParts('player1', [{ from: 3, to: 0, hit: false }]);
            expect(board.points.player1[3]).toBe(1);
            expect(board.points.player1[0]).toBe(1);
        });

        it('enters from bar (from=25)', () => {
            const board = new BackgammonBoard();
            board.points.player1[25] = 1;
            board.applyMoveParts('player1', [{ from: 25, to: 22, hit: false }]);
            expect(board.points.player1[25]).toBe(0);
            expect(board.points.player1[22]).toBe(1);
        });

        it('applies multiple parts sequentially', () => {
            const board = BackgammonBoard.starting('player1');
            board.applyMoveParts('player1', [
                { from: 24, to: 20, hit: false },
                { from: 13, to: 10, hit: false }
            ]);
            expect(board.points.player1[24]).toBe(1);
            expect(board.points.player1[20]).toBe(1);
            expect(board.points.player1[13]).toBe(4);
            expect(board.points.player1[10]).toBe(1);
        });

        it('ignores null/invalid parts gracefully', () => {
            const board = BackgammonBoard.starting('player1');
            const before = board.toOgid();
            board.applyMoveParts('player1', null);
            board.applyMoveParts('player1', [null, undefined, {}]);
            expect(board.toOgid()).toBe(before);
        });
    });

    describe('constructor defaults', () => {
        it('initializes empty board with defaults', () => {
            const board = new BackgammonBoard();
            expect(board.turn).toBe('player1');
            expect(board.cube).toBe(1);
            expect(board.cubeOwner).toBeNull();
            expect(board.matchLength).toBeNull();
            expect(board.dice).toBeNull();
            expect(board.score).toEqual({ player1: 0, player2: 0 });
            expect(board.points.player1).toHaveLength(26);
            expect(board.points.player2).toHaveLength(26);
        });
    });
});
