/* The engine in this browser (see src/engineBridge.js). Loads the WebAssembly
   engine from engine/ in a worker, times a standard position once a day (its
   speed, see shared/engineBudget.js), registers with the server under a random
   id and computes the engine work of this page's requests: the page's fetch
   helpers send engineBridge.headers() with them. Until the engine is ready, or
   if it cannot run here, they go without, and the server's engine answers.

   It uses up to 4 cores, which keeps phones cool. "Maximum performance"
   (a checkbox with data-engine-max on the page, kept in this browser) uses
   all of them, up to the engine's 16, and offers deeper analyses.

   Needs engine/bghelmet.js and shared/engineBudget.js loaded before this file. */
(function startEngineBridge(root) {
  'use strict';
  const METHODS = { '/v1/info': 'info', '/v1/evaluate': 'evaluate', '/v1/move': 'move', '/v1/cube': 'cube', '/v1/analyze': 'analyze', '/v1/rollout': 'rollout' };
  const RETRY_MS = 3000;
  const SPEED_KEY = 'bgEngineSpeed';
  const SPEED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const MAX_KEY = 'bgEngineMax';
  const id = Array.from(root.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const state = { id, ready: false, max: false, info: null, speed: null, limits: null, error: null, jobs: 0, stopped: 0 };
  const budget = root.engineBudget;
  let engine = null;
  const queue = [];
  let running = false;
  let switching = null;

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

  function savedMax() {
    try {
      return root.localStorage.getItem(MAX_KEY) === '1';
    } catch {
      return false;
    }
  }

  function threadsFor(max) {
    const cores = root.navigator.hardwareConcurrency || 1;
    return Math.max(1, Math.min(max ? 16 : 4, cores));
  }

  /** Loads the engine with the threads for `max`, times it, and sets the limits. */
  async function load(max) {
    engine = loadEngine(threadsFor(max));
    const info = await engine.ready;
    state.info = { name: info.name, version: info.version, network: info.network, threads: info.threads };
    state.max = max;
    state.speed = { ...await measureSpeed(state.info), max };
    state.limits = budget.limits(state.speed);
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
    if (running || switching) return;
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

  /**
   * Switches maximum performance on or off: once the engine is idle, loads it
   * with the other number of threads and tells the server the new speed. Jobs
   * arriving meanwhile wait.
   */
  async function setMax(max) {
    try {
      root.localStorage.setItem(MAX_KEY, max ? '1' : '0');
    } catch {
      // only for this page then
    }
    while (switching) await switching.catch(() => {});
    if (!state.info || state.max === max) return;
    switching = (async () => {
      while (running) await new Promise((resolve) => setTimeout(resolve, 100));
      engine.terminate();
      await load(max);
    })();
    try {
      await switching;
    } catch (error) {
      state.error = String((error && error.message) || error);
    } finally {
      switching = null;
    }
    root.dispatchEvent(new Event('enginebridgechange'));
    if (state.ready) {
      // An extra poll carries the new speed at once (the waiting one answers then).
      post('engineBridge/poll', { bridge: id, info: { ...state.info, speed: state.speed } })
        .then(({ jobs }) => queue.push(...(jobs || [])))
        .catch(() => {})
        .finally(work);
    } else {
      work();
    }
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
      await load(savedMax());
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
     * `rolloutEstimates` / `cubeRolloutEstimates` (ms by mode). The window
     * gets 'enginebridgechange' when that changes.
     */
    limits(server) {
      if (!state.ready || !state.limits || !server) return server;
      const { maxPlies, rollouts, estimates, rolloutEstimates, cubeRollouts, cubeRolloutEstimates } = state.limits;
      return { ...server, maxPlies, rollouts, estimates, rolloutEstimates, cubeRollouts, cubeRolloutEstimates };
    }
  };

  /**
   * Checkboxes with data-engine-max switch maximum performance; hidden where
   * the engine cannot run, or where it would gain no cores.
   */
  function bindCheckboxes() {
    const boxes = [...root.document.querySelectorAll('input[data-engine-max]')];
    const useful = typeof WebAssembly === 'object' && threadsFor(true) > threadsFor(false);
    for (const box of boxes) {
      (box.closest('label') || box).hidden = !useful;
      box.checked = savedMax();
      box.addEventListener('change', () => {
        boxes.forEach((other) => { other.checked = box.checked; });
        setMax(box.checked);
      });
    }
  }

  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', bindCheckboxes, { once: true });
  else bindCheckboxes();

  // After the page itself has loaded: the engine (about 4 MB) is not needed at once.
  if (root.document.readyState === 'complete') setTimeout(start, 0);
  else root.addEventListener('load', () => setTimeout(start, 0), { once: true });
})(window);
