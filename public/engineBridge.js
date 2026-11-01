/* The engine in this browser (see src/engineBridge.js). Loads the WebAssembly
   engine from engine/ in a worker, times a standard position once a day (its
   speed, see shared/engineBudget.js), registers with the server under a random
   id and computes the engine work of this page's requests: the page's fetch
   helpers send engineBridge.headers() with them, and the server waits for
   this engine while it loads. Only where it cannot run at all (no
   WebAssembly, or an outdated copy) do they go without, and the server's
   engine answers.

   Its phase (state.phase): 'loading', 'initializing' (timing this device),
   'ready', or 'failed'. Elements with data-engine-status show it while the
   engine is not ready; until then engineBridge.limits() is null and pages
   offer no depths, so they always offer the same ones.

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
  const state = { id, phase: 'loading', ready: false, max: false, info: null, speed: null, limits: null, error: null, jobs: 0, stopped: 0 };
  const budget = root.engineBudget;
  let engine = null;
  const queue = [];
  let running = false;
  let switching = null;

  const STATUS = {
    loading: 'The engine is loading…',
    initializing: 'The engine is initializing…'
  };

  function setPhase(phase) {
    if (state.phase === phase) return;
    state.phase = phase;
    state.ready = phase === 'ready';
    showStatus();
    root.dispatchEvent(new Event('enginebridgechange'));
  }

  function fail(error) {
    state.error = String((error && error.message) || error);
    setPhase('failed');
  }

  function showStatus() {
    const text = state.phase === 'failed'
      ? `The engine cannot run in this browser (${state.error}); the server analyses instead.`
      : STATUS[state.phase] || '';
    root.document.querySelectorAll('[data-engine-status]').forEach((element) => {
      element.textContent = text;
      element.hidden = !text;
    });
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

  /**
   * Whether maximum performance gains anything here: more cores, and a page
   * cross-origin isolated (served over HTTPS, or from localhost), without
   * which the engine runs on one thread.
   */
  function maxUseful() {
    return root.crossOriginIsolated === true && threadsFor(true) > threadsFor(false);
  }

  /** Loads the engine with the threads for `max` (where useful), times it, and sets the limits. */
  async function load(wanted) {
    const max = wanted && maxUseful();
    setPhase('loading');
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
    setPhase('initializing');
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
    if (state.phase !== 'ready' || state.max === (max && maxUseful())) return;
    switching = (async () => {
      while (running) await new Promise((resolve) => setTimeout(resolve, 100));
      engine.terminate();
      await load(max);
      // The new speed reaches the server before the page offers what it allows.
      const { jobs } = await post('engineBridge/poll', { bridge: id, info: { ...state.info, speed: state.speed }, hello: true });
      queue.push(...(jobs || []));
    })();
    try {
      await switching;
      setPhase('ready');
    } catch (error) {
      fail(error);
    } finally {
      switching = null;
      work();
    }
  }

  async function serve() {
    for (;;) {
      try {
        const { jobs } = await post('engineBridge/poll', { bridge: id, info: { ...state.info, speed: state.speed } });
        if (!switching) setPhase('ready');
        queue.push(...(jobs || []));
        work();
      } catch (error) {
        if (error.status === 409 || error.status === 400) {
          fail(error);
          return;  // e.g. an outdated engine: the server's engine answers
        }
        // The server is unreachable for a moment: the page keeps its engine.
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  }

  async function start() {
    if (!root.BGHelmet || !budget || typeof WebAssembly !== 'object') {
      fail('WebAssembly is not available');
      return;
    }
    try {
      await load(savedMax());
      serve();
    } catch (error) {
      fail(error);
    }
  }

  root.engineBridge = {
    state,
    /** Headers for this page's requests: the bridge id, unless the engine cannot run here. */
    headers() {
      return state.phase === 'failed' ? {} : { 'X-Engine-Bridge': id };
    },
    /**
     * The analysis limits a page offers: null while the engine loads; then
     * this device's (see shared/engineBudget.js) on top of the server's
     * ({ plies, maxPlies, rollouts }), with `estimates` (ms by depth) and
     * `rolloutEstimates` / `cubeRolloutEstimates` (ms by mode); the server's
     * where the engine cannot run. The window gets 'enginebridgechange' when
     * that changes.
     */
    limits(server) {
      if (state.phase === 'failed' || !server) return server;
      if (!state.ready || !state.limits) return null;
      const { maxPlies, rollouts, estimates, rolloutEstimates, cubeRollouts, cubeRolloutEstimates } = state.limits;
      return { ...server, maxPlies, rollouts, estimates, rolloutEstimates, cubeRollouts, cubeRolloutEstimates };
    }
  };

  /** Checkboxes with data-engine-max switch maximum performance; hidden where it gains nothing. */
  function bindCheckboxes() {
    const boxes = [...root.document.querySelectorAll('input[data-engine-max]')];
    const useful = typeof WebAssembly === 'object' && maxUseful();
    for (const box of boxes) {
      (box.closest('label') || box).hidden = !useful;
      box.checked = savedMax();
      box.addEventListener('change', () => {
        boxes.forEach((other) => { other.checked = box.checked; });
        setMax(box.checked);
      });
    }
  }

  function bindPage() {
    bindCheckboxes();
    showStatus();
  }

  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', bindPage, { once: true });
  else bindPage();

  // After the page itself has loaded: the engine (about 4 MB) is not needed at once.
  if (root.document.readyState === 'complete') setTimeout(start, 0);
  else root.addEventListener('load', () => setTimeout(start, 0), { once: true });
})(window);
