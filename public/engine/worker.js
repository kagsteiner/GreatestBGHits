// Web Worker running the engine, so the page stays responsive while it thinks.
// Start it with BGHelmet.worker(url, options) from bghelmet.js; keep this file next to
// bghelmet.js and the bghelmet-core*.js/.wasm files.
// Messages in:  {id, method: 'load', args: [options]} first, then {id, method, args: [request]}
//               (method: info, evaluate, move, cube, analyze, rollout, addNetwork, setThreads)
// Messages out: {id, result} | {id, error}
if (self.name === 'em-pthread') {
  // A search thread of the multi-threaded core: it starts itself.
  importScripts('bghelmet-core-mt.js');
} else {
  importScripts('bghelmet-core.js', 'bghelmet.js');
  if (self.crossOriginIsolated) importScripts('bghelmet-core-mt.js');

  let engine = null;
  self.onmessage = async ({data: {id, method, args}}) => {
    try {
      if (method === 'load') {
        // Relative network URLs are relative to this worker.
        const options = {...args[0]};
        if (typeof options.net === 'string') options.net = new URL(options.net, self.location.href).href;
        engine = await BGHelmet.load(options);
        self.postMessage({id, result: {...engine.info(), threads: engine.threads}});
        return;
      }
      if (!engine) throw new Error('bghelmet: engine not loaded');
      if (typeof engine[method] !== 'function') throw new Error(`bghelmet: unknown method ${method}`);
      self.postMessage({id, result: await engine[method](...args)});
    } catch (error) {
      self.postMessage({id, error: String((error && error.message) || error)});
    }
  };
}
