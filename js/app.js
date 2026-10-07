// Application shell: boot, navigation and the shared context handed to screens.

import { db, requestPersistence } from './offline/db.js';
import { api } from './api/client.js';
import { auth } from './auth/auth.js';
import { Store } from './session/store.js';
import { Sync } from './sync/sync.js';
import { DEFAULT_CONFIG, withDefaults, scanModes } from './core/defaults.js';
import { OCR_ENGINE, PALLET_PREFETCH, PALLET_THREADS } from './config.js';
import { createEngine } from './ocr/engine.js';
import './ocr/tesseract-engine.js';
import { PalletEngine } from './pallet/client.js';
import { assetsCached, prefetchAssets } from './pallet/assets.js';
import { h, sheet } from './ui/dom.js';
import { loginScreen } from './ui/login.js';
import { homeScreen } from './ui/home.js';
import { scannerScreen } from './ui/scanner.js';
import { historyScreen } from './ui/history.js';

const root = document.getElementById('app');
let config = DEFAULT_CONFIG;
let cleanup = null;
let enginePromise = null;
let palletEngine = null;
// Is the pallet reader on this device? 'unknown' | 'ready' | 'downloading' | 'missing' | 'on-demand'
const palletReader = { state: 'unknown', loaded: 0, total: 0 };
const listeners = new Set();
const notify = () => listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });

const sync = new Sync({ getDeviceId: () => auth.deviceId, onState: notify });
const store = new Store({
  getUser: () => auth.user, getConfig: () => config, getDeviceId: () => auth.deviceId,
  onChange: notify, onQueued: () => sync.queued(),
});

const screens = { login: loginScreen, home: homeScreen, scanner: scannerScreen, history: historyScreen };

const ctx = {
  store, sync,
  get deviceId() { return auth.deviceId; },
  config: () => config,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  go(name, params) {
    if (typeof cleanup === 'function') cleanup();
    cleanup = null;
    const r = screens[name](root, ctx, params);
    if (typeof r === 'function') cleanup = r;
  },
  alert(message) {
    const ok = h('button', { class: 'btn primary block' }, 'OK');
    const s = sheet([h('p', null, message), ok]);
    ok.onclick = s.close;
  },
  report(err) { console.error(err); },
  // One OCR engine for the whole app, created on first use.
  engine() {
    if (!enginePromise) {
      enginePromise = (async () => { const e = createEngine(OCR_ENGINE); await e.init(); return e; })();
      enginePromise.catch(() => { enginePromise = null; });
    }
    return enginePromise;
  },
  // Only one reader is kept in memory at a time (the pallet reader alone needs
  // a few hundred MB while it works). The scanner drops the one it is not
  // using; getting it back takes a second or two, from the device.
  releaseEngine() {
    const p = enginePromise;
    enginePromise = null;
    p?.then((e) => e.terminate()).catch(() => {});
  },
  releasePalletEngine() { palletEngine?.terminate(); },
  // The pallet reader lives in a worker and is started on first use.
  palletEngine() {
    if (!palletEngine) {
      const cores = navigator.hardwareConcurrency || 2;
      palletEngine = new PalletEngine({ getConfig: () => config, threads: Math.max(1, Math.min(PALLET_THREADS, Math.floor(cores / 2))) });
      palletEngine.onProgress((p) => { if (p.loaded >= p.total && palletReader.state !== 'ready') { palletReader.state = 'ready'; notify(); } });
    }
    return palletEngine;
  },
  palletReader,
  afterLogin,
};

/** Make sure the pallet reader's files are on the device (background, best effort). */
async function preparePalletReader() {
  if (!scanModes(config).some((m) => m.pipeline === 'pallet')) return;
  const base = new URL('./', document.baseURI).href;
  const set = (state, p = {}) => { Object.assign(palletReader, { state, ...p }); notify(); };
  if (await assetsCached(base)) return set('ready');
  if (!PALLET_PREFETCH) return set('on-demand');
  if (navigator.onLine === false) return set('missing');
  set('downloading', { loaded: 0, total: 0 });
  try {
    const r = await prefetchAssets(base, (p) => set('downloading', p));
    set(r === 'ready' ? 'ready' : 'missing');
  } catch { set('missing'); }
}

async function loadConfig() {
  config = withDefaults((await db.getMeta('config')) || DEFAULT_CONFIG);
  if (!api.enabled || !navigator.onLine) return;
  try {
    const fresh = await api.config();
    if (fresh?.validationRules) { config = withDefaults(fresh); await db.setMeta('config', fresh); notify(); }
  } catch { /* keep the cached copy */ }
}

async function afterLogin() {
  await loadConfig();
  const closed = await store.autoCompleteStale();
  sync.kick(0);
  ctx.engine().catch(() => {});   // warm up in the background
  preparePalletReader();
  ctx.go('home', closed ? { notice: `${closed} session${closed > 1 ? 's' : ''} from an earlier day ${closed > 1 ? 'were' : 'was'} closed automatically.` } : undefined);
}

async function boot() {
  try {
    await db.open();
  } catch (e) {
    root.textContent = 'This browser cannot store data on the device (private mode?). ULD Scanner needs device storage to work offline.';
    return;
  }
  requestPersistence();
  await auth.init();
  const redirect = api.enabled ? await auth.handleRedirect() : null;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  if (redirect?.error) return ctx.go('login', { error: redirect.error });
  if (!auth.user) return ctx.go('login');
  auth.refresh().catch(() => ctx.go('login', { error: 'NOT_WHITELISTED' }));
  await afterLogin();
}

boot();
window.__uld = { ctx, auth, db };   // handle for automated tests and support
