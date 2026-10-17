'use strict';

const BackgammonParser = require('../backgammon-parser');
const { formatMove, matchToMat } = require('../src/matExport');

const MATCH = {
    length: 3,
    opponent: 'DarkBGHelmet',
    games: [
        {
            number: 1,
            score: { you: 0, engine: 0 },
            crawford: false,
            log: [
                { type: 'opening', you: 3, engine: 5 },
                { type: 'move', who: 'engine', dice: { die1: 5, die2: 3 }, move: '8/3 6/3' },
                { type: 'grade', kind: 'cube', action: 'No double', loss: 0, grade: null },
                { type: 'roll', who: 'you', dice: { die1: 6, die2: 4 } },
                { type: 'move', who: 'you', dice: { die1: 6, die2: 4 }, move: '24/14' },
                { type: 'double', who: 'engine', cube: 2 },
                { type: 'take', who: 'you' },
                { type: 'move', who: 'engine', dice: { die1: 3, die2: 3 }, move: '24/21*(2) 13/10(2)' },
                { type: 'move', who: 'you', dice: { die1: 2, die2: 1 }, move: '', forced: true },
                { type: 'game-over', winner: 'engine', points: 2, kind: 'single' }
            ]
        },
        {
            number: 2,
            score: { you: 0, engine: 2 },
            crawford: true,
            log: [
                { type: 'move', who: 'you', dice: { die1: 6, die2: 5 }, move: '24/13' },
                { type: 'move', who: 'engine', dice: { die1: 6, die2: 6 }, move: 'bar/19/13' },
                { type: 'game-over', winner: 'engine', points: 1, kind: 'single' }
            ]
        }
    ]
};

describe('formatMove()', () => {
    it('writes single checker moves with bar, off, hits and doubled dice', () => {
        expect(formatMove({ die1: 6, die2: 4 }, '24/14')).toBe('64: 24/14');
        expect(formatMove({ die1: 3, die2: 3 }, '24/21*(2) 13/10(2)')).toBe('33: 24/21* 24/21 13/10 13/10');
        expect(formatMove({ die1: 6, die2: 6 }, 'bar/19/13')).toBe('66: bar/19 19/13');
        expect(formatMove({ die1: 5, die2: 2 }, '6/off 2/off')).toBe('52: 6/off 2/off');
        expect(formatMove({ die1: 2, die2: 1 }, '')).toBe('21:');
    });
});

describe('matchToMat()', () => {
    it('writes the games in match-file columns', () => {
        expect(matchToMat(MATCH, 'Karl')).toBe([
            ' 3 point match',
            '',
            ' Game 1',
            ' Karl : 0                         DarkBGHelmet : 0',
            '  1)                              53: 8/3 6/3',
            '  2) 64: 24/14                    Doubles => 2',
            '  3) Takes                        33: 24/21* 24/21 13/10 13/10',
            '  4) 21:',
            '                                   Wins 2 points',
            '',
            ' Game 2',
            ' Karl : 0                         DarkBGHelmet : 2',
            '  1) 65: 24/13                    66: bar/19 19/13',
            '                                   Wins 1 point and the match',
            '',
            ''
        ].join('\n'));
    });

    it('can be read back by the DailyGammon match parser', () => {
        const parsed = new BackgammonParser().parseMatch(matchToMat(MATCH, 'Karl'));
        expect(parsed.matchLength).toBe(3);
        expect(parsed.players).toEqual({ player1: 'Karl', player2: 'DarkBGHelmet' });
        expect(parsed.games).toHaveLength(2);
        expect(parsed.games[1].startingScore).toEqual({ player1: 0, player2: 2 });
        expect(parsed.games[0].moves[1].player2).toMatchObject({ type: 'double' });
        expect(parsed.games[0].moves[2].player1).toMatchObject({ type: 'take' });
    });
});
