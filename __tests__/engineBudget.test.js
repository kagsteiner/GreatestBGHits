'use strict';

const engineBudget = require('../shared/engineBudget');
const { EngineBridges, getBridges } = require('../src/engineBridge');
const { PlayMatches } = require('../src/playMatch');

const BRIDGE = 'cd'.repeat(16);
const INFO = { name: 'DarkBGHelmet', version: '0.1.0', network: 'test-net' };

/** Runs `fn` as a request from the page with bridge `id` would run. */
function asRequest(set, id, fn) {
    return new Promise((resolve, reject) => {
        const req = { get: (name) => (name === 'X-Engine-Bridge' ? id : undefined) };
        set.middleware()(req, {}, () => Promise.resolve().then(fn).then(resolve, reject));
    });
}

describe('engineBudget', () => {
    const fast = { benchMs: 20, threads: 4 };
    const slow = { benchMs: 1500, threads: 1 };

    it('estimates deeper searches and more trials as slower, and slower devices as slower', () => {
        for (const speed of [fast, slow]) {
            for (let plies = 2; plies <= 7; plies++) {
                expect(engineBudget.searchMs(speed, 'move', plies)).toBeGreaterThan(engineBudget.searchMs(speed, 'move', plies - 1));
                expect(engineBudget.searchMs(speed, 'cube', plies)).toBeGreaterThan(engineBudget.searchMs(speed, 'cube', plies - 1));
            }
            expect(engineBudget.rolloutModeMs(speed, 'precise')).toBeGreaterThan(engineBudget.rolloutModeMs(speed, 'quick'));
            expect(engineBudget.rolloutModeMs(speed, 'deep')).toBeGreaterThan(engineBudget.rolloutModeMs(speed, 'precise'));
        }
        expect(engineBudget.searchMs(slow, 'move', 4)).toBeGreaterThan(engineBudget.searchMs(fast, 'move', 4));
    });

    it('offers what fits the budgets: a minute of analysis, three of rollouts, a few seconds per engine turn', () => {
        const own = engineBudget.limits(slow);
        expect(own.estimates[own.maxPlies]).toBeLessThanOrEqual(engineBudget.ANALYSIS_MS);
        if (own.maxPlies < 7) expect(own.estimates[own.maxPlies + 1]).toBeGreaterThan(engineBudget.ANALYSIS_MS);
        own.rollouts.forEach((mode) => expect(own.rolloutEstimates[mode]).toBeLessThanOrEqual(engineBudget.ROLLOUT_MS));
        own.cubeRollouts.forEach((mode) => expect(own.cubeRolloutEstimates[mode]).toBeLessThanOrEqual(engineBudget.ROLLOUT_MS));
        expect(own.cubeRollouts).toEqual(expect.arrayContaining(own.rollouts));
        own.levels.filter((level) => level > 1).forEach((level) => {
            expect(engineBudget.turnMs(slow, level)).toBeLessThanOrEqual(engineBudget.TURN_MS);
        });
        expect(engineBudget.limits(fast).maxPlies).toBeGreaterThanOrEqual(own.maxPlies);
        expect(engineBudget.limits(fast).levels.length).toBeGreaterThanOrEqual(own.levels.length);
        expect(engineBudget.limits(null)).toBeNull();
        expect(engineBudget.limits({ benchMs: 0 })).toBeNull();
    });

    it('lets a request run well past its estimate, between 20 s and 2 minutes (4 for a rollout)', () => {
        const move = (plies) => ({ options: { plies, max_moves: 10 } });
        expect(engineBudget.jobBudgetMs(fast, '/v1/move', move(1))).toBe(20000);
        expect(engineBudget.jobBudgetMs(slow, '/v1/move', move(7))).toBe(120000);
        expect(engineBudget.jobBudgetMs(null, '/v1/move', move(3))).toBe(120000);
        expect(engineBudget.jobBudgetMs(slow, '/v1/rollout', { options: { trials: 5184, variance_reduction: true } })).toBe(240000);
        const rollout = engineBudget.requestMs(slow, '/v1/rollout', { options: { trials: 1296 } });
        expect(engineBudget.requestMs(slow, '/v1/rollout', { dice: [3, 1], options: { trials: 1296, candidates: 5 } }))
            .toBeCloseTo(5 * rollout);
    });

    it('offers precise rollouts at the speed measured on a Mac with 4 threads, but not on a phone 5 times slower', () => {
        const mac = engineBudget.limits({ benchMs: 70, threads: 4 });
        expect(mac.rollouts).toEqual(['quick', 'precise']);
        expect(mac.cubeRollouts).toEqual(['quick', 'precise']);
        const phone = engineBudget.limits({ benchMs: 350, threads: 4 });
        expect(phone.rollouts).toEqual(['quick']);
        expect(phone.cubeRollouts).toEqual(['quick']);
    });

    it('labels estimates worth mentioning', () => {
        expect(engineBudget.label(800)).toBe('');
        expect(engineBudget.label(3000)).toBe('~5 s');
        expect(engineBudget.label(44000)).toBe('~45 s');
        expect(engineBudget.label(150000)).toBe('~3 min');
    });
});

describe('the speed a page reports', () => {
    let set;
    afterEach(() => set?.close());

    it('is kept with its bridge, shown in the status, and sets the budget of its jobs', async () => {
        set = new EngineBridges({ network: 'test-net', pollMs: 5000 });
        await set.poll(BRIDGE, { ...INFO, speed: { benchMs: 1500, threads: 1 } });
        const bridge = set.bridges.get(BRIDGE);
        expect(bridge.info.speed).toEqual({ benchMs: 1500, threads: 1 });
        expect(set.status().speeds).toEqual([{ benchMs: 1500, threads: 1 }]);
        expect(await asRequest(set, BRIDGE, () => set.currentLimits())).toEqual(engineBudget.limits({ benchMs: 1500, threads: 1 }));

        const body = { options: { plies: 4, max_moves: 10 } };
        const polled = set.poll(BRIDGE, { ...INFO, speed: { benchMs: 1500, threads: 1 } });
        const job = set.request(bridge, '/v1/move', body, 1000);
        const [sent] = await polled;
        expect(sent.budgetMs).toBe(engineBudget.jobBudgetMs({ benchMs: 1500, threads: 1 }, '/v1/move', body));
        set.answer(BRIDGE, sent.id, { moves: [] });
        await job;
    });

    it('is ignored when implausible', async () => {
        set = new EngineBridges({ network: 'test-net' });
        await set.poll(BRIDGE, { ...INFO, speed: { benchMs: -3, threads: 4 } });
        expect(set.bridges.get(BRIDGE).info.speed).toBeNull();
        expect(await asRequest(set, BRIDGE, () => set.currentLimits())).toBeNull();
    });
});

describe('play levels for a page with its engine', () => {
    it('are those its browser plays in a few seconds per engine turn', async () => {
        const bridges = getBridges();
        const matches = new PlayMatches({ maxPlies: 6 });
        expect(matches.levels).toEqual([1, 2, 3, 4, 5, 6]);
        const slow = { benchMs: 1500, threads: 1 };
        await bridges.poll(BRIDGE, { ...INFO, network: bridges.network, speed: slow });
        try {
            const levels = await asRequest(bridges, BRIDGE, () => matches.levels);
            expect(levels).toEqual(engineBudget.limits(slow, { levels: [1, 2, 3, 4, 5, 6] }).levels);
            expect(levels.length).toBeLessThan(6);
        } finally {
            bridges.bridges.delete(BRIDGE);
        }
    });
});

describe('friend match ratings for a page with its engine', () => {
    it('use a shallower depth when its browser is slow', async () => {
        const { FriendTable } = require('../src/friendMatch');
        const friends = new FriendTable({ engine: {} });
        expect(friends.ratingPlies()).toBe(friends.plies);
        const bridges = getBridges();
        const slow = { benchMs: 4000, threads: 1 };
        await bridges.poll(BRIDGE, { ...INFO, network: bridges.network, speed: slow });
        try {
            const plies = await asRequest(bridges, BRIDGE, () => friends.ratingPlies());
            expect(plies).toBe(engineBudget.limits(slow, { ratingPlies: friends.plies }).ratingPlies);
            expect(plies).toBeLessThan(friends.plies);
        } finally {
            bridges.bridges.delete(BRIDGE);
        }
    });
});
