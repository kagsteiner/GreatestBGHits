// DarkBGHelmet in the browser: a thin wrapper around the WebAssembly engine
// (bghelmet-core.js/.wasm, single-threaded; bghelmet-core-mt.js/.wasm, multi-threaded).
// Requests and responses are the JSON of the HTTP API (docs/API.md).
//
// On a page, run the engine in a Web Worker (a search blocks for its whole thinking time):
//
//   <script src="bghelmet.js"></script>
//   const engine = BGHelmet.worker('/engine/worker.js', {net: '/engine/latest.bgnn', threads: 4});
//   await engine.ready;                      // resolves to /v1/info
//   const r = await engine.move({position: {xgid}, dice: [5, 2], options: {plies: 3}});
//
// Inside a worker (or in Node.js), BGHelmet.load() returns the same methods, synchronously:
//
//   importScripts('bghelmet-core.js', 'bghelmet.js');
//   const engine = await BGHelmet.load({net: 'latest.bgnn'});
//   engine.move(request)
//
// Threads: the multi-threaded core needs cross-origin isolation (the page and worker served with
// Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp).
// Without it, or with threads: 1, the single-threaded core is used.
(function (root) {
  'use strict';
  const METHODS = ['info', 'evaluate', 'move', 'cube', 'analyze', 'rollout'];
  const BEAROFF = '/data/bearoff_os15.bin';
  const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;

  async function bytes(source) {
    if (source instanceof Uint8Array) return source;
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    if (isNode && !/^https?:/.test(source)) return new Uint8Array(require('fs').readFileSync(source));
    const response = await fetch(source);
    if (!response.ok) throw new Error(`bghelmet: cannot load ${source} (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }

  // The bearoff database (14 MB) is computed on first use, then kept in IndexedDB.
  const cache = {
    open() {
      if (typeof indexedDB === 'undefined') return Promise.resolve(null);
      return new Promise(resolve => {
        const request = indexedDB.open('bghelmet', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('files');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
    },
    async get(key) {
      const db = await this.open();
      if (!db) return null;
      return new Promise(resolve => {
        const request = db.transaction('files').objectStore('files').get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
      });
    },
    async put(key, value) {
      const db = await this.open();
      if (db) db.transaction('files', 'readwrite').objectStore('files').put(value, key);
    },
  };

  function pickCore(threads) {
    const nodeCore = name => (isNode ? require(name) : null);
    const isolated = isNode || root.crossOriginIsolated === true;
    if (threads !== 1 && isolated) {
      const mt = root.createBGHelmetCoreMT || nodeCore('./bghelmet-core-mt.js');
      if (mt) return {create: mt, threaded: true};
    }
    const st = root.createBGHelmetCore || nodeCore('./bghelmet-core.js');
    if (!st) throw new Error('bghelmet: load bghelmet-core.js first');
    return {create: st, threaded: false};
  }

  // options: net (URL, path in Node.js, or bytes; default 'latest.bgnn'), threads (default: all
  //   cores, at most 16; 1 = single-threaded core), hashMb (transposition table, default 32),
  //   bearoff (bytes of bearoff_os15.bin, skips the IndexedDB cache), moduleOptions.
  async function load(options = {}) {
    const hardware = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) ||
      (isNode ? require('os').availableParallelism() : 1);
    let threads = Math.max(1, Math.min(options.threads || hardware, 16));
    const core = pickCore(threads);
    if (!core.threaded) threads = 1;
    // The search uses the calling thread plus threads - 1 workers, started now.
    const moduleOptions = {...(options.moduleOptions || {}), ...(core.threaded ? {bgPoolSize: threads - 1} : {})};
    const [module, net] = await Promise.all([core.create(moduleOptions), bytes(options.net || 'latest.bgnn')]);
    const fs = module.FS;
    fs.mkdirTree('/nets');
    fs.mkdirTree('/data');
    fs.writeFile('/nets/default.bgnn', net);
    const bearoff = options.bearoff ? await bytes(options.bearoff) : await cache.get('bearoff_os15');
    if (bearoff) fs.writeFile(BEAROFF, bearoff);

    const str = (fn, ...args) => module.ccall(fn, 'string', args.map(a => typeof a === 'number' ? 'number' : 'string'), args);
    const err = str('bg_init', '/nets/default.bgnn', '/data', threads, options.hashMb || 32);
    if (err) throw new Error('bghelmet: ' + err);
    if (!bearoff && !options.bearoff) cache.put('bearoff_os15', fs.readFile(BEAROFF)).catch(() => {});

    const call = (method, request) => {
      const reply = JSON.parse(str('bg_call', method, JSON.stringify(request || {})));
      if (reply && reply.error !== undefined && Object.keys(reply).length === 1) throw new Error(reply.error);
      return reply;
    };
    const engine = {
      version: str('bg_version'),
      threads,
      // Another network under `name`, chosen per request with options.network.
      async addNetwork(name, source) {
        const path = `/nets/${name.replace(/[^\w.-]/g, '_')}.bgnn`;
        fs.writeFile(path, await bytes(source));
        const e = str('bg_add_network', name, path);
        if (e) throw new Error('bghelmet: ' + e);
      },
      // At most the number of threads the engine was loaded with (its workers start on load).
      setThreads(n) {
        if (!core.threaded) return;
        engine.threads = Math.max(1, Math.min(n, threads));
        module.ccall('bg_set_threads', null, ['number'], [engine.threads]);
      },
    };
    for (const m of METHODS) engine[m] = request => call(m, request);
    return engine;
  }

  // Page side: the engine in a Web Worker (web/worker.js), every method returning a promise.
  function worker(url, options = {}) {
    const w = new Worker(url);
    const pending = new Map();
    let next = 0;
    const send = (method, args) => new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, {resolve, reject});
      w.postMessage({id, method, args});
    });
    w.onmessage = ({data}) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.error !== undefined) p.reject(new Error(data.error));
      else p.resolve(data.result);
    };
    w.onerror = event => {
      for (const p of pending.values()) p.reject(new Error(event.message || 'bghelmet worker failed'));
      pending.clear();
    };
    const client = {
      ready: send('load', [options]),
      addNetwork: (name, source) => send('addNetwork', [name, source]),
      setThreads: n => send('setThreads', [n]),
      terminate: () => w.terminate(),
    };
    for (const m of METHODS) client[m] = request => send(m, [request]);
    return client;
  }

  const api = {load, worker, METHODS};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BGHelmet = api;
})(typeof self !== 'undefined' ? self : globalThis);
