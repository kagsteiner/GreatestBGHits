'use strict';

const { countingResults, describeCube, describeMove, differences, games, gradeLabel, severity } = require('../shared/analysisText');

const evaluation = (win, gammonWin, backgammonWin, gammonLoss, backgammonLoss) => ({
    win, gammonWin, backgammonWin, gammonLoss, backgammonLoss
});

describe('games()', () => {
    it('turns an equity amount into a simple fraction of a game', () => {
        expect(games(0.2)).toBe('about 1/5 of a game');
        expect(games(0.063)).toBe('about 1/15 of a game');
        expect(games(0.5)).toBe('about half a game');
        expect(games(0.97)).toBe('about a whole game');
        expect(games(1.6)).toBe('about 1½ games');
        expect(games(2.1)).toBe('about 2 games');
        expect(games(0.003)).toBe('a tiny fraction of a game');
    });

    it('names the size of a mistake like the app grades it, with doubling levels above a blunder', () => {
        expect(severity(0.001)).toBe('practically as good as the best');
        expect(severity(0.01)).toBe('a tiny inaccuracy');
        expect(severity(0.03)).toBe('a small mistake');
        expect(severity(0.06)).toBe('a clear mistake');
        expect(severity(0.1)).toBe('a blunder');
        expect(severity(0.2)).toBe('a big blunder');
        expect(severity(0.46)).toBe('a severe blunder');
        expect(severity(0.9)).toBe('a disastrous blunder');
    });

    it('gives the short labels for flagged mistakes', () => {
        expect(gradeLabel(0.02)).toBeNull();
        expect(gradeLabel(0.021)).toBe('Doubtful');
        expect(gradeLabel(0.063)).toBe('Error');
        expect(gradeLabel(0.087)).toBe('Blunder');
        expect(gradeLabel(0.213)).toBe('Big blunder');
        expect(gradeLabel(0.547)).toBe('Severe blunder');
        expect(gradeLabel(0.7)).toBe('Disastrous blunder');
    });
});

describe('differences()', () => {
    it('keeps the noticeable differences, the most valuable first, marked good or bad', () => {
        const yours = evaluation(0.596, 0.332, 0.024, 0.073, 0.002);
        const best = evaluation(0.628, 0.335, 0.018, 0.075, 0.003);
        expect(differences(yours, best)).toEqual([
            expect.objectContaining({ text: 'wins noticeably fewer games', good: false }),
            expect.objectContaining({ text: 'wins a few more backgammons', good: true })
        ]);
    });

    it('ignores negligible differences', () => {
        expect(differences(evaluation(0.5, 0.1, 0, 0.1, 0), evaluation(0.505, 0.102, 0.001, 0.099, 0))).toEqual([]);
    });
});

describe('describeMove()', () => {
    const best = { move: '13/9(2) 6/2* 5/1*', equity: 0.256, evaluation: evaluation(0.628, 0.335, 0.018, 0.075, 0.003) };

    it('names the mistake in games and the key differences, with "but" for a trade-off', () => {
        const played = { move: '22/18 10/2* 6/2', equity: 0.193, evaluation: evaluation(0.596, 0.332, 0.024, 0.073, 0.002) };
        expect(describeMove({ played, best })).toEqual([
            'Your play is a clear mistake: it costs about 1/15 of a game compared with 13/9(2) 6/2* 5/1*.',
            'Compared with 13/9(2) 6/2* 5/1*, your play wins noticeably fewer games, but wins a few more backgammons.'
        ]);
    });

    it('counts the amount in points but grades the size as during play, per unit of the cube', () => {
        const played = { move: '24/18', equity: 0.226, evaluation: best.evaluation };
        expect(describeMove({ played, best, cube: 4 })[0]).toBe(
            'Your play is a small mistake: it costs about 1/8 of a game with the cube on 4 compared with 13/9(2) 6/2* 5/1*.'
        );
    });

    it('praises the best play and names the next best', () => {
        expect(describeMove({ played: best, best, next: { move: '22/18 13/9(3)', equity: 0.255 } })).toEqual([
            'You found the best play.',
            '22/18 13/9(3) is practically as good.'
        ]);
        expect(describeMove({ played: best, best, next: { move: '24/14', equity: 0.15 } })[1])
            .toBe('The next best, 24/14, would cost about 1/10 of a game.');
    });

    it('lets parts with the same verb share it', () => {
        const played = { move: '13/2', equity: 0.13, evaluation: evaluation(0.58, 0.29, 0.018, 0.085, 0.003) };
        expect(describeMove({ played, best })[1]).toBe(
            'Compared with 13/9(2) 6/2* 5/1*, your play wins noticeably fewer games and clearly fewer gammons,'
            + ' and gets gammoned a little more often.'
        );
    });

    it('explains a difference that does not show in the probabilities', () => {
        const played = { move: '8/4(2)', equity: 0.2, evaluation: best.evaluation };
        expect(describeMove({ played, best })[1]).toMatch('hardly differ');
    });
});

describe('countingResults()', () => {
    it('counts every result in money play', () => {
        expect(countingResults(4)).toEqual({
            win: true, gammonWin: true, backgammonWin: true, gammonLoss: true, backgammonLoss: true
        });
    });

    it('drops gammons the winner does not need, at the cube value', () => {
        // 2-away vs 4-away, cube on 2: your gammons add nothing; the opponent's do, backgammons not.
        expect(countingResults(2, { away: 2, opponentAway: 4 })).toEqual({
            win: true, gammonWin: false, backgammonWin: false, gammonLoss: true, backgammonLoss: false
        });
        // 3-away vs 1-away (Crawford): gammons count for you, backgammons only as gammons.
        expect(countingResults(1, { away: 3, opponentAway: 1 })).toEqual({
            win: true, gammonWin: true, backgammonWin: true, gammonLoss: false, backgammonLoss: false
        });
        expect(countingResults(1, { away: 2, opponentAway: 4 }).backgammonWin).toBe(false);
    });
});

describe('describeMove() at a match score', () => {
    const best = { move: '13/9(2) 6/2* 5/1*', equity: 0.256, evaluation: evaluation(0.628, 0.335, 0.018, 0.075, 0.003) };
    const played = { move: '13/2', equity: 0.13, evaluation: evaluation(0.58, 0.29, 0.018, 0.085, 0.003) };

    it('leaves out gammons that do not count and says so', () => {
        // Double match point: only winning the game matters.
        expect(describeMove({ played, best, score: { away: 1, opponentAway: 1 } }).slice(1)).toEqual([
            'Compared with 13/9(2) 6/2* 5/1*, your play wins noticeably fewer games.',
            'At this match score, gammon wins and gammon losses count only as single games, so differences in them do not matter.'
        ]);
    });

    it('keeps the gammons that still count', () => {
        // You need 1 point, the opponent 4: only your gammons are worthless.
        expect(describeMove({ played, best, score: { away: 1, opponentAway: 4 } }).slice(1)).toEqual([
            'Compared with 13/9(2) 6/2* 5/1*, your play wins noticeably fewer games and gets gammoned a little more often.',
            'At this match score, gammon wins count only as single games, so differences in them do not matter.'
        ]);
    });

    it('says when backgammons count only as gammons', () => {
        const backgammons = { move: '24/20', equity: 0.2, evaluation: evaluation(0.628, 0.335, 0.03, 0.075, 0.003) };
        expect(describeMove({ played: backgammons, best, score: { away: 2, opponentAway: 7 } }).slice(1)).toEqual([
            'The chances of winning hardly differ: the difference lies in how the game goes on from here.',
            'At this match score, backgammon wins count only as gammons, so differences in them do not matter.'
        ]);
    });
});

describe('describeCube()', () => {
    it('does not blame a take on gammons that do not count after the take', () => {
        const analysis = {
            equity: { noDouble: 0.83, doubleTake: 1.21, doublePass: 1 },
            evaluation: evaluation(0.665, 0.39, 0.016, 0.107, 0.009)
        };
        // The doubler needs 2 points: on a 2-cube a gammon gives nothing extra.
        expect(describeCube({ step: 'take', who: 'you', analysis, score: { away: 2, opponentAway: 5 } })).toEqual([
            'You should have passed. Taking costs about 1/5 of a game: too few games are won after taking.',
            'The engine is a clear favourite.'
        ]);
    });

    it('explains a wrong take with its cost and the reason', () => {
        const analysis = {
            equity: { noDouble: 0.83, doubleTake: 1.21, doublePass: 1 },
            evaluation: evaluation(0.665, 0.39, 0.016, 0.107, 0.009)
        };
        expect(describeCube({ step: 'take', who: 'you', analysis })).toEqual([
            'You should have passed. Taking costs about 1/5 of a game: the doubler wins too many gammons.',
            'The engine is a clear favourite, with real gammon chances.'
        ]);
    });

    it('confirms a right no-double and recognises "too good"', () => {
        const early = { equity: { noDouble: 0.3, doubleTake: 0.2, doublePass: 1 }, evaluation: evaluation(0.58, 0.12, 0, 0.08, 0) };
        expect(describeCube({ step: 'no-double', who: 'you', analysis: early })).toEqual([
            'Right: it is too early to double.',
            'You are a slight favourite.'
        ]);
        const tooGood = { equity: { noDouble: 1.3, doubleTake: 1.8, doublePass: 1 }, evaluation: evaluation(0.9, 0.5, 0.02, 0.01, 0) };
        expect(describeCube({ step: 'no-double', who: 'you', analysis: tooGood })[0])
            .toBe('Right: too good to double, playing on for a gammon is worth more.');
    });

    it('explains a correct double without a clear advantage by the match score', () => {
        const analysis = { equity: { noDouble: 0.1, doubleTake: 0.2, doublePass: 1 }, evaluation: evaluation(0.5, 0.15, 0.01, 0.13, 0.01) };
        expect(describeCube({ step: 'double', who: 'you', analysis })).toEqual([
            'Right: doubling is correct, and the opponent should take.',
            'The game is about even, but at this match score the cube is worth using early.'
        ]);
    });

    it('names a missed double and the right answer', () => {
        const analysis = { equity: { noDouble: 0.6, doubleTake: 0.75, doublePass: 1 }, evaluation: evaluation(0.7, 0.2, 0.01, 0.05, 0) };
        expect(describeCube({ step: 'no-double', who: 'you', analysis, cube: 2 })[0])
            .toBe('You should have doubled, and the opponent should take. Waiting costs about 1/3 of a game with the cube on 2.');
    });
});
