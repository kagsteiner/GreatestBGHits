'use strict';

const BackgammonBoard = require('../src/board');
const checkerPlay = require('../shared/checkerPlay');
const { FriendError, FriendTable, rollsWithChances } = require('../src/friendMatch');

function scriptedDice(values) {
    const queue = values.slice();
    return () => {
        if (!queue.length) throw new Error('Out of scripted dice');
        return queue.shift();
    };
}

const cubeAnswer = (overrides = {}) => ({
    available: true, decision: 'No double, take', take: 'take',
    noDoubleEquity: 0.1, doubleTakeEquity: 0.05, doublePassEquity: 1, ...overrides
});

/**
 * A fake engine: every roll has the legal plays "13/8 6/5" (best) and
 * "24/18 13/8"; the static equity after the best play of a roll is the sum
 * of its dice / 100, so a roll's luck is (sum - 7) / 100.
 */
function fakeEngine({ cube = () => cubeAnswer(), plays = () => ['13/8 6/5', '24/18 13/8'], allEqual = () => false } = {}) {
    const calls = [];
    const positionOf = (ogid) => {
        const board = BackgammonBoard.fromOgid(ogid);
        return checkerPlay.positionFromBoard(board, board.turn);
    };
    return {
        calls,
        async listLegalPlays({ ogid }) {
            const position = positionOf(ogid);
            const board = BackgammonBoard.fromOgid(ogid);
            return {
                position,
                dice: [board.dice.die1, board.dice.die2],
                plays: plays().map((move) => ({ move, points: checkerPlay.applyMoveText(position, move) }))
                    .filter((play) => play.points)
            };
        },
        async analyzeChecker({ dice, played, plies }) {
            if (played) {
                calls.push(`rate ${played} at ${plies}`);
                // "13/8 6/5" is best, any other play 0.05 worse - unless every play is worth the same.
                const same = allEqual();
                return {
                    moves: [{ move: '13/8 6/5', equity: 0 }, { move: 'other', equity: same ? 0 : -0.05 }],
                    played: { move: played, diff: played === '13/8 6/5' || same ? 0 : -0.05 }
                };
            }
            calls.push(`luck ${dice.die1}${dice.die2} at ${plies}`);
            return { moves: [{ move: '13/8 6/5', equity: (dice.die1 + dice.die2) / 100 }] };
        },
        async analyzeCube({ player }) {
            calls.push(`cube ${player}`);
            return cube(player);
        }
    };
}

function table(dice, engine = fakeEngine(), store = null) {
    let now = 1_000_000;
    const friends = new FriendTable({ engine, randomInt: scriptedDice(dice), store, now: () => now });
    friends.advance = (ms) => { now += ms; };
    return friends;
}

async function seated(dice, options = {}) {
    const friends = table(dice, options.engine, options.store);
    friends.join('a', 'Karl');
    friends.join('b', 'Fred');
    return friends;
}

describe('rollsWithChances()', () => {
    it('lists the 21 rolls with their chances, and 15 without doubles for the opening', () => {
        const rolls = rollsWithChances(false);
        expect(rolls).toHaveLength(21);
        expect(rolls.reduce((sum, roll) => sum + roll.chance, 0)).toBeCloseTo(1);
        const opening = rollsWithChances(true);
        expect(opening).toHaveLength(15);
        expect(opening.reduce((sum, roll) => sum + roll.chance, 0)).toBeCloseTo(1);
    });
});

describe('seats', () => {
    it('seats two players, refuses a third, and lets a stale seat be taken over', () => {
        const friends = table([]);
        expect(friends.join('a', '  Karl  ').you).toBe('player1');
        expect(friends.join('b', 'Fred').you).toBe('player2');
        expect(() => friends.join('c', 'Eve')).toThrow(FriendError);
        expect(friends.state('c').you).toBeNull();
        expect(friends.state('c').seats.player1).toMatchObject({ name: 'Karl', online: true });

        friends.advance(3 * 60 * 1000);
        friends.state('a');
        const taken = friends.join('c', 'Fred on the phone');
        expect(taken.you).toBe('player2');
        expect(taken.seats.player2.name).toBe('Fred on the phone');
    });

    it('needs a name', () => {
        expect(() => table([]).join('a', '   ')).toThrow('Please enter your name');
    });
});

describe('starting a match', () => {
    it('starts once both chose the same length, with the opening roll', async () => {
        // Opening: Karl 6, Fred 1 -> Karl moves 6-1 first.
        const friends = await seated([6, 1]);
        let state = await friends.chooseLength('a', 5);
        expect(state.match).toBeNull();
        expect(state.seats.player1.wantLength).toBe(5);
        state = await friends.chooseLength('b', 7);
        expect(state.match).toBeNull();
        await friends.chooseLength('b', 5);
        state = friends.state('a');
        expect(state.match).toMatchObject({ length: 5, phase: 'move', onTurn: 'player1', dice: { die1: 6, die2: 1 } });
        expect(state.match.legal.plays).toHaveLength(2);
        expect(state.seats.player1.wantLength).toBeNull();
        // Only the player on roll gets the legal plays.
        expect(friends.state('b').match.legal).toBeNull();
        // Opening 6-1 sums to 7, the average of the opening rolls: no luck.
        expect(state.match.stats.player1.luck).toBe(0);
        expect(state.match.stats.player1.rolls).toBe(1);
    });

    it('refuses other lengths', async () => {
        const friends = await seated([]);
        await expect(friends.chooseLength('a', 9)).rejects.toThrow('Match length must be one of 3, 5, 7');
    });
});

describe('playing', () => {
    async function started(dice, options) {
        const friends = await seated(dice, options);
        await friends.chooseLength('a', 3);
        await friends.chooseLength('b', 3);
        return friends;
    }

    it('grades a move, then lets the other player decide on the cube and roll', async () => {
        const engine = fakeEngine();
        // Opening 6-1 for Karl; Fred then rolls 6-6.
        const friends = await started([6, 1, 6, 6], { engine });
        await expect(friends.act('b', { type: 'roll' })).rejects.toThrow("'roll' is not possible now");

        const key = friends.match.legal.plays.find((play) => play.move === '24/18 13/8').key;
        let state = await friends.act('a', { type: 'move', key });
        expect(state.match.recent.player1[0]).toMatchObject({ action: '24/18 13/8', best: '13/8 6/5', loss: 0.05, grade: 'error' });
        expect(engine.calls).toContain('rate 24/18 13/8 at 3');
        expect(state.match).toMatchObject({ phase: 'turn', onTurn: 'player2' });

        state = await friends.act('b', { type: 'roll' });
        // "No double" was right (0.1 > 0.05) and is graded as such.
        expect(state.match.recent.player2[0]).toMatchObject({ kind: 'cube', action: 'No double', loss: 0 });
        expect(state.match).toMatchObject({ phase: 'move', onTurn: 'player2', dice: { die1: 6, die2: 6 } });
        // 6-6 sums to 12: (12 - 7) / 100 luckier than average, measured at 1-ply.
        expect(state.match.stats.player2.luck).toBe(0.05);
        expect(engine.calls).toContain('luck 66 at 1');
        expect(state.match.events.map((event) => event.type)).toEqual(['opening', 'roll', 'move', 'roll']);
    });

    it('plays a double that is passed, and the next game is the Crawford game', async () => {
        const engine = fakeEngine({ cube: () => cubeAnswer({ decision: 'Double, pass', take: 'pass', noDoubleEquity: 0.8, doubleTakeEquity: 1.2 }) });
        // Opening 6-1 for Karl; Fred leads 1:0 in the 3-point match.
        const friends = await started([6, 1], { engine });
        friends.match.score = { player1: 0, player2: 1 };
        await friends.act('a', { type: 'move', key: friends.match.legal.plays[0].key });
        let state = await friends.act('b', { type: 'double' });
        expect(state.match.recent.player2[0]).toMatchObject({ kind: 'cube', action: 'Double', loss: 0 });
        expect(state.match).toMatchObject({ phase: 'respond', offer: { by: 'player2', to: 'player1', cube: 2 } });
        await expect(friends.act('b', { type: 'pass' })).rejects.toThrow(FriendError);

        state = await friends.act('a', { type: 'pass' });
        expect(state.match.recent.player1[0]).toMatchObject({ kind: 'take', action: 'Pass', loss: 0 });
        expect(state.match.result).toEqual({ winner: 'player2', points: 1, kind: 'pass' });
        expect(state.match).toMatchObject({ phase: 'game-over', score: { player1: 0, player2: 2 }, nextCrawford: true });

        // Either player starts the next game. Opening 1-6: Fred moves first.
        friends.randomInt = scriptedDice([1, 6]);
        state = await friends.act('a', { type: 'next-game' });
        expect(state.match).toMatchObject({ crawford: true, gameNumber: 2, phase: 'move', onTurn: 'player2' });
        expect(state.match.recent).toEqual({ player1: [], player2: [] });
        // In the Crawford game nobody may double: Karl rolls at once after Fred's move.
        friends.randomInt = scriptedDice([3, 1]);
        state = await friends.act('b', { type: 'move', key: friends.match.legal.plays[0].key });
        expect(state.match).toMatchObject({ phase: 'move', onTurn: 'player1', dice: { die1: 3, die2: 1 } });
    });

    it('saves the finished match with PR, luck and the marked decisions', async () => {
        const saved = [];
        const store = { saveMatch: (record) => saved.push(record), markDecisions: jest.fn() };
        let plays = ['13/8 6/5', '24/18 13/8'];
        const engine = fakeEngine({
            plays: () => plays,
            cube: () => cubeAnswer({ decision: 'Double, pass', take: 'pass', noDoubleEquity: 0.8, doubleTakeEquity: 1.2 })
        });
        const friends = await started([6, 1], { engine, store });
        await friends.act('a', { type: 'move', key: friends.match.legal.plays[1].key });
        const marked = friends.match.recent.player1[0].id;
        friends.mark('b', marked, true);

        // Fred has one checker left on his 2-point; Karl still has a back checker in Fred's home.
        friends.match.board.points.player2 = [14, 0, 1, ...new Array(23).fill(0)];
        plays = ['2/off'];
        friends.randomInt = scriptedDice([5, 2]);
        // Fred should have doubled (0.2 lost), then bears off: a backgammon wins the match.
        const state = await friends.act('b', { type: 'roll' });
        expect(state.match.result).toEqual({ winner: 'player2', points: 3, kind: 'backgammon' });
        expect(state.match.phase).toBe('match-over');
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({
            length: 3,
            player1: { name: 'Karl', score: 0, pr: 25, luck: 0 },
            player2: { name: 'Fred', score: 3, pr: 100, luck: 0 },
            marked: [{ id: marked, seat: 'player1', name: 'Karl', action: '24/18 13/8', best: '13/8 6/5', loss: 0.05 }]
        });
        expect(saved[0].marked[0].ogid).toEqual(expect.any(String));

        friends.mark('a', marked, false);
        expect(store.markDecisions).toHaveBeenCalledWith(saved[0].id, []);
        // Both choose a length again for the next match.
        expect((await friends.chooseLength('a', 3)).match.phase).toBe('match-over');
    });

    it('counts best checker plays in a row over the whole match, but not plays without a choice', async () => {
        let same = false;
        const engine = fakeEngine({ allEqual: () => same, plays: () => ['13/8 6/5', '13/10 6/5'] });
        // Karl opens 6-1; every following roll is 3-1 and nobody doubles.
        const friends = await started([6, 1, ...new Array(40).fill(0).map((_, i) => (i % 2 ? 1 : 3))], { engine });
        const play = (browser, move) => friends.act(browser, { type: 'move', key: friends.match.legal.plays.find((p) => p.move === move).key });
        const turn = async (browser, move) => {
            if (friends.match.phase === 'turn') await friends.act(browser, { type: 'roll' });
            return play(browser, move);
        };
        await turn('a', '13/8 6/5');
        await turn('b', '13/8 6/5');
        await turn('a', '13/8 6/5');
        let stats = friends.state('a').match.stats.player1;
        expect(stats).toMatchObject({ awesome: 2, bestAwesome: 2 });

        // Every play worth the same: not a decision, the streak stays.
        same = true;
        await turn('b', '13/10 6/5');
        await turn('a', '13/10 6/5');
        same = false;
        stats = friends.state('a').match.stats;
        expect(stats.player1).toMatchObject({ awesome: 2, bestAwesome: 2 });
        expect(stats.player2).toMatchObject({ awesome: 1, bestAwesome: 1 });

        // A worse play ends the streak; the best one is kept.
        await turn('b', '13/10 6/5');
        await turn('a', '13/10 6/5');
        await turn('b', '13/8 6/5');
        stats = friends.state('a').match.stats;
        expect(stats.player1).toMatchObject({ awesome: 0, bestAwesome: 2 });
        expect(stats.player2).toMatchObject({ awesome: 1, bestAwesome: 1 });
    });

    it('leaves the match as it was when the engine fails, so the action can be repeated', async () => {
        const engine = fakeEngine();
        const friends = await started([6, 1], { engine });
        const key = friends.match.legal.plays[0].key;
        engine.analyzeChecker = async () => { throw new Error('engine down'); };
        await expect(friends.act('a', { type: 'move', key })).rejects.toThrow('engine down');
        expect(friends.state('a').match).toMatchObject({ phase: 'move', onTurn: 'player1', error: 'engine down' });
        expect(friends.match.decisions.size).toBe(0);
    });

    it('ends an unfinished match when a player leaves', async () => {
        const friends = await started([6, 1]);
        const state = friends.leave('b');
        expect(state.match).toBeNull();
        expect(state.seats.player2).toBeNull();
    });
});
