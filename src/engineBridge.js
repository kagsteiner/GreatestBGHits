'use strict';

// The engine in the user's browser (public/engineBridge.js). A page that has
// loaded the WebAssembly engine (public/engine/) registers a bridge with a
// random id and sends the id with its requests (X-Engine-Bridge). While such a
// request is handled, the engine client (src/engines/bgEngine.js) sends its
// engine requests to that browser instead of bgserver: the browser fetches
// them by long polling, computes them and posts the answers back.
//
// The browser is trusted with its own requests only: a bridge receives the
// engine work of requests that carry its id, which only that page knows.
// Without a ready bridge, or when the page goes away, the engine work goes to
// bgserver as before.

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const engineBudget = require('../shared/engineBudget');

const BRIDGE_ID = /^[0-9a-f]{32}$/;
const POLL_MS = 20000;            // a poll waits this long for work
const LOST_MS = 15000;            // a bridge that has not polled for this long is gone
const MAX_BRIDGES = 2000;
const VERSION_FILE = path.join(__dirname, '..', 'public', 'engine', 'VERSION.json');

class BridgeLostError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BridgeLostError';
    }
}

/** An engine refusal from the browser, like bgserver's 4xx answers. */
class BridgeEngineError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BridgeEngineError';
    }
}

/** The speed a page reports ({ benchMs, threads }), if plausible. */
function speedOf(info) {
    const benchMs = Number(info?.speed?.benchMs);
    const threads = Number(info?.speed?.threads);
    if (!Number.isFinite(benchMs) || benchMs <= 0 || benchMs > 600000) return null;
    return {
        benchMs,
        threads: Number.isInteger(threads) && threads >= 1 && threads <= 64 ? threads : 1,
        max: info.speed.max === true
    };
}

function expectedNetwork() {
    try {
        return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')).network || null;
    } catch {
        return null;
    }
}

class EngineBridges {
    constructor(options = {}) {
        this.pollMs = options.pollMs ?? POLL_MS;
        this.lostMs = options.lostMs ?? LOST_MS;
        this.network = options.network !== undefined ? options.network : expectedNetwork();
        this.bridges = new Map();
        this.context = new AsyncLocalStorage();
        this.nextJob = 1;
        this.sweeper = setInterval(() => this.sweep(), Math.max(1000, this.lostMs / 3));
        this.sweeper.unref?.();
    }

    /** Express middleware: requests with a bridge id run with that bridge as their engine. */
    middleware() {
        return (req, res, next) => {
            const id = String(req.get('X-Engine-Bridge') || '');
            if (!BRIDGE_ID.test(id)) return next();
            this.context.run({ bridgeId: id }, next);
        };
    }

    /** Run `fn` without the browser engine (e.g. background work started by a request). */
    withoutBrowser(fn) {
        return this.context.exit(fn);
    }

    /** The ready bridge of the request being handled, or null. */
    current() {
        const id = this.context.getStore()?.bridgeId;
        const bridge = id ? this.bridges.get(id) : null;
        return bridge && this.alive(bridge) ? bridge : null;
    }

    /**
     * What the browser of the current request can do in reasonable time
     * (engineBudget.limits with `options`); null without one, or without a
     * measured speed.
     */
    currentLimits(options) {
        const bridge = this.current();
        return bridge ? engineBudget.limits(bridge.info?.speed, options) : null;
    }

    /** A page is there while its poll waits, or shortly after its last one. */
    alive(bridge, now = Date.now()) {
        return bridge.wake !== null || now - bridge.lastSeen < this.lostMs;
    }

    /**
     * A poll from a page: registers the bridge (once its engine is ready) and
     * resolves to the jobs waiting for it, waiting up to pollMs for one.
     * `closed()` tells whether the page has dropped the poll's connection:
     * its jobs then wait for the next poll.
     */
    async poll(id, info, closed = () => false) {
        if (!BRIDGE_ID.test(String(id || ''))) throw Object.assign(new Error('Invalid bridge id'), { status: 400 });
        if (!info || typeof info.network !== 'string') throw Object.assign(new Error('Engine info missing'), { status: 400 });
        if (this.network && info.network !== this.network) {
            throw Object.assign(new Error(`This page's engine (${info.network}) is not the expected one (${this.network}); reload the page`), { status: 409 });
        }
        let bridge = this.bridges.get(id);
        const registering = !bridge;
        if (registering) {
            if (this.bridges.size >= MAX_BRIDGES) throw Object.assign(new Error('Too many engine bridges'), { status: 503 });
            bridge = { id, info: null, lastSeen: 0, queue: [], pending: new Map(), wake: null };
            this.bridges.set(id, bridge);
        }
        bridge.info = { name: info.name || null, version: info.version || null, network: info.network, speed: speedOf(info) };
        bridge.lastSeen = Date.now();
        if (bridge.wake) bridge.wake();  // an older poll of the same page answers now
        // The first poll answers at once: the page sends its id from then on.
        if (!registering && !bridge.queue.length) {
            await new Promise((resolve) => {
                const timer = setTimeout(done, this.pollMs);
                function done() {
                    clearTimeout(timer);
                    if (bridge.wake === done) bridge.wake = null;
                    resolve();
                }
                bridge.wake = done;
            });
            bridge.lastSeen = Date.now();
        }
        if (closed()) return [];
        const jobs = bridge.queue.splice(0);
        return jobs.map(({ id: jobId, path: jobPath, body, budgetMs }) => ({ id: jobId, path: jobPath, body, budgetMs }));
    }

    /** The answer to a job: the engine's JSON, or its error message. */
    answer(id, jobId, result, error) {
        const bridge = this.bridges.get(String(id || ''));
        const job = bridge?.pending.get(Number(jobId));
        if (!job) return false;
        bridge.pending.delete(job.id);
        bridge.lastSeen = Date.now();
        clearTimeout(job.timer);
        if (typeof error === 'string') job.reject(new BridgeEngineError(error));
        else if (result && typeof result === 'object') job.resolve(result);
        else job.reject(new BridgeEngineError('The browser engine sent no answer'));
        return true;
    }

    /**
     * One engine request (path and body of the HTTP API) for `bridge`.
     * Rejects with BridgeLostError if the page goes away first. The page stops
     * a job that runs past its budget (from the page's speed); `timeoutMs`
     * covers the wait as well and is extended to outlast the budget.
     */
    request(bridge, enginePath, body, timeoutMs) {
        const budgetMs = engineBudget.jobBudgetMs(bridge.info?.speed, enginePath, body);
        const limitMs = Math.max(timeoutMs, budgetMs + 15000);
        return new Promise((resolve, reject) => {
            const job = { id: this.nextJob++, path: enginePath, body: body ?? null, budgetMs, resolve, reject, timer: null };
            job.timer = setTimeout(() => {
                bridge.pending.delete(job.id);
                const queued = bridge.queue.indexOf(job);
                if (queued >= 0) bridge.queue.splice(queued, 1);
                reject(new Error(`Engine ${enginePath} timed out after ${limitMs}ms in the browser`));
            }, limitMs);
            bridge.pending.set(job.id, job);
            bridge.queue.push(job);
            if (bridge.wake) bridge.wake();
        });
    }

    /** Drops bridges whose page stopped polling; their unanswered jobs fail over to bgserver. */
    sweep(now = Date.now()) {
        for (const [id, bridge] of this.bridges) {
            if (this.alive(bridge, now)) continue;
            this.bridges.delete(id);
            for (const job of bridge.pending.values()) {
                clearTimeout(job.timer);
                job.reject(new BridgeLostError('The page with the browser engine went away'));
            }
        }
    }

    /**
     * Connected pages and the speeds they measured (threads, and ms for the
     * standard position: see shared/engineBudget.js), at most 50 of them.
     */
    status() {
        const speeds = [...this.bridges.values()].map((bridge) => bridge.info?.speed).filter(Boolean).slice(0, 50);
        return { bridges: this.bridges.size, network: this.network, speeds };
    }

    close() {
        clearInterval(this.sweeper);
    }
}

let shared = null;

function getBridges() {
    if (!shared) shared = new EngineBridges();
    return shared;
}

module.exports = { BridgeEngineError, BridgeLostError, EngineBridges, getBridges };
