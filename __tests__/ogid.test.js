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
        board.points.player2[24] = 1;
        board.points.player2[0] = 13;

        const fields = board.toOgid().split(':');
        expect(fields[0]).toBe('0o');
        expect(fields[1]).toBe('op');
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
});
