'use strict';

const BackgammonBoard = require('../src/board');

describe('BackgammonBoard.toOgid()', () => {
    it('encodes the standard starting position with player1 mapped to White', () => {
        const board = BackgammonBoard.starting('player1');
        expect(board.toOgid({ gameState: 'IW' }))
            .toBe('11ccccchhhjjjjj:66666888dddddoo:N0N::B:IW:0:0:0:0');
    });

    it('encodes dice, turn, cube, scores, and match length', () => {
        const board = BackgammonBoard.starting('player2');
        board.dice = { die1: 6, die2: 4 };
        board.cube = 4;
        board.cubeOwner = 'player1';
        board.score = { player1: 2, player2: 3 };
        board.matchLength = 7;

        const fields = board.toOgid().split(':');
        expect(fields[2]).toBe('W2N');
        expect(fields[3]).toBe('64');
        expect(fields[4]).toBe('W');
        expect(fields[5]).toBe('R');
        expect(fields.slice(6)).toEqual(['2', '3', '7', '0']);
    });

    it('maps bars and borne-off checkers onto the absolute OGID pip axis', () => {
        const board = new BackgammonBoard();
        board.points.player1[25] = 1;
        board.points.player1[1] = 1;
        board.points.player1[0] = 13;
        board.points.player2[25] = 1;
        board.points.player2[23] = 1;
        board.points.player2[0] = 13;

        const fields = board.toOgid().split(':');
        expect(fields[0]).toBe('0o');
        expect(fields[1]).toBe('np');
    });

    it('encodes the Nackgammon starting checker placement', () => {
        const board = BackgammonBoard.startingNackgammon('player1');
        const fields = board.toOgid().split(':');
        expect(fields[0]).toBe('1122cccchhhjjjj');
        expect(fields[1]).toBe('6666888ddddnnoo');
    });

    it('rejects invalid checker totals and cube values', () => {
        const tooMany = BackgammonBoard.starting();
        tooMany.points.player1[1] = 1;
        expect(() => tooMany.toOgid()).toThrow('total checker count');

        const invalidCube = BackgammonBoard.starting();
        invalidCube.cube = 3;
        expect(() => invalidCube.toOgid()).toThrow('invalid cube value');
    });

    it('rejects positions where both players occupy the same absolute pip', () => {
        const board = new BackgammonBoard();
        board.points.player1[24] = 1;
        board.points.player1[0] = 14;
        board.points.player2[1] = 1;
        board.points.player2[0] = 14;

        expect(() => board.toOgid()).toThrow('both players on absolute pip 1');
        expect(() => BackgammonBoard.fromOgid('1:1:N0N::B:R:0:0:0:0'))
            .toThrow('both players on absolute pip 1');
    });

    it('round-trips position, dice, cube, scores, and turn', () => {
        const original = BackgammonBoard.starting('player2');
        original.applyMoveParts('player2', [{ from: 24, to: 18 }, { from: 13, to: 9 }]);
        original.dice = { die1: 6, die2: 4 };
        original.cube = 4;
        original.cubeOwner = 'player1';
        original.score = { player1: 2, player2: 3 };
        original.matchLength = 7;

        const ogid = original.toOgid();
        const restored = BackgammonBoard.fromOgid(ogid);
        expect(restored.toOgid()).toBe(ogid);
        expect(restored.points).toEqual(original.points);
        expect(restored.turn).toBe('player2');
    });

    it('preserves game state, Crawford state, and move ID when decoded', () => {
        const original = '11ccccchhhjjjjj:66666888dddddoo:N0N::B:IW:0:0:7C:42';
        expect(BackgammonBoard.fromOgid(original).toOgid()).toBe(original);
        expect(BackgammonBoard.fromOgid(original).clone().toOgid()).toBe(original);
    });

    it('rejects malformed OGIDs', () => {
        expect(() => BackgammonBoard.fromOgid('')).toThrow('10 fields');
        expect(() => BackgammonBoard.fromOgid('!:bad:N0N::B:R:0:0:0:0'))
            .toThrow('checker pip');
    });
});
