// Pallet reader worker. Everything heavy (loading the models, finding and
// reading text) happens here, off the main thread, so the camera picture and
// the buttons never stutter while a frame is being read.
//
// Messages in:   {type:'init', config, options}
//                {type:'config', config}
//                {type:'read', id, frame:{data:ArrayBuffer,width,height}, options, skip:[bounds]}
// Messages out:  {type:'progress', loaded, total, downloading}
//                {type:'ready', info}        {type:'failed', code:'DOWNLOAD'|'START', message}
//                {type:'result', id, candidates, other, skipped, lines, detMs, recMs, recCalls}
//                {type:'error', id, message}

import * as ort from '../../vendor/ort/ort.wasm.min.js';
import { PaddleEngine } from '../paddle/engine.js';
import { PalletReader } from './reader.js';
import { toCandidate } from './candidate.js';
import { loadAssets } from './assets.js';

const BASE = new URL('../../', import.meta.url).href;     // the app's root folder
let reader = null, config = null;

function overlap(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter);
}

async function init(msg) {
  config = msg.config;
  let files;
  try {
    files = await loadAssets(BASE, (p) => postMessage({ type: 'progress', ...p }));
  } catch (e) {
    // Not on the device and not reachable: a different problem from "would not start".
    throw Object.assign(new Error(String(e?.message || e)), { code: 'DOWNLOAD' });
  }
  // Threads need a cross-origin isolated page (SharedArrayBuffer). Without
  // it the runtime works on one thread, which is what the timings assume.
  const threads = self.crossOriginIsolated ? Math.max(1, Math.min(msg.threads || 1, navigator.hardwareConcurrency || 1)) : 1;
  ort.env.wasm.numThreads = threads;
  // The runtime's two script files are kept with a .js ending (they come as
  // .mjs): some web hosts do not serve .mjs as JavaScript, and a module that
  // arrives with the wrong type is refused by the browser.
  ort.env.wasm.wasmPaths = { mjs: `${BASE}vendor/ort/ort-wasm-simd-threaded.js`, wasm: `${BASE}vendor/ort/ort-wasm-simd-threaded.wasm` };
  ort.env.wasm.wasmBinary = files.wasm;
  ort.env.logLevel = 'error';
  const engine = await PaddleEngine.create({
    ort, det: new Uint8Array(files.det), rec: new Uint8Array(files.rec), dict: files.dict,
    sessionOptions: { executionProviders: ['wasm'], graphOptimizationLevel: 'all', ...(msg.session || {}) },
  });
  ort.env.wasm.wasmBinary = undefined;          // compiled by now; let the 14 MB download buffer go
  reader = new PalletReader(engine, () => config, msg.options || {});
  postMessage({ type: 'ready', info: { threads, engine: engine.name } });
}

async function read(msg) {
  const img = { data: new Uint8ClampedArray(msg.frame.data), width: msg.frame.width, height: msg.frame.height };
  const known = msg.skip || [];
  const skipped = [];
  const res = await reader.readFrame(img, {
    ...(msg.options || {}),
    skip: known.length ? (bounds) => {
      const i = known.findIndex((k) => overlap(k, bounds) >= 0.5);
      if (i < 0) return false;
      skipped.push({ index: i, bounds });
      return true;
    } : undefined,
  });
  const candidates = res.readings.map((r) => toCandidate(r, config));
  const transfer = candidates.map((c) => c.evidenceImage?.data.buffer).filter(Boolean);
  postMessage({ type: 'result', id: msg.id, candidates, other: res.other, skipped, lines: res.lines.length,
    detMs: res.detMs, recMs: res.recMs, recCalls: res.recCalls }, transfer);
}

// One message at a time, in order.
let chain = Promise.resolve();
self.onmessage = (e) => {
  const msg = e.data;
  chain = chain.then(async () => {
    try {
      if (msg.type === 'init') await init(msg);
      else if (msg.type === 'config') config = msg.config;
      else if (msg.type === 'read') {
        if (!reader) throw new Error('Pallet reader is not ready');
        await read(msg);
      }
    } catch (err) {
      const message = String(err?.message || err);
      postMessage(msg.type === 'init' ? { type: 'failed', code: err?.code || 'START', message } : { type: 'error', id: msg.id, message });
    }
  });
};
