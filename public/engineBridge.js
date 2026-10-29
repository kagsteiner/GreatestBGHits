/* The engine in this browser (see src/engineBridge.js). Loads the WebAssembly
   engine from engine/ in a worker, registers with the server under a random id
   and computes the engine work of this page's requests: the page's fetch
   helpers send engineBridge.headers() with them. Until the engine is ready, or
   if it cannot run here, they go without, and the server's engine answers.

   Needs engine/bghelmet.js loaded before this file. */
(function startEngineBridge(root) {
  'use strict';
  const METHODS = { '/v1/info': 'info', '/v1/evaluate': 'evaluate', '/v1/move': 'move', '/v1/cube': 'cube', '/v1/analyze': 'analyze', '/v1/rollout': 'rollout' };
  const RETRY_MS = 3000;
  const id = Array.from(root.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const state = { id, ready: false, info: null, error: null, jobs: 0 };

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

  async function run(engine, job) {
    state.jobs += 1;
    let answer;
    try {
      const method = METHODS[job.path];
      if (!method) throw new Error(`Unknown engine request ${job.path}`);
      answer = { result: await engine[method](job.body || {}) };
    } catch (error) {
      answer = { error: String((error && error.message) || error) };
    }
    try {
      await post('engineBridge/answer', { bridge: id, job: job.id, ...answer });
    } catch {
      // The server falls back to its own engine once this page stops polling.
    }
  }

  async function serve(engine) {
    for (;;) {
      try {
        const { jobs } = await post('engineBridge/poll', { bridge: id, info: state.info });
        state.ready = true;
        // Jobs run in the worker one after another; polling goes on meanwhile.
        for (const job of jobs || []) run(engine, job);
      } catch (error) {
        state.ready = false;
        if (error.status === 409 || error.status === 400) {
          state.error = error.message;
          return;  // e.g. an outdated engine: the server's engine answers
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  }

  async function start() {
    if (!root.BGHelmet || typeof WebAssembly !== 'object') {
      state.error = 'WebAssembly is not available';
      return;
    }
    try {
      const threads = Math.max(1, Math.min(4, root.navigator.hardwareConcurrency || 1));
      const engine = root.BGHelmet.worker('engine/worker.js', { net: 'engine.bgnn', threads });
      const info = await engine.ready;
      state.info = { name: info.name, version: info.version, network: info.network, threads: info.threads };
      serve(engine);
    } catch (error) {
      state.error = String((error && error.message) || error);
    }
  }

  root.engineBridge = {
    state,
    /** Headers for this page's requests: the bridge id once the engine is ready. */
    headers() {
      return state.ready ? { 'X-Engine-Bridge': id } : {};
    }
  };

  // After the page itself has loaded: the engine (about 4 MB) is not needed at once.
  if (root.document.readyState === 'complete') setTimeout(start, 0);
  else root.addEventListener('load', () => setTimeout(start, 0), { once: true });
})(window);
