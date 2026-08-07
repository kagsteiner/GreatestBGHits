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

        it('has a different position ID from regular backgammon', () => {
            expect(BackgammonBoard.startingNackgammon().toPositionId())
                .not.toBe(BackgammonBoard.starting().toPositionId());
        });
    });

    describe('toPositionId()', () => {
        it('returns a 14-character base64 string', () => {
            const board = BackgammonBoard.starting('player1');
            const posId = board.toPositionId();
            expect(typeof posId).toBe('string');
            expect(posId).toHaveLength(14);
        });

        it('produces the well-known starting position ID', () => {
            const board = BackgammonBoard.starting('player1');
            const posId = board.toPositionId();
            expect(posId).toBe('4HPwATDgc/ABMA');
        });

        it('is identical for both turns at start (symmetric board)', () => {
            const b1 = BackgammonBoard.starting('player1');
            const b2 = BackgammonBoard.starting('player2');
            expect(b1.toPositionId()).toBe(b2.toPositionId());
        });
    });

    describe('toMatchId()', () => {
        it('returns a 12-character base64 string', () => {
            const board = BackgammonBoard.starting('player1');
            const matchId = board.toMatchId();
            expect(typeof matchId).toBe('string');
            expect(matchId).toHaveLength(12);
        });

        it('differs for different turns', () => {
            const b1 = BackgammonBoard.starting('player1');
            const b2 = BackgammonBoard.starting('player2');
            expect(b1.toMatchId()).not.toBe(b2.toMatchId());
        });
    });

    describe('toGnuId()', () => {
        it('returns positionId:matchId format', () => {
            const board = BackgammonBoard.starting('player1');
            const gnuId = board.toGnuId();
            expect(gnuId).toMatch(/^[A-Za-z0-9+/]+:[A-Za-z0-9+/]+$/);
            const parts = gnuId.split(':');
            expect(parts).toHaveLength(2);
            expect(parts[0]).toHaveLength(14);
            expect(parts[1]).toHaveLength(12);
        });
    });

    describe('fromGnuId() round-trip', () => {
        it('round-trips the starting position', () => {
            const original = BackgammonBoard.starting('player1');
            const gnuId = original.toGnuId();
            const restored = BackgammonBoard.fromGnuId(gnuId);
            expect(restored.toGnuId()).toBe(gnuId);
        });

        it('round-trips a player2 starting position', () => {
            const original = BackgammonBoard.starting('player2');
            const gnuId = original.toGnuId();
            const restored = BackgammonBoard.fromGnuId(gnuId);
            expect(restored.toGnuId()).toBe(gnuId);
        });

        it('preserves turn through round-trip', () => {
            const original = BackgammonBoard.starting('player2');
            const gnuId = original.toGnuId();
            const restored = BackgammonBoard.fromGnuId(gnuId);
            expect(restored.turn).toBe('player2');
        });

        it('round-trips a board with dice and match context', () => {
            const board = BackgammonBoard.starting('player1');
            board.dice = { die1: 3, die2: 1 };
            board.matchLength = 7;
            board.score = { player1: 2, player2: 3 };
            const gnuId = board.toGnuId();
            const restored = BackgammonBoard.fromGnuId(gnuId);
            expect(restored.toGnuId()).toBe(gnuId);
            expect(restored.dice).toEqual({ die1: 3, die2: 1 });
            expect(restored.matchLength).toBe(7);
            expect(restored.score).toEqual({ player1: 2, player2: 3 });
        });

        it('round-trips a board with doubled cube', () => {
            const board = BackgammonBoard.starting('player1');
            board.cube = 4;
            board.cubeOwner = 'player2';
            const gnuId = board.toGnuId();
            const restored = BackgammonBoard.fromGnuId(gnuId);
            expect(restored.cube).toBe(4);
            expect(restored.cubeOwner).toBe('player2');
        });

        it('throws for invalid input', () => {
            expect(() => BackgammonBoard.fromGnuId('')).toThrow();
            expect(() => BackgammonBoard.fromGnuId('nocolon')).toThrow();
        });
    });

    describe('clone()', () => {
        it('produces an identical board', () => {
            const board = BackgammonBoard.starting('player1');
            board.dice = { die1: 5, die2: 3 };
            const cloned = board.clone();
            expect(cloned.toGnuId()).toBe(board.toGnuId());
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
            const before = board.toGnuId();
            board.applyMoveParts('player1', null);
            board.applyMoveParts('player1', [null, undefined, {}]);
            expect(board.toGnuId()).toBe(before);
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
