'use strict';

const Database = require('better-sqlite3');
const BackgammonBoard = require('../src/board');
const checkerPlay = require('../shared/checkerPlay');
const { FriendError, FriendTable, rollsWithChances } = require('../src/friendMatch');
const { createFriendStore } = require('../src/friendStore');
const { buildReview, friendMatchView } = require('../src/matchReview');
const { matchToMat } = require('../src/matExport');

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

const memoryStore = () => createFriendStore(new Database(':memory:'));

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

    it('keeps a missed double in view together with the move that follows it', async () => {
        // Doubling is right for whoever is on roll: not doubling loses 0.2.
        const engine = fakeEngine({ cube: () => cubeAnswer({ decision: 'Double, take', noDoubleEquity: 0.5, doubleTakeEquity: 0.7 }) });
        // Opening 6-1 for Karl; Fred then rolls 3-1, Karl 4-2.
        const friends = await started([6, 1, 3, 1, 4, 2], { engine });
        await friends.act('a', { type: 'move', key: friends.match.legal.plays[0].key });
        await friends.act('b', { type: 'roll' });
        let state = await friends.act('b', { type: 'move', key: friends.match.legal.plays[1].key });
        expect(state.match.recent.player2.map((item) => [item.action, item.grade])).toEqual([
            ['No double', 'blunder'],
            ['24/18 13/8', 'error']
        ]);
        expect(state.match.stats.player2).toMatchObject({ decisions: 2, flagged: 2 });
        // The move list marks both mistakes; a correct decision carries no grade.
        const lines = state.match.events.filter((event) => ['move', 'no-double'].includes(event.type));
        expect(lines.map((event) => [event.type, event.who, event.grade ?? null, event.loss ?? null])).toEqual([
            ['move', 'player1', null, null],
            ['no-double', 'player2', 'blunder', 0.2],
            ['move', 'player2', 'error', 0.05]
        ]);

        // Karl's new turn starts his list afresh; Fred's stays until his next turn.
        state = await friends.act('a', { type: 'roll' });
        expect(state.match.recent.player1.map((item) => item.action)).toEqual(['No double']);
        expect(state.match.recent.player2).toHaveLength(2);
    });

    it('plays a double that is passed, and the next game is the Crawford game', async () => {
        const engine = fakeEngine({ cube: () => cubeAnswer({ decision: 'Double, pass', take: 'pass', noDoubleEquity: 0.8, doubleTakeEquity: 1.2 }) });
        // Opening 6-1 for Karl; Fred leads 1:0 in the 3-point match.
        const friends = await started([6, 1], { engine });
        friends.match.score = { player1: 0, player2: 1 };
        await friends.act('a', { type: 'move', key: friends.match.legal.plays[0].key });
        let state = await friends.act('b', { type: 'double' });
        expect(state.match).toMatchObject({ phase: 'respond', offer: { by: 'player2', to: 'player1', cube: 2 } });
        await expect(friends.act('b', { type: 'pass' })).rejects.toThrow(FriendError);

        state = await friends.act('a', { type: 'pass' });
        expect(state.match.recent.player2[0]).toMatchObject({ kind: 'cube', action: 'Double', loss: 0 });
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

    describe('a wrong double', () => {
        // Doubling is a blunder: the double costs 0.5, and the right answer is to take.
        const wrongDouble = () => fakeEngine({ cube: () => cubeAnswer({ noDoubleEquity: 0.6, doubleTakeEquity: 0.1 }) });

        async function doubled(answer) {
            const friends = await started([6, 1, 3, 1], { engine: wrongDouble() });
            await friends.act('a', { type: 'move', key: friends.match.legal.plays[0].key });
            const before = friends.state('a').match.stats.player2;
            await friends.act('b', { type: 'double' });
            return { friends, before, answered: answer ? await friends.act('a', { type: answer }) : null };
        }

        it.each(['a', 'b'])('tells nothing about its grade to %s until it is answered', async (browser) => {
            const { friends, before } = await doubled(null);
            const { match } = friends.state(browser);
            expect(match.phase).toBe('respond');
            expect(match.recent.player2).toEqual([]);
            expect(match.stats.player2).toEqual(before);
            expect(match.events.at(-1)).toEqual({ seq: expect.any(Number), game: 1, type: 'double', who: 'player2', cube: 2 });
            // Nothing else in what the browser gets gives the grade away.
            expect(match.offer).toEqual({ by: 'player2', to: 'player1', cube: 2 });
            expect(JSON.stringify(match)).not.toMatch(/blunder|double-graded|No double, take|"action":"Double"/);
        });

        it.each(['take', 'pass'])('is graded once it was answered with %s', async (answer) => {
            const { answered } = await doubled(answer);
            expect(answered.match.recent.player2[0]).toMatchObject({ kind: 'cube', action: 'Double', loss: 0.5, grade: 'blunder' });
            expect(answered.match.stats.player2).toMatchObject({ decisions: 1, flagged: 1 });
            const types = answered.match.events.map((event) => event.type);
            expect(types.indexOf('double-graded')).toBe(types.indexOf('double') + 1);
            expect(types[types.indexOf('double-graded') + 1]).toBe(answer);
            expect(answered.match.events.find((event) => event.type === 'double-graded'))
                .toMatchObject({ who: 'player2', grade: 'blunder', loss: 0.5 });
        });

        it('stays unanswered when the engine fails on the take, and is graded only once', async () => {
            const { friends } = await doubled(null);
            const engine = friends.engineOverride;
            const { analyzeChecker } = engine;
            engine.analyzeChecker = async () => { throw new Error('engine down'); };
            await expect(friends.act('a', { type: 'take' })).rejects.toThrow('engine down');
            expect(friends.state('a').match.recent.player2).toEqual([]);
            expect(friends.state('a').match.stats.player2.flagged).toBe(0);

            engine.analyzeChecker = analyzeChecker;
            friends.randomInt = scriptedDice([3, 1]);
            const { match } = await friends.act('a', { type: 'take' });
            expect(match.recent.player2.map((item) => item.action)).toEqual(['Double']);
            expect(match.stats.player2.flagged).toBe(1);
        });
    });

    it('saves the finished match with PR, luck and the marked decisions', async () => {
        const saved = [];
        const store = { ...memoryStore(), saveMatch: (record) => saved.push(record), markDecisions: jest.fn() };
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
        // The pages say "awesome" for exactly these moves.
        const moveEvents = () => friends.state('a').match.events.filter((event) => event.type === 'move');
        expect(moveEvents().map((event) => Boolean(event.awesome))).toEqual([true, true, true]);

        // Every play worth the same: not a decision, the streak stays.
        same = true;
        await turn('b', '13/10 6/5');
        await turn('a', '13/10 6/5');
        same = false;
        stats = friends.state('a').match.stats;
        expect(stats.player1).toMatchObject({ awesome: 2, bestAwesome: 2 });
        expect(stats.player2).toMatchObject({ awesome: 1, bestAwesome: 1 });

        // Equal plays: no "awesome".
        expect(moveEvents().slice(3).map((event) => Boolean(event.awesome))).toEqual([false, false]);

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

    it('lets either player abort the match: nothing is saved, and both are told', async () => {
        const saved = [];
        const store = { ...memoryStore(), saveMatch: (record) => saved.push(record), markDecisions: jest.fn() };
        const friends = await started([6, 1], { store });
        expect(() => friends.abort('c')).toThrow('Please join the table first');

        let state = friends.abort('b');
        expect(state.match).toBeNull();
        expect(state.seats.player1).toMatchObject({ name: 'Karl', wantLength: null });
        expect(state.seats.player2).toMatchObject({ name: 'Fred', wantLength: null });
        expect(friends.state('a').notice).toEqual({ by: 'player2', text: 'Fred aborted the match.' });
        expect(saved).toHaveLength(0);
        expect(() => friends.abort('a')).toThrow('No match is running');

        // The next match clears the notice.
        friends.randomInt = scriptedDice([6, 1]);
        await friends.chooseLength('a', 3);
        state = await friends.chooseLength('b', 3);
        expect(state.notice).toBeNull();
        expect(state.match.phase).toBe('move');
    });

    it('frees the seat of a player who had left when the match is aborted', async () => {
        const friends = await started([6, 1], { store: memoryStore() });
        friends.leave('b');
        const state = friends.abort('a');
        expect(state.match).toBeNull();
        expect(state.seats.player2).toBeNull();
        expect(state.adjourned).toEqual([]);
    });
});

describe('leaving and coming back', () => {
    async function playing(options = {}) {
        const store = options.store || memoryStore();
        const friends = table(options.dice || [6, 1, 3, 1, 4, 2], options.engine, store);
        friends.join('a', 'Karl');
        friends.join('b', 'Fred');
        await friends.chooseLength('a', 5);
        await friends.chooseLength('b', 5);
        return { friends, store };
    }

    it('keeps the match and the seat when one player leaves', async () => {
        const { friends } = await playing();
        const state = friends.leave('b');
        expect(state.you).toBeNull();
        expect(state.match.phase).toBe('move');
        expect(state.seats.player2).toMatchObject({ name: 'Fred', online: false });
        // Nobody else gets that seat, however long it is empty.
        friends.advance(60 * 60 * 1000);
        friends.state('a');
        expect(() => friends.join('c', 'Eve')).toThrow('Karl and Fred are playing');
    });

    it('lets a player come back from another browser under their name, in any spelling', async () => {
        const { friends } = await playing();
        friends.leave('b');
        const state = friends.join('phone', '  fred ');
        expect(state.you).toBe('player2');
        // The spelling is only a check, it changes nothing.
        expect(state.seats.player2).toMatchObject({ name: 'Fred', online: true });
        expect(state.match.names.player2).toBe('Fred');
        expect(friends.state('b').you).toBeNull();
        // The player on roll gets the plays in the new browser too.
        const karl = friends.join('tablet', 'KARL', { takeOver: true });
        expect(karl.you).toBe('player1');
        expect(karl.match.legal.plays).toHaveLength(2);
        expect(friends.state('a').match.legal).toBeNull();
    });

    it('asks before taking a seat that is still in use, not after two minutes without news', async () => {
        const { friends } = await playing();
        let refusal = null;
        try {
            friends.join('phone', 'Fred');
        } catch (error) {
            refusal = error;
        }
        expect(refusal).toBeInstanceOf(FriendError);
        expect(refusal).toMatchObject({ status: 409, takeOver: true });
        expect(friends.state('b').you).toBe('player2');

        friends.advance(3 * 60 * 1000);
        friends.state('a');
        expect(friends.join('phone', 'Fred').you).toBe('player2');
    });

    it('does not let a player rename to the name of the other one', async () => {
        const { friends } = await playing();
        expect(() => friends.join('b', 'karl')).toThrow('already at the table');
        expect(friends.join('b', 'Freddy').match.names.player2).toBe('Freddy');
    });

    it('restores everything when both left and are back, from other browsers and in the other order', async () => {
        // A blunder for the double, so that the hidden grade of an open offer must survive too.
        const engine = fakeEngine({ cube: () => cubeAnswer({ noDoubleEquity: 0.6, doubleTakeEquity: 0.1 }) });
        const { friends, store } = await playing({ engine });
        await friends.act('a', { type: 'move', key: friends.match.legal.plays[1].key });
        const decision = friends.match.recent.player1[0].id;
        friends.mark('b', decision, true);
        await friends.act('b', { type: 'double' });
        const seen = friends.state('a').match;

        friends.leave('b');
        let state = friends.leave('a');
        expect(friends.match).toBeNull();
        expect(state.seats).toEqual({ player1: null, player2: null });
        expect(state.match).toBeNull();
        expect(state.adjourned).toEqual([expect.objectContaining({
            length: 5, names: { player1: 'Karl', player2: 'Fred' }, score: { player1: 0, player2: 0 }
        })]);

        // Fred is first back this time: alone, no match yet; he sits on the free seat 1.
        state = friends.join('phone', 'Fred');
        expect(state).toMatchObject({ you: 'player1', match: null });
        expect(state.adjourned).toHaveLength(1);
        state = friends.join('tablet', 'KARL');
        // Both are on their old sides again.
        expect(state.you).toBe('player1');
        expect(friends.state('phone').you).toBe('player2');
        expect(state.adjourned).toEqual([]);
        expect(state.match).toEqual({ ...seen, resumed: true });
        expect(friends.state('tablet').match.recent.player1[0].marked).toBe(true);

        // It goes on: the double is answered, and graded as it would have been.
        friends.randomInt = scriptedDice([3, 1]);
        state = await friends.act('tablet', { type: 'take' });
        expect(state.match.recent.player2[0]).toMatchObject({ action: 'Double', grade: 'blunder', loss: 0.5 });
        expect(state.match.stats.player2).toMatchObject({ flagged: 1 });
        expect(friends.match.board.cube).toBe(2);
        expect(store.listOpenMatches()).toHaveLength(1);
    });

    it('goes on after a server restart, from what the store has', async () => {
        const { friends, store } = await playing();
        await friends.act('a', { type: 'move', key: friends.match.legal.plays[1].key });
        const seen = friends.state('a').match;

        const restarted = new FriendTable({ engine: friends.engineOverride, randomInt: scriptedDice([3, 1]), store, now: () => 2_000_000 });
        expect(restarted.join('a', 'Karl').match).toBeNull();
        const state = restarted.join('b', 'Fred');
        expect(state.match).toMatchObject({
            phase: seen.phase, ogid: seen.ogid, onTurn: 'player2', recent: seen.recent, stats: seen.stats, events: seen.events
        });
        await restarted.act('b', { type: 'roll' });
        expect(restarted.state('b').match.phase).toBe('move');
    });

    it('lets others play in the meantime, and keeps the matches of each pair apart', async () => {
        const { friends } = await playing();
        friends.leave('a');
        friends.leave('b');
        friends.randomInt = scriptedDice([6, 1]);
        friends.join('c', 'Eve');
        let state = friends.join('d', 'Karl');
        // Karl and Eve are not the pair of the saved match.
        expect(state.match).toBeNull();
        expect(state.adjourned).toHaveLength(1);
        await friends.chooseLength('c', 3);
        await friends.chooseLength('d', 3);
        expect(friends.state('c').match.length).toBe(3);
        expect(friends.state('c').adjourned).toHaveLength(1);
        expect(friends.store.listOpenMatches()).toHaveLength(2);

        friends.abort('c');
        friends.leave('c');
        state = friends.join('e', 'Fred');
        expect(state.match.length).toBe(5);
    });

    it('makes way for a new player only when both players of the match are gone', async () => {
        const { friends } = await playing();
        friends.advance(3 * 60 * 1000);
        const state = friends.join('c', 'Eve');
        expect(state.you).toBe('player1');
        expect(state.match).toBeNull();
        expect(state.seats.player2).toBeNull();
        expect(state.adjourned).toHaveLength(1);
    });

    it('forgets an open match once it is finished or aborted', async () => {
        const { friends, store } = await playing();
        expect(store.listOpenMatches()).toHaveLength(1);
        friends.abort('a');
        expect(store.listOpenMatches()).toEqual([]);

        let plays = ['13/8 6/5', '24/18 13/8'];
        friends.engineOverride = fakeEngine({ plays: () => plays });
        friends.randomInt = scriptedDice([6, 1]);
        await friends.chooseLength('a', 3);
        await friends.chooseLength('b', 3);
        expect(store.listOpenMatches()).toHaveLength(1);
        await friends.act('a', { type: 'move', key: friends.match.legal.plays[0].key });
        // Fred has one checker left; Karl still has one in Fred's home: a backgammon ends the match.
        friends.match.board.points.player2 = [14, 0, 1, ...new Array(23).fill(0)];
        plays = ['2/off'];
        friends.randomInt = scriptedDice([5, 2]);
        await friends.act('b', { type: 'roll' });
        expect(friends.match.phase).toBe('match-over');
        expect(store.listOpenMatches()).toEqual([]);
    });

    it('still lets a player leave the table outside a match', async () => {
        const friends = table([]);
        friends.join('a', 'Karl');
        friends.join('b', 'Fred');
        expect(friends.leave('b').seats.player2).toBeNull();
    });
});

describe('watching the friend move', () => {
    // Karl (seat player1) starts with 6-1 and has the move.
    async function moving(store = null) {
        const friends = table([6, 1, 3, 2, 4, 5], fakeEngine(), store);
        friends.join('a', 'Karl');
        friends.join('b', 'Fred');
        await friends.chooseLength('a', 3);
        await friends.chooseLength('b', 3);
        const { match } = friends.state('a');
        expect(match.phase).toBe('move');
        const points = match.legal.position.slice();
        points[13] -= 1;
        points[8] += 1;
        return { friends, seq: match.seq, points, key: match.legal.plays[0].key };
    }

    test('the other player sees the checkers placed so far, the mover gets nothing back', async () => {
        const { friends, seq, points } = await moving();
        expect(friends.tentative('a', { seq, points, moved: 1 })).toEqual({ shown: true });
        expect(friends.state('b').match.tentative).toEqual({ points, moved: 1 });
        expect(friends.state('a').match.tentative).toBeNull();
    });

    test('taking everything back shows the start again', async () => {
        const { friends, seq, points } = await moving();
        friends.tentative('a', { seq, points, moved: 1 });
        friends.tentative('a', { seq, points: friends.state('a').match.legal.position, moved: 0 });
        expect(friends.state('b').match.tentative).toBeNull();
    });

    test('only the player on move can show a position', async () => {
        const { friends, seq, points } = await moving();
        expect(friends.tentative('b', { seq, points, moved: 1 })).toEqual({ shown: false });
        expect(friends.state('b').match.tentative).toBeNull();
        expect(() => friends.tentative('stranger', { seq, points, moved: 1 })).toThrow(FriendError);
    });

    test.each([
        ['no array', { points: 'x', moved: 1 }],
        ['too short', { points: [1, 2], moved: 1 }],
        ['no numbers', { points: new Array(26).fill('a'), moved: 1 }],
        ['too many checkers', { points: new Array(26).fill(99), moved: 1 }],
        ['no count', { points: new Array(26).fill(0) }]
    ])('refuses what is no position: %s', async (_label, body) => {
        const { friends, seq } = await moving();
        expect(() => friends.tentative('a', { seq, ...body })).toThrow(FriendError);
    });

    test('the finished move replaces it, and one arriving late is ignored', async () => {
        const { friends, seq, points, key } = await moving();
        friends.tentative('a', { seq, points, moved: 1 });
        await friends.act('a', { type: 'move', key });
        expect(friends.state('b').match.tentative).toBeNull();
        expect(friends.tentative('a', { seq, points, moved: 1 })).toEqual({ shown: false });
        expect(friends.state('b').match.tentative).toBeNull();
    });

    test('stays while the finished move is being rated, and goes when that fails', async () => {
        const engine = fakeEngine();
        const rate = engine.analyzeChecker;
        const { friends, seq, points, key } = await moving();
        friends.engineOverride = engine;
        friends.tentative('a', { seq, points, moved: 1 });
        let fail;
        engine.analyzeChecker = () => new Promise((_resolve, reject) => { fail = reject; });
        const move = friends.act('a', { type: 'move', key });
        expect(friends.state('b').match.phase).toBe('thinking');
        expect(friends.state('b').match.tentative).toEqual({ points, moved: 1 });
        // Meanwhile nothing changes it.
        expect(friends.tentative('a', { seq, points, moved: 2 })).toEqual({ shown: false });
        fail(new Error('engine gone'));
        await expect(move).rejects.toThrow('engine gone');
        engine.analyzeChecker = rate;
        expect(friends.state('b').match.phase).toBe('move');
        expect(friends.state('b').match.tentative).toBeNull();
    });

    test('is not kept with the saved match', async () => {
        const store = memoryStore();
        const { friends, seq, points } = await moving(store);
        friends.tentative('a', { seq, points, moved: 1 });
        friends.keepOpen(friends.match);
        const [open] = store.listOpenMatches();
        expect(store.getOpenMatch(open.id).tentative).toBeUndefined();
    });

    test('does not disturb the grades, the log or the review', async () => {
        const plain = await moving();
        const watched = await moving();
        watched.friends.tentative('a', { seq: watched.seq, points: watched.points, moved: 1 });
        await plain.friends.act('a', { type: 'move', key: plain.key });
        await watched.friends.act('a', { type: 'move', key: watched.key });
        const seen = (friends) => {
            const { stats, events } = friends.state('b').match;
            return { stats, events };
        };
        expect(seen(watched.friends)).toEqual(seen(plain.friends));
    });
});

describe('reviewing a finished match', () => {
    // Karl opens with a wrong play; Fred rolls without doubling (a blunder) and plays;
    // Karl doubles wrongly, Fred takes; Karl plays; Fred bears off the last checker.
    async function finished() {
        const store = memoryStore();
        let plays = ['13/8 6/5', '24/18 13/8'];
        let cube = cubeAnswer({ decision: 'Double, take', noDoubleEquity: 0.5, doubleTakeEquity: 0.7 });
        const engine = fakeEngine({ plays: () => plays, cube: () => cube });
        const friends = table([6, 1, 3, 1], engine, store);
        friends.join('a', 'Karl');
        friends.join('b', 'Fred');
        await friends.chooseLength('a', 3);
        await friends.chooseLength('b', 3);
        const key = (index) => friends.match.legal.plays[index].key;
        await friends.act('a', { type: 'move', key: key(1) });
        const markedId = friends.match.recent.player1[0].id;
        friends.mark('a', markedId, true);
        await friends.act('b', { type: 'roll' });
        // The engine rates the cube when a turn starts: from now on, doubling is wrong.
        cube = cubeAnswer({ noDoubleEquity: 0.6, doubleTakeEquity: 0.1 });
        await friends.act('b', { type: 'move', key: key(0) });
        await friends.act('a', { type: 'double' });
        friends.randomInt = scriptedDice([4, 2]);
        await friends.act('b', { type: 'take' });
        await friends.act('a', { type: 'move', key: key(0) });
        friends.match.board.points.player2 = [14, 0, 1, ...new Array(23).fill(0)];
        plays = ['2/off'];
        friends.randomInt = scriptedDice([5, 2]);
        // Fred owns the cube at 2, and rolls: the backgammon is worth the match.
        await friends.act('b', { type: 'roll' });
        expect(friends.match.phase).toBe('match-over');
        return { stored: store.getMatch(friends.match.id), markedId };
    }

    it('has every step of both players, with the grades of both, in the right order', async () => {
        const { stored } = await finished();
        const [game] = buildReview(friendMatchView(stored, 'player1'));
        expect(game.steps.map((step) => [step.type, step.who, step.grade?.action ?? null, step.grade?.grade ?? null])).toEqual([
            ['move', 'you', '24/18 13/8', 'error'],
            ['no-double', 'engine', 'No double', 'blunder'],
            ['move', 'engine', '13/8 6/5', null],
            ['double', 'you', 'Double', 'blunder'],
            ['take', 'engine', 'Take', null],
            ['move', 'you', '13/8 6/5', null],
            ['no-double', 'engine', 'No double', null],
            // A forced play is not a decision: it has no grade.
            ['move', 'engine', null, null],
            ['game-over', 'engine', null, null]
        ]);
    });

    it('shows the marks and the cube as it was', async () => {
        const { stored, markedId } = await finished();
        const [game] = buildReview(friendMatchView(stored, 'player1'));
        expect(game.steps[0].grade).toMatchObject({ id: markedId, marked: true });
        expect(game.steps[1].grade.marked).toBe(false);
        const cubeAt = (step) => BackgammonBoard.fromOgid(step.before);
        expect(cubeAt(game.steps[3])).toMatchObject({ cube: 1, cubeOwner: null });
        // After the take, Fred owns the cube at 2.
        expect(cubeAt(game.steps[5])).toMatchObject({ cube: 2, cubeOwner: 'player2', turn: 'player1' });
    });

    it('is seen from the side of the second player, too', async () => {
        const { stored } = await finished();
        const one = friendMatchView(stored, 'player1');
        const two = friendMatchView(stored, 'player2');
        expect([one.you.name, one.opponent.name, two.you.name, two.opponent.name]).toEqual(['Karl', 'Fred', 'Fred', 'Karl']);
        const steps = buildReview(one)[0].steps;
        const mirrored = buildReview(two)[0].steps;
        expect(mirrored.map((step) => step.type)).toEqual(steps.map((step) => step.type));
        expect(mirrored.map((step) => step.who)).toEqual(steps.map((step) => (step.who === 'you' ? 'engine' : 'you')));

        // Every position has the same checkers, with the sides exchanged.
        steps.forEach((step, index) => {
            const seen = BackgammonBoard.fromOgid(step.after);
            const fromTwo = BackgammonBoard.fromOgid(mirrored[index].after);
            expect(fromTwo.points).toEqual({ player1: seen.points.player2, player2: seen.points.player1 });
        });
        // Fred's move starts from Fred's point of view: he is on roll as player1.
        const fredMoves = mirrored.find((step) => step.type === 'move' && step.who === 'you');
        expect(BackgammonBoard.fromOgid(fredMoves.before).turn).toBe('player1');
    });

    it('writes the match for XG and gnubg', async () => {
        const { stored } = await finished();
        const view = friendMatchView(stored, 'player2');
        const mat = matchToMat({ length: view.length, games: view.games, opponent: view.opponent.name }, view.you.name);
        expect(mat).toContain(' 3 point match');
        expect(mat).toMatch(/Fred : 0\s+Karl : 0/);
        expect(mat).toContain('Doubles => 2');
        expect(mat).toContain('Takes');
        expect(mat).toContain('and the match');
    });

    it('never sends the log during play, and an engine failure leaves it unchanged', async () => {
        const engine = fakeEngine();
        const friends = table([6, 1], engine, memoryStore());
        friends.join('a', 'Karl');
        friends.join('b', 'Fred');
        await friends.chooseLength('a', 3);
        await friends.chooseLength('b', 3);
        expect(friends.state('a').match.games).toBeUndefined();
        const before = JSON.stringify(friends.match.games);
        const key = friends.match.legal.plays[0].key;
        engine.analyzeCube = async () => { throw new Error('engine down'); };
        await expect(friends.act('a', { type: 'move', key })).rejects.toThrow('engine down');
        expect(JSON.stringify(friends.match.games)).toBe(before);
    });
});
