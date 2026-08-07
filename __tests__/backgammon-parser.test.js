'use strict';

const BackgammonParser = require('../backgammon-parser');

const SAMPLE_MATCH = `5 point match

Game 1
Alice : 0  Bob : 0
1) 31: 8/5 6/5                    42: 24/20 13/11
2) 43: 13/9 13/10                 65: 24/13
3) 52: 9/4 6/4                    33: 20/17 20/17 13/10 11/8

Game 2
Alice : 2  Bob : 0
1) 62: 24/18 13/11                51: 13/8 24/23
2) 31: 8/5 6/5                    Doubles => 2
3) Takes                           64: 24/14`;

const MATCH_WITH_WIN = `3 point match

Game 1
Alice : 0  Bob : 0
1) 31: 8/5 6/5                    42: 24/20 13/11
2) Alice Wins 1 point and the match`;

const NACK_PLAYER1_FIRST = `1 point match

Game 1
doright : 0                         Deb22 : 0
1)                                 12: Illegal play (1;0;1;0;1;doright;Deb22;0;0;0;1;0;0;-2;-2;0;0;0;4;0;3;0;0;0;-4;4;0;0;0;-3;0;-4;0;0;0;2;2;0;6;4;)
2) 64: 24/18 18/14                 43: 24/20 23/20`;

const NACK_PLAYER2_FIRST = `1 point match

Game 1
langdon79 : 0                       William8 : 0
1) 12: Illegal play (1;0;1;0;0;William8;langdon79;0;0;0;1;0;0;-2;-2;0;0;0;4;0;3;0;0;0;-4;4;0;0;0;-3;0;-4;0;0;0;2;2;0;6;1;) 61: 13/7 8/7
2) 31: 8/5 6/5                     62: 23/21 13/7`;

describe('BackgammonParser', () => {
    let parser;

    beforeEach(() => {
        parser = new BackgammonParser();
    });

    describe('parseMatch()', () => {
        it('parses match length', () => {
            const match = parser.parseMatch(SAMPLE_MATCH);
            expect(match.matchLength).toBe(5);
        });

        it('extracts player names', () => {
            const match = parser.parseMatch(SAMPLE_MATCH);
            expect(match.players.player1).toBe('Alice');
            expect(match.players.player2).toBe('Bob');
        });

        it('parses the correct number of games', () => {
            const match = parser.parseMatch(SAMPLE_MATCH);
            expect(match.games).toHaveLength(2);
        });

        it('parses starting scores per game', () => {
            const match = parser.parseMatch(SAMPLE_MATCH);
            expect(match.games[0].startingScore).toEqual({ player1: 0, player2: 0 });
            expect(match.games[1].startingScore).toEqual({ player1: 2, player2: 0 });
        });

        it('parses moves within a game', () => {
            const match = parser.parseMatch(SAMPLE_MATCH);
            const game1 = match.games[0];
            expect(game1.moves.length).toBeGreaterThanOrEqual(3);
            expect(game1.moves[0].moveNumber).toBe(1);
        });

        it('handles match with winner line', () => {
            const match = parser.parseMatch(MATCH_WITH_WIN);
            expect(match.matchLength).toBe(3);
            expect(match.games).toHaveLength(1);
        });

        it('detects Nackgammon and removes a player-2 marker-only line', () => {
            const match = parser.parseMatch(NACK_PLAYER1_FIRST);

            expect(match.variant).toBe('nackgammon');
            expect(match.games[0].variant).toBe('nackgammon');
            expect(match.games[0].moves).toHaveLength(1);
            expect(match.games[0].moves[0].moveNumber).toBe(2);
            expect(match.games[0].moves[0].player1.dice).toMatchObject({ die1: 6, die2: 4 });
        });

        it('preserves a player-2 opening move following a player-1 marker', () => {
            const match = parser.parseMatch(NACK_PLAYER2_FIRST);
            const opening = match.games[0].moves[0];

            expect(match.variant).toBe('nackgammon');
            expect(opening.moveNumber).toBe(1);
            expect(opening.player1).toEqual({ type: 'no_move' });
            expect(opening.player2.dice).toMatchObject({ die1: 6, die2: 1 });
            expect(opening.player2.moves).toEqual([
                { from: 13, to: 7, hit: false },
                { from: 8, to: 7, hit: false }
            ]);
        });

        it('does not treat other illegal-play text as the Nackgammon marker', () => {
            const match = parser.parseMatch(`1 point match\nGame 1\nAlice : 0  Bob : 0\n1) 34: Illegal play`);
            expect(match.variant).toBe('backgammon');
            expect(match.games[0].variant).toBe('backgammon');
        });
    });

    describe('parseMoveLine()', () => {
        it('parses a line with two player moves', () => {
            const result = parser.parseMoveLine('1) 31: 8/5 6/5                    42: 24/20 13/11');
            expect(result).not.toBeNull();
            expect(result.moveNumber).toBe(1);
            expect(result.player1.type).toBe('move');
            expect(result.player2.type).toBe('move');
        });

        it('returns null for non-move lines', () => {
            expect(parser.parseMoveLine('Game 1')).toBeNull();
            expect(parser.parseMoveLine('Alice : 0  Bob : 0')).toBeNull();
        });
    });

    describe('parsePlayerMove()', () => {
        it('parses a regular move with dice', () => {
            const result = parser.parsePlayerMove('31: 8/5 6/5');
            expect(result.type).toBe('move');
            expect(result.dice).toEqual({ die1: 3, die2: 1, isDouble: false, total: 4 });
            expect(result.moves).toHaveLength(2);
        });

        it('parses doubles', () => {
            const result = parser.parsePlayerMove('Doubles => 2');
            expect(result.type).toBe('double');
            expect(result.value).toBe(2);
        });

        it('parses takes', () => {
            expect(parser.parsePlayerMove('Takes').type).toBe('take');
        });

        it('parses drops', () => {
            expect(parser.parsePlayerMove('Drops').type).toBe('drop');
        });

        it('parses wins', () => {
            const result = parser.parsePlayerMove('Wins 2 points');
            expect(result.type).toBe('win');
            expect(result.points).toBe(2);
        });

        it('returns no_move for empty string', () => {
            expect(parser.parsePlayerMove('').type).toBe('no_move');
        });
    });

    describe('parseDice()', () => {
        it('parses normal dice', () => {
            expect(parser.parseDice('31')).toEqual({
                die1: 3, die2: 1, isDouble: false, total: 4
            });
        });

        it('detects doubles', () => {
            expect(parser.parseDice('66')).toEqual({
                die1: 6, die2: 6, isDouble: true, total: 12
            });
        });

        it('returns null for invalid dice', () => {
            expect(parser.parseDice('1')).toBeNull();
        });
    });

    describe('parseMoves()', () => {
        it('parses simple moves', () => {
            const result = parser.parseMoves('13/7 8/7');
            expect(result).toEqual([
                { from: 13, to: 7, hit: false },
                { from: 8, to: 7, hit: false }
            ]);
        });

        it('parses hit moves', () => {
            const result = parser.parseMoves('24/21*');
            expect(result).toEqual([{ from: 24, to: 21, hit: true }]);
        });

        it('parses bar entry', () => {
            const result = parser.parseMoves('bar/21');
            expect(result).toEqual([{ from: 25, to: 21, hit: false }]);
        });

        it('parses bear off', () => {
            const result = parser.parseMoves('6/off');
            expect(result).toEqual([{ from: 6, to: 0, hit: false }]);
        });

        it('returns empty array for empty input', () => {
            expect(parser.parseMoves('')).toEqual([]);
            expect(parser.parseMoves(null)).toEqual([]);
        });
    });

    describe('parseGameResult()', () => {
        it('parses win with points', () => {
            const result = parser.parseGameResult('Wins 2 points');
            expect(result.points).toBe(2);
            expect(result.isMatchEnd).toBe(false);
        });

        it('detects match end', () => {
            const result = parser.parseGameResult('Wins 1 point and the match');
            expect(result.points).toBe(1);
            expect(result.isMatchEnd).toBe(true);
        });
    });

    describe('edge cases', () => {
        it('handles empty input', () => {
            const match = parser.parseMatch('');
            expect(match.games).toEqual([]);
            expect(match.matchLength).toBeNull();
        });

        it('handles input with only match length', () => {
            const match = parser.parseMatch('7 point match');
            expect(match.matchLength).toBe(7);
            expect(match.games).toEqual([]);
        });
    });
});
