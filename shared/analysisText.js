(function exposeAnalysisText(root, factory) {
    const analysisText = factory();
    if (typeof module === 'object' && module.exports) module.exports = analysisText;
    else root.analysisText = analysisText;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createAnalysisText() {
    'use strict';

    // Plain-language comparison of the player's decision with the best one.
    // No numbers except amounts in "games" (one game = one point at stake):
    // the equity difference becomes a fraction of a game, and differences in
    // winning chances, gammons and backgammons become words like "slightly"
    // or "a few". Probabilities are from the view of the player on roll and
    // cumulative (gammons include backgammons), as the engine reports them.

    const FRACTIONS = [
        [1 / 100, '1/100'], [1 / 50, '1/50'], [1 / 30, '1/30'], [1 / 20, '1/20'], [1 / 15, '1/15'],
        [1 / 10, '1/10'], [1 / 8, '1/8'], [1 / 6, '1/6'], [1 / 5, '1/5'], [1 / 4, '1/4'], [1 / 3, '1/3'],
        [2 / 5, '2/5'], [1 / 2, 'half'], [3 / 5, '3/5'], [2 / 3, '2/3'], [3 / 4, '3/4'], [4 / 5, '4/5'], [1, 'a whole']
    ];

    /** An amount in games: "about 1/5 of a game", "about half a game", "about 1½ games". */
    function games(amount) {
        const value = Math.abs(amount);
        if (value < 0.007) return 'a tiny fraction of a game';
        if (value <= 1.1) {
            let best = FRACTIONS[0];
            for (const candidate of FRACTIONS) {
                // Compare on a log scale, so 1/15 and 1/20 are told apart as well as 1/2 and 2/3.
                if (Math.abs(Math.log(candidate[0] / value)) < Math.abs(Math.log(best[0] / value))) best = candidate;
            }
            if (best[1] === 'half') return 'about half a game';
            if (best[1] === 'a whole') return 'about a whole game';
            return `about ${best[1]} of a game`;
        }
        const halves = Math.round(value * 2) / 2;
        const whole = Math.floor(halves);
        return `about ${whole}${halves > whole ? '½' : ''} games`;
    }

    // Mistake levels by equity loss per unit of the cube. Up to "blunder"
    // they match the grading during play (doubtful > 0.02, error > 0.04,
    // blunder > 0.08); above it each level doubles, as from 0.02 upwards.
    const LEVELS = [
        { above: 0.64, label: 'Disastrous blunder', words: 'a disastrous blunder' },
        { above: 0.32, label: 'Severe blunder', words: 'a severe blunder' },
        { above: 0.16, label: 'Big blunder', words: 'a big blunder' },
        { above: 0.08, label: 'Blunder', words: 'a blunder' },
        { above: 0.04, label: 'Error', words: 'a clear mistake' },
        { above: 0.02, label: 'Doubtful', words: 'a small mistake' }
    ];

    /** How serious an equity loss (per unit of the cube) is, in words. */
    function severity(loss) {
        if (loss < 0.005) return 'practically as good as the best';
        const level = LEVELS.find((entry) => loss > entry.above);
        return level ? level.words : 'a tiny inaccuracy';
    }

    /** The short label of a flagged mistake ("Error", "Big blunder"), or null below "doubtful". */
    function gradeLabel(loss) {
        const level = LEVELS.find((entry) => loss > entry.above);
        return level ? level.label : null;
    }

    // Each kind of result: how much it is worth (a game won or lost changes
    // the result by two games relative to each other, extra gammons and
    // backgammons by one more), from when a difference counts, and the words.
    const ASPECTS = [
        {
            field: 'win', worth: 2, good: 1,
            levels: [[0.01, null], [0.03, 'slightly'], [0.07, 'noticeably'], [Infinity, 'far']],
            verb: 'wins', words: (level, more) => `${level} ${more ? 'more' : 'fewer'} games`
        },
        {
            field: 'gammonWin', worth: 1, good: 1,
            levels: [[0.005, null], [0.02, 'a few'], [0.05, 'clearly'], [Infinity, 'many']],
            verb: 'wins', words: (level, more) => `${level} ${more ? 'more' : 'fewer'} gammons`
        },
        {
            field: 'backgammonWin', worth: 1, good: 1,
            levels: [[0.003, null], [0.01, 'a few'], [Infinity, 'clearly']],
            verb: 'wins', words: (level, more) => `${level} ${more ? 'more' : 'fewer'} backgammons`
        },
        {
            field: 'gammonLoss', worth: 1, good: -1,
            levels: [[0.005, null], [0.02, 'a little'], [0.05, 'noticeably'], [Infinity, 'much']],
            verb: 'gets gammoned', words: (level, more) => `${level} ${more ? 'more' : 'less'} often`
        },
        {
            field: 'backgammonLoss', worth: 1, good: -1,
            levels: [[0.003, null], [0.01, 'a little'], [Infinity, 'noticeably']],
            verb: 'gets backgammoned', words: (level, more) => `${level} ${more ? 'more' : 'less'} often`
        }
    ];

    /**
     * Which results are worth more than a single game at the match score.
     * A gammon adds nothing when the winner needs no more points than the
     * cube is worth, a backgammon nothing over a gammon when the winner needs
     * no more than twice that. The cube only goes up, so a result that does
     * not count now never will. Without a score (money play) all count.
     *
     * @param {{ away: number, opponentAway: number }|null} score points each
     *   side still needs, from the view of the player the evaluation is for
     */
    function countingResults(cube = 1, score = null) {
        const needs = (away) => (Number.isFinite(away) && away > 0 ? away : Infinity);
        const mine = needs(score?.away);
        const theirs = needs(score?.opponentAway);
        return {
            win: true,
            gammonWin: mine > cube,
            backgammonWin: mine > 2 * cube,
            gammonLoss: theirs > cube,
            backgammonLoss: theirs > 2 * cube
        };
    }

    const NOT_COUNTING = {
        gammonWin: 'gammon wins', backgammonWin: 'backgammon wins',
        gammonLoss: 'gammon losses', backgammonLoss: 'backgammon losses'
    };

    /**
     * The noticeable differences between two evaluations (yours minus the
     * reference), most valuable first, each marked as good or bad for you.
     * Results that do not count at the score (see countingResults) are left
     * out; `ignored` collects the fields of those that would have been noticeable.
     */
    function differences(yours, reference, limit = 3, counting = countingResults(), ignored = []) {
        if (!yours || !reference) return [];
        const found = [];
        for (const aspect of ASPECTS) {
            const delta = (yours[aspect.field] ?? 0) - (reference[aspect.field] ?? 0);
            const size = Math.abs(delta);
            const level = aspect.levels.find(([below]) => size < below)[1];
            if (!level) continue;
            if (!counting[aspect.field]) {
                ignored.push(aspect.field);
                continue;
            }
            found.push({
                verb: aspect.verb,
                object: aspect.words(level, delta > 0),
                text: `${aspect.verb} ${aspect.words(level, delta > 0)}`,
                good: delta * aspect.good > 0,
                weight: size * aspect.worth
            });
        }
        return found.sort((a, b) => b.weight - a.weight).slice(0, limit);
    }

    /** An amount in points, saying why it is larger when the cube is up. */
    function stake(amount, cube) {
        return `${games(amount)}${cube > 1 ? ` with the cube on ${cube}` : ''}`;
    }

    function list(parts) {
        if (parts.length <= 1) return parts.join('');
        return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
    }

    /**
     * "wins fewer games and fewer gammons, and gets gammoned more often":
     * parts with the same verb share it.
     */
    function phrase(entries) {
        const groups = [];
        for (const entry of entries) {
            const group = groups.find((candidate) => candidate.verb === entry.verb);
            if (group) group.objects.push(entry.object);
            else groups.push({ verb: entry.verb, objects: [entry.object] });
        }
        const texts = groups.map((group) => `${group.verb} ${list(group.objects)}`);
        if (texts.length <= 1) return texts.join('');
        const nested = groups.some((group) => group.objects.length > 1);
        return nested
            ? `${texts.slice(0, -1).join(', ')}, and ${texts[texts.length - 1]}`
            : list(texts);
    }

    /** "your play wins fewer games, but gets gammoned less often" */
    function contrast(subject, found) {
        const bad = found.filter((entry) => !entry.good);
        const good = found.filter((entry) => entry.good);
        if (bad.length && good.length) return `${subject} ${phrase(bad)}, but ${phrase(good)}`;
        return `${subject} ${phrase(bad.length ? bad : good)}`;
    }

    /**
     * @param {{ played: { move: string, equity: number, evaluation?: object },
     *   best: { move: string, equity: number, evaluation?: object },
     *   next?: { move: string, equity: number }, cube?: number,
     *   score?: { away: number, opponentAway: number } }} comparison
     *   equities per unit of the cube; `next` is the second best when you found the best;
     *   `score` is the points each side needs, yours first (none for money play)
     * @returns {string[]} sentences
     */
    function describeMove({ played, best, next, cube = 1, score = null }) {
        const sentences = [];
        if (!played || !best) return sentences;
        const loss = Math.max(0, (best.equity - played.equity) * cube);
        if (played.move === best.move) {
            sentences.push('You found the best play.');
            if (next) {
                const gap = Math.max(0, (best.equity - next.equity) * cube);
                sentences.push(gap < 0.005
                    ? `${next.move} is practically as good.`
                    : `The next best, ${next.move}, would cost ${stake(gap, cube)}.`);
            }
            return sentences;
        }
        // The size is graded per unit of the cube, as during play; the amount is in points.
        const graded = loss / cube;
        if (graded < 0.005) {
            sentences.push(`Your play is practically as good as the best play, ${best.move}.`);
        } else {
            sentences.push(`Your play is ${severity(graded)}: it costs ${stake(loss, cube)} compared with ${best.move}.`);
        }
        const ignored = [];
        const counting = countingResults(cube, score);
        const found = differences(played.evaluation, best.evaluation, 3, counting, ignored);
        if (found.length) {
            sentences.push(`${contrast(`Compared with ${best.move}, your play`, found)}.`);
        } else if (graded >= 0.02 && !ignored.length) {
            sentences.push('The chances of winning, gammons and backgammons hardly differ: the difference lies in how the game goes on from here.');
        } else if (graded >= 0.02) {
            sentences.push('The chances of winning hardly differ: the difference lies in how the game goes on from here.');
        }
        if (ignored.length) sentences.push(notCounting(ignored, counting));
        return sentences;
    }

    /**
     * "At this match score, gammon wins count only as single games and
     * backgammon losses only as gammons, so differences in them do not matter."
     */
    function notCounting(fields, counting) {
        // When the gammon does not count either, a backgammon is a single game too.
        const asSingle = new Set();
        const asGammon = new Set();
        for (const field of fields) {
            const gammon = field.replace(/^backgammon/, 'gammon');
            if (!counting[gammon]) asSingle.add(gammon);
            else asGammon.add(field);
        }
        const names = (set) => list([...set].map((field) => NOT_COUNTING[field]));
        const parts = [];
        if (asSingle.size) parts.push(`${names(asSingle)} count only as single games`);
        if (asGammon.size) parts.push(`${names(asGammon)} ${asSingle.size ? 'only' : 'count only'} as gammons`);
        return `At this match score, ${parts.join(' and ')}, so differences in them do not matter.`;
    }

    function standing(evaluation, doubler, gammonsCount = true) {
        if (!evaluation) return null;
        const win = evaluation.win;
        let text;
        if (win >= 0.85) text = 'a huge favourite';
        else if (win >= 0.75) text = 'a big favourite';
        else if (win >= 0.65) text = 'a clear favourite';
        else if (win >= 0.55) text = 'a slight favourite';
        else if (win > 0.45) text = 'about even';
        else if (win > 0.35) text = 'a slight underdog';
        else text = 'a clear underdog';
        // About 15% of games from the starting position end in a gammon for
        // each side (engine rollout), so only clearly more is worth a mention.
        const gammons = !gammonsCount ? ''
            : (evaluation.gammonWin >= 0.4 ? ', with lots of gammon chances'
                : (evaluation.gammonWin >= 0.25 ? ', with real gammon chances' : ''));
        if (text === 'about even') return `The game is about even${gammons}`;
        return doubler === 'you' ? `You are ${text}${gammons}` : `The engine is ${text}${gammons}`;
    }

    /**
     * A cube decision, from one cube analysis (equities from the doubler's
     * view, per unit of the cube before doubling).
     *
     * @param {{ step: 'no-double'|'double'|'take'|'pass', who: 'you'|'engine',
     *   analysis: { equity: { noDouble: number, doubleTake: number, doublePass: number }, evaluation?: object },
     *   cube?: number, score?: { away: number, opponentAway: number } }} decision
     *   `score` is the points each side needs, the doubler's first (none for money play)
     * @returns {string[]} sentences
     */
    function describeCube({ step, who, analysis, cube = 1, score = null }) {
        const { noDouble: nd, doubleTake: dt, doublePass: dp } = analysis.equity;
        const doubled = Math.min(dt, dp);
        const shouldDouble = doubled > nd;
        const tooGood = !shouldDouble && nd > dp;
        const shouldTake = dt <= dp;
        const evaluation = analysis.evaluation;
        const answer = shouldTake ? 'take' : 'pass';
        const sentences = [];
        const you = who === 'you';

        if (step === 'no-double' || step === 'double') {
            const doubledIt = step === 'double';
            const subject = you ? 'You' : 'The engine';
            if (doubledIt === shouldDouble) {
                sentences.push(doubledIt
                    ? `Right: doubling is correct, and the opponent should ${answer}.`
                    : (tooGood ? 'Right: too good to double, playing on for a gammon is worth more.' : 'Right: it is too early to double.'));
            } else if (doubledIt) {
                const cost = (nd - doubled) * cube;
                sentences.push(tooGood
                    ? `${subject} should have played on: too good to double. Doubling gives away ${stake(cost, cube)}.`
                    : `Doubling was premature: it costs ${stake(cost, cube)}.`);
            } else {
                const cost = (doubled - nd) * cube;
                sentences.push(`${subject} should have doubled, and the opponent should ${answer}. Waiting costs ${stake(cost, cube)}.`);
            }
        } else {
            const tookIt = step === 'take';
            const subject = you ? 'You' : 'The engine';
            if (tookIt === shouldTake) {
                const other = Math.abs(dp - dt) * cube;
                sentences.push(`Right: this is a ${answer}.${other >= 0.005 ? ` ${tookIt ? 'Passing' : 'Taking'} would cost ${stake(other, cube)}.` : ' It is a close call.'}`);
            } else {
                const cost = Math.abs(dt - dp) * cube;
                // After the take the cube is doubled: do the doubler's gammons still count?
                const doublerGammons = countingResults(2 * cube, score).gammonWin ? (evaluation?.gammonWin ?? 0) : 0;
                const doublerWins = evaluation?.win ?? 0;
                let reason = '';
                if (tookIt) {
                    reason = doublerGammons >= 0.25 ? ': the doubler wins too many gammons' : ': too few games are won after taking';
                } else {
                    reason = doublerWins <= 0.75 ? ': enough games are still won after taking' : '';
                }
                sentences.push(tookIt
                    ? `${subject} should have passed. Taking costs ${stake(cost, cube)}${reason}.`
                    : `${subject} should have taken. Passing gives away ${stake(cost, cube)}${reason}.`);
            }
        }
        const doubler = step === 'no-double' || step === 'double' ? who : (you ? 'engine' : 'you');
        // Gammons matter at the cube the decision leads to: doubled, unless not doubling.
        const atCube = step === 'no-double' ? cube : 2 * cube;
        const position = standing(evaluation, doubler, countingResults(atCube, score).gammonWin);
        if (position) {
            // Doubling without being a clear favourite is right only because of the match score.
            const early = shouldDouble && evaluation && evaluation.win < 0.6;
            sentences.push(early ? `${position}, but at this match score the cube is worth using early.` : `${position}.`);
        }
        return sentences;
    }

    return { countingResults, describeCube, describeMove, differences, games, gradeLabel, severity };
}));
