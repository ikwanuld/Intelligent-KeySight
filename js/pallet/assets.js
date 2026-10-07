// The pallet reader's large files: the text models and the WebAssembly
// runtime that executes them (about 30 MB together).
//
// They are NOT part of the service worker's install list, on purpose: one
// failed 15 MB download on a weak signal would otherwise make the whole app
// fail to install. Instead they are fetched one by one the first time they
// are needed, kept in their own cache, and found there on every later start,
// with or without a network. Updating the app does not download them again;
// only changing MODEL_VERSION does.

export const MODEL_VERSION = '1';
const CACHE_PREFIX = 'uld-pallet-reader-';
export const CACHE_NAME = `${CACHE_PREFIX}${MODEL_VERSION}`;

// `bytes` is only used to show progress before the server reports a size.
export const ASSETS = [
  { key: 'wasm', path: 'vendor/ort/ort-wasm-simd-threaded.wasm', bytes: 14239897 },
  { key: 'rec', path: 'vendor/paddle/rec.onnx', bytes: 10638037 },
  { key: 'det', path: 'vendor/paddle/det.onnx', bytes: 4985401 },
  { key: 'dict', path: 'vendor/paddle/dict.txt', bytes: 74948, text: true },
];
export const TOTAL_BYTES = ASSETS.reduce((s, a) => s + a.bytes, 0);

const hasCaches = () => typeof caches !== 'undefined';
const urlOf = (base, a) => new URL(`${a.path}?v=${MODEL_VERSION}`, base).href;

/** Are all the files already on the device? */
export async function assetsCached(base) {
  if (!hasCaches()) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    for (const a of ASSETS) if (!(await cache.match(urlOf(base, a)))) return false;
    return true;
  } catch { return false; }
}

async function download(url, expected, onBytes) {
  // no-store: the copy that matters is the one in our own cache; a second
  // one in the browser's HTTP cache would only waste space on the phone.
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || expected;
  if (!res.body?.getReader) { const b = await res.arrayBuffer(); onBytes(b.byteLength, b.byteLength); return b; }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.byteLength;
    onBytes(got, Math.max(total, got));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out.buffer;
}

/**
 * Get every file, from the device if it is there, otherwise from the network
 * (and then keep it).
 * @param base        URL of the app root
 * @param onProgress  ({loaded, total, downloading}) => void
 * @returns {{wasm:ArrayBuffer, det:ArrayBuffer, rec:ArrayBuffer, dict:string}}
 */
export async function loadAssets(base, onProgress = () => {}) {
  let cache = null;
  if (hasCaches()) {
    try {
      cache = await caches.open(CACHE_NAME);
      // Files of an earlier model version are of no use any more.
      for (const k of await caches.keys()) if (k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME) await caches.delete(k);
    } catch { cache = null; }
  }
  const done = new Map(), sizes = new Map(ASSETS.map((a) => [a.key, a.bytes]));
  let downloading = false;
  const report = () => {
    let loaded = 0, total = 0;
    for (const a of ASSETS) { loaded += done.get(a.key) || 0; total += sizes.get(a.key); }
    onProgress({ loaded, total, downloading });
  };
  const out = {};
  for (const a of ASSETS) {
    const url = urlOf(base, a);
    let buf = null;
    const hit = cache ? await cache.match(url).catch(() => null) : null;
    if (hit) buf = await hit.arrayBuffer();
    if (!buf) {
      downloading = true;
      buf = await download(url, a.bytes, (got, total) => { done.set(a.key, got); sizes.set(a.key, total); report(); });
      if (cache) {
        try {
          await cache.put(url, new Response(buf.slice(0), { headers: { 'Content-Type': a.text ? 'text/plain; charset=utf-8' : 'application/octet-stream', 'Content-Length': String(buf.byteLength) } }));
        } catch { /* storage full or blocked: works this time, downloads again next time */ }
      }
    }
    done.set(a.key, buf.byteLength); sizes.set(a.key, buf.byteLength); report();
    out[a.key] = a.text ? new TextDecoder().decode(buf) : buf;
  }
  return out;
}

/**
 * Put the files on the device without loading them into memory, so Pallets
 * mode works later with no network. Safe to call again and again: files that
 * are already there are skipped.
 * @returns {'ready'|'unavailable'} unavailable = this browser has no cache storage here
 */
export async function prefetchAssets(base, onProgress = () => {}) {
  if (!hasCaches()) return 'unavailable';
  const cache = await caches.open(CACHE_NAME);
  let done = 0;
  for (const a of ASSETS) {
    const url = urlOf(base, a);
    if (!(await cache.match(url))) {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      await cache.put(url, res);                 // streamed straight to storage
    }
    done += a.bytes;
    onProgress({ loaded: done, total: TOTAL_BYTES });
  }
  return 'ready';
}
