'use strict';

const path = require('path');
const { EngineBridges, BridgeLostError } = require('../src/engineBridge');
const { BgEngineClient, PlayedMoveNotLegalError } = require('../src/engines/bgEngine');
const BackgammonBoard = require('../src/board');

const BRIDGE = 'ab'.repeat(16);
const INFO = { name: 'DarkBGHelmet', version: '0.1.0', network: 'test-net' };

function bridges(options = {}) {
    return new EngineBridges({ network: 'test-net', pollMs: 50, lostMs: 1000, ...options });
}

/** Runs `fn` as a request from the page with bridge `id` would run. */
function asRequest(set, id, fn) {
    return new Promise((resolve, reject) => {
        const req = { get: (name) => (name === 'X-Engine-Bridge' ? id : undefined) };
        set.middleware()(req, {}, () => Promise.resolve().then(fn).then(resolve, reject));
    });
}

/** A page: polls for jobs and answers them with `answer(job)` until stopped. */
function page(set, id, answer, info = INFO) {
    let running = true;
    const loop = (async () => {
        while (running) {
            const jobs = await set.poll(id, info);
            for (const job of jobs) {
                Promise.resolve().then(() => answer(job)).then(
                    (result) => set.answer(id, job.id, result),
                    (error) => set.answer(id, job.id, undefined, error.message)
                );
            }
        }
    })();
    return { stop: async () => { running = false; await loop; } };
}

describe('EngineBridges', () => {
    let set;
    afterEach(() => set?.close());

    it('only routes requests that carry the id of a polling page', async () => {
        set = bridges();
        expect(await asRequest(set, BRIDGE, () => set.current())).toBeNull();  // not registered yet
        const browser = page(set, BRIDGE, () => ({}));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(await asRequest(set, BRIDGE, () => set.current()?.id)).toBe(BRIDGE);
        expect(await asRequest(set, 'cd'.repeat(16), () => set.current())).toBeNull();
        expect(set.current()).toBeNull();  // outside a request
        expect(await asRequest(set, BRIDGE, () => set.withoutBrowser(() => set.current()))).toBeNull();
        await browser.stop();
    });

    it('rejects invalid ids and an engine with another network', async () => {
        set = bridges();
        await expect(set.poll('nope', INFO)).rejects.toMatchObject({ status: 400 });
        await expect(set.poll(BRIDGE, { ...INFO, network: 'old-net' })).rejects.toMatchObject({ status: 409 });
    });

    it('hands a job to the waiting poll and resolves it with the answer', async () => {
        set = bridges({ pollMs: 5000 });
        await expect(set.poll(BRIDGE, INFO)).resolves.toEqual([]);  // registers, answers at once
        const polled = set.poll(BRIDGE, INFO);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const bridge = set.bridges.get(BRIDGE);
        const answer = set.request(bridge, '/v1/move', { dice: [3, 1] }, 1000);
        const jobs = await polled;
        expect(jobs).toEqual([{ id: expect.any(Number), path: '/v1/move', body: { dice: [3, 1] }, budgetMs: 120000 }]);
        expect(set.answer(BRIDGE, jobs[0].id, { moves: [] })).toBe(true);
        await expect(answer).resolves.toEqual({ moves: [] });
        expect(set.answer(BRIDGE, jobs[0].id, { moves: [] })).toBe(false);  // answered already
    });

    it('keeps a page whose poll is waiting, however long ago it polled', async () => {
        set = bridges({ pollMs: 5000, lostMs: 100 });
        await set.poll(BRIDGE, INFO);
        const waiting = set.poll(BRIDGE, INFO);
        set.sweep(Date.now() + 1000);
        const bridge = set.bridges.get(BRIDGE);
        expect(bridge).toBeDefined();
        bridge.lastSeen -= 1000;
        expect(await asRequest(set, BRIDGE, () => set.current()?.id)).toBe(BRIDGE);
        bridge.wake();
        await waiting;
    });

    it('keeps the jobs of a poll whose page dropped the connection for the next poll', async () => {
        set = bridges({ pollMs: 5000 });
        await set.poll(BRIDGE, INFO);
        let gone = false;
        const dropped = set.poll(BRIDGE, INFO, () => gone);
        const bridge = set.bridges.get(BRIDGE);
        const answer = set.request(bridge, '/v1/move', {}, 1000);
        gone = true;
        await expect(dropped).resolves.toEqual([]);
        const jobs = await set.poll(BRIDGE, INFO);
        expect(jobs).toHaveLength(1);
        set.answer(BRIDGE, jobs[0].id, { moves: [] });
        await expect(answer).resolves.toEqual({ moves: [] });
    });

    it('fails the jobs of a page that stops polling', async () => {
        set = bridges({ lostMs: 100 });
        await set.poll(BRIDGE, INFO);
        const job = set.request(set.bridges.get(BRIDGE), '/v1/cube', {}, 5000);
        set.sweep(Date.now() + 200);
        await expect(job).rejects.toBeInstanceOf(BridgeLostError);
        expect(set.bridges.size).toBe(0);
    });
});

describe('BgEngineClient with the browser engine', () => {
    let set;
    let client;
    const http = jest.fn();
    beforeEach(() => {
        set = bridges();
        client = new BgEngineClient({ bridges: set, retryDelayMs: 0 });
        http.mockReset();
        client.fetchJson = http;
    });
    afterEach(() => set.close());

    it('sends the engine work of a bridged request to the browser and reports its engine', async () => {
        const browser = page(set, BRIDGE, (job) => {
            if (job.path === '/v1/cube') return { decision: 'No double', take: 'take', equity: {}, plies: job.body.options.plies };
            throw new Error(`unexpected ${job.path}`);
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        const ogid = BackgammonBoard.starting('player1').toOgid();
        const result = await asRequest(set, BRIDGE, () => client.analyzeCube({ ogid, plies: 2 }));
        expect(result).toMatchObject({ decision: 'No double', plies: 2, engineMetadata: { network: 'test-net', plies: 2 } });
        expect(http).not.toHaveBeenCalled();
        await browser.stop();
    });

    it('turns a refusal of the browser engine into the same error as bgserver\'s', async () => {
        const browser = page(set, BRIDGE, () => { throw new Error('played: not a legal play'); });
        await new Promise((resolve) => setTimeout(resolve, 10));
        const board = BackgammonBoard.starting('player1');
        board.dice = { die1: 3, die2: 1 };
        await expect(asRequest(set, BRIDGE, () => client.analyzeChecker({ ogid: board.toOgid(), played: '24/1' })))
            .rejects.toBeInstanceOf(PlayedMoveNotLegalError);
        await browser.stop();
    });

    it('reports a search the page stopped as too deep for the device', async () => {
        const browser = page(set, BRIDGE, () => { throw new Error('too deep for this device: stopped after 20 s'); });
        await new Promise((resolve) => setTimeout(resolve, 10));
        const ogid = BackgammonBoard.starting('player1').toOgid();
        await expect(asRequest(set, BRIDGE, () => client.analyzeCube({ ogid, plies: 7 })))
            .rejects.toThrow('This is too deep for this device: stopped after 20 s; choose a lower depth');
        expect(http).not.toHaveBeenCalled();
        await browser.stop();
    });

    it('runs rollouts in the browser, and does not hand them to bgserver when the page goes away', async () => {
        const browser = page(set, BRIDGE, (job) => ({ path: job.path, trials: job.body.options.trials }));
        await new Promise((resolve) => setTimeout(resolve, 10));
        const ogid = BackgammonBoard.starting('player1').toOgid();
        const raw = jest.spyOn(set, 'request');
        await asRequest(set, BRIDGE, () => client.rollout({ ogid, options: { trials: 36 } }));
        expect(raw).toHaveBeenCalledWith(expect.anything(), '/v1/rollout', expect.objectContaining({ options: { trials: 36 } }), expect.any(Number));
        expect(http).not.toHaveBeenCalled();
        await browser.stop();

        const pending = asRequest(set, BRIDGE, () => client.rollout({ ogid, options: { trials: 36 } }));
        await new Promise((resolve) => setTimeout(resolve, 10));
        set.sweep(Date.now() + 5000);
        await expect(pending).rejects.toBeInstanceOf(BridgeLostError);
        expect(http).not.toHaveBeenCalled();
    });

    it('uses bgserver without a bridge, and when the page goes away', async () => {
        http.mockResolvedValue({ name: 'DarkBGHelmet', network: 'server-net', decision: 'No double', equity: {} });
        const ogid = BackgammonBoard.starting('player1').toOgid();
        await client.analyzeCube({ ogid, plies: 2 });
        expect(http).toHaveBeenCalledWith('/v1/cube', expect.any(Object), expect.any(Number));

        await set.poll(BRIDGE, INFO);  // registered, but never polls again
        http.mockClear();
        const pending = asRequest(set, BRIDGE, () => client.analyzeCube({ ogid, plies: 2 }));
        await new Promise((resolve) => setTimeout(resolve, 10));
        set.sweep(Date.now() + 5000);
        await expect(pending).resolves.toMatchObject({ decision: 'No double' });
        expect(http).toHaveBeenCalledWith('/v1/cube', expect.any(Object), expect.any(Number));
    });

    it('computes real analyses with the copied WebAssembly engine', async () => {
        const BGHelmet = require('../public/engine/bghelmet.js');
        const engineDir = path.join(__dirname, '..', 'public', 'engine');
        const engine = await BGHelmet.load({ net: path.join(engineDir, 'engine.bgnn'), threads: 1 });
        const info = engine.info();
        set.close();
        set = new EngineBridges({ network: info.network, pollMs: 50, lostMs: 5000 });
        client = new BgEngineClient({ bridges: set });
        client.fetchJson = http;
        const running = page(set, BRIDGE, (job) => {
            const method = { '/v1/move': 'move', '/v1/cube': 'cube' }[job.path];
            return engine[method](job.body);
        }, info);
        await new Promise((resolve) => setTimeout(resolve, 10));

        const board = BackgammonBoard.starting('player1');
        board.dice = { die1: 3, die2: 1 };
        const ogid = board.toOgid();
        const checker = await asRequest(set, BRIDGE, () => client.analyzeChecker({ ogid, played: '8/5 6/5', plies: 2 }));
        expect(checker.moves[0].move).toBe('8/5 6/5');
        expect(checker.played).toMatchObject({ move: '8/5 6/5', isBest: true });
        expect(checker.engineMetadata.network).toBe(info.network);
        const legal = await asRequest(set, BRIDGE, () => client.listLegalPlays({ ogid }));
        expect(legal.plays.length).toBe(16);
        const cube = await asRequest(set, BRIDGE, () => client.analyzeCube({ ogid: BackgammonBoard.starting('player1').toOgid(), plies: 1 }));
        expect(cube.decision).toMatch(/No double/);
        expect(http).not.toHaveBeenCalled();
        await running.stop();
    }, 30000);

    it('rolls out chosen plays as the engine rolls out its own candidates', async () => {
        const BGHelmet = require('../public/engine/bghelmet.js');
        const engine = await BGHelmet.load({ net: path.join(__dirname, '..', 'public', 'engine', 'engine.bgnn'), threads: 1 });
        const local = new BgEngineClient({ bridges: set });
        local.fetchJson = async (enginePath, body) => engine[{ '/v1/move': 'move', '/v1/rollout': 'rollout' }[enginePath]](body);
        const board = BackgammonBoard.starting('player1');
        board.dice = { die1: 3, die2: 1 };
        const ogid = board.toOgid();
        const options = { trials: 72 };

        const candidates = await local.rollout({ ogid, dice: board.dice, options: { ...options, candidates: 2 } });
        // Named in another notation and order: the engine recognises the plays.
        const plays = candidates.moves.map((move) => move.move.split(' ').reverse().join(' ')).reverse();
        const chosen = await local.rolloutPlays({ ogid, plays, options });

        expect(chosen.moves.map((move) => move.move)).toEqual(candidates.moves.map((move) => move.move));
        chosen.moves.forEach((move, index) => {
            const expected = candidates.moves[index];
            expect(move.cubefulEquity).toBeCloseTo(expected.cubefulEquity, 6);
            expect(move.evaluation.win).toBeCloseTo(expected.evaluation.win, 6);
            expect(move.evaluation.gammonLoss).toBeCloseTo(expected.evaluation.gammonLoss, 6);
            expect(move.trials).toBe(72);
        });
    }, 60000);
});
