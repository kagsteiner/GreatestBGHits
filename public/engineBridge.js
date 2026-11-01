/* The engine in this browser (see src/engineBridge.js). Loads the WebAssembly
   engine from engine/ in a worker, times a standard position once a day (its
   speed, see shared/engineBudget.js), registers with the server under a random
   id and computes the engine work of this page's requests: the page's fetch
   helpers send engineBridge.headers() with them. Until the engine is ready, or
   if it cannot run here, they go without, and the server's engine answers.

   Needs engine/bghelmet.js and shared/engineBudget.js loaded before this file. */
(function startEngineBridge(root) {
  'use strict';
  const METHODS = { '/v1/info': 'info', '/v1/evaluate': 'evaluate', '/v1/move': 'move', '/v1/cube': 'cube', '/v1/analyze': 'analyze', '/v1/rollout': 'rollout' };
  const RETRY_MS = 3000;
  const SPEED_KEY = 'bgEngineSpeed';
  const SPEED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const id = Array.from(root.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const state = { id, ready: false, info: null, speed: null, limits: null, error: null, jobs: 0, stopped: 0 };
  const budget = root.engineBudget;
  let engine = null;
  const queue = [];
  let running = false;

  function setReady(ready) {
    if (state.ready === ready) return;
    state.ready = ready;
    root.dispatchEvent(new Event('enginebridgechange'));
  }

  async function post(path, body) {
    const response = await root.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { status: response.status });
    return payload;
  }

  function loadEngine(threads) {
    return root.BGHelmet.worker('engine/worker.js', { net: 'engine.bgnn', threads });
  }

  /**
   * This device's speed: from today's check, else timed now. One run only, as
   * the costs were measured: the engine would answer a repeat from its cache.
   */
  async function measureSpeed(info) {
    const key = `${info.version}|${info.network}|${info.threads}`;
    try {
      const saved = JSON.parse(root.localStorage.getItem(SPEED_KEY) || 'null');
      if (saved && saved.key === key && Date.now() - saved.at < SPEED_MAX_AGE_MS && budget.valid(saved.speed)) return saved.speed;
    } catch {
      // measured again below
    }
    const started = root.performance.now();
    await engine.move(budget.SPEED_CHECK);
    const speed = { benchMs: Math.round((root.performance.now() - started) * 10) / 10, threads: info.threads };
    try {
      root.localStorage.setItem(SPEED_KEY, JSON.stringify({ key, at: Date.now(), speed }));
    } catch {
      // measured again next time
    }
    return speed;
  }

  /**
   * One job at a time, as the worker computes them. A job that runs past its
   * budget (set by the server from this device's speed) stops the engine:
   * the worker is replaced, the job answered as too deep, and the queue goes on.
   */
  async function work() {
    if (running) return;
    running = true;
    while (queue.length) {
      const job = queue.shift();
      state.jobs += 1;
      let answer;
      let timer = null;
      try {
        const method = METHODS[job.path];
        if (!method) throw new Error(`Unknown engine request ${job.path}`);
        const overrun = new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('overrun'), { overrun: true })), job.budgetMs || 120000);
        });
        answer = { result: await Promise.race([engine[method](job.body || {}), overrun]) };
      } catch (error) {
        if (error && error.overrun) {
          state.stopped += 1;
          const seconds = Math.round((job.budgetMs || 120000) / 1000);
          answer = { error: `too deep for this device: stopped after ${seconds} s` };
          await restart();
        } else {
          answer = { error: String((error && error.message) || error) };
        }
      } finally {
        clearTimeout(timer);
      }
      try {
        await post('engineBridge/answer', { bridge: id, job: job.id, ...answer });
      } catch {
        // The server falls back to its own engine once this page stops polling.
      }
    }
    running = false;
  }

  /** A fresh worker in place of one stopped mid-search (the bearoff database is cached). */
  async function restart() {
    engine.terminate();
    engine = loadEngine(state.info.threads);
    await engine.ready;
  }

  async function serve() {
    for (;;) {
      try {
        const { jobs } = await post('engineBridge/poll', { bridge: id, info: { ...state.info, speed: state.speed } });
        setReady(true);
        queue.push(...(jobs || []));
        work();
      } catch (error) {
        setReady(false);
        if (error.status === 409 || error.status === 400) {
          state.error = error.message;
          return;  // e.g. an outdated engine: the server's engine answers
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  }

  async function start() {
    if (!root.BGHelmet || !budget || typeof WebAssembly !== 'object') {
      state.error = 'WebAssembly is not available';
      return;
    }
    try {
      const threads = Math.max(1, Math.min(4, root.navigator.hardwareConcurrency || 1));
      engine = loadEngine(threads);
      const info = await engine.ready;
      state.info = { name: info.name, version: info.version, network: info.network, threads: info.threads };
      state.speed = await measureSpeed(state.info);
      state.limits = budget.limits(state.speed);
      serve();
    } catch (error) {
      state.error = String((error && error.message) || error);
    }
  }

  root.engineBridge = {
    state,
    /** Headers for this page's requests: the bridge id once the engine is ready. */
    headers() {
      return state.ready ? { 'X-Engine-Bridge': id } : {};
    },
    /**
     * The analysis limits a page offers: the server's ({ plies, maxPlies,
     * rollouts }) until the engine is ready, then this device's (see
     * shared/engineBudget.js), with `estimates` (ms by depth) and
     * `rolloutEstimates` (ms by mode). The window gets 'enginebridgechange'
     * when that changes.
     */
    limits(server) {
      if (!state.ready || !state.limits || !server) return server;
      const { maxPlies, rollouts, estimates, rolloutEstimates } = state.limits;
      return { ...server, maxPlies, rollouts, estimates, rolloutEstimates };
    }
  };

  // After the page itself has loaded: the engine (about 4 MB) is not needed at once.
  if (root.document.readyState === 'complete') setTimeout(start, 0);
  else root.addEventListener('load', () => setTimeout(start, 0), { once: true });
})(window);
