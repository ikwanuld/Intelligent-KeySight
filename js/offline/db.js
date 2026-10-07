// IndexedDB wrapper. All operational data lives here first; the server is
// only ever a copy.

const NAME = 'uld-scanner';
const VERSION = 1;

const SCHEMA = {
  meta: { keyPath: 'key' },
  sessions: { keyPath: 'session_id', indexes: { day: 'day', status: 'status' } },
  scans: { keyPath: 'scan_id', indexes: { session_id: 'session_id' } },
  events: { keyPath: 'event_id', indexes: { session_id: 'session_id' } },
  images: { keyPath: 'image_reference', indexes: { scan_id: 'scan_id' } },
  outbox: { keyPath: 'key' },          // one pending op per entity (coalesced)
  // Sync bookkeeping lives apart from the records themselves, so the scanner
  // and the sync engine never overwrite each other's fields.
  syncmeta: { keyPath: 'key' },        // { key:'scan:<id>', server_rev, state, error }
  conflicts: { keyPath: 'conflict_id' },
};

let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const [name, def] of Object.entries(SCHEMA)) {
        if (d.objectStoreNames.contains(name)) continue;
        const s = d.createObjectStore(name, { keyPath: def.keyPath });
        for (const [idx, path] of Object.entries(def.indexes || {})) s.createIndex(idx, path);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database upgrade blocked by another tab'));
  });
  return dbp;
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

/** Run `fn` inside one transaction; resolves when the transaction commits. */
async function tx(stores, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    try { result = fn(Object.fromEntries([].concat(stores).map((s) => [s, t.objectStore(s)]))); }
    catch (e) { t.abort(); reject(e); }
  });
}

export const db = {
  open, tx,
  async get(store, key) { const d = await open(); return wrap(d.transaction(store).objectStore(store).get(key)); },
  async all(store) { const d = await open(); return wrap(d.transaction(store).objectStore(store).getAll()); },
  async byIndex(store, index, key) {
    const d = await open(); return wrap(d.transaction(store).objectStore(store).index(index).getAll(key));
  },
  put(store, value) { return tx(store, 'readwrite', (s) => { s[store].put(value); }); },
  del(store, key) { return tx(store, 'readwrite', (s) => { s[store].delete(key); }); },
  async getMeta(key, fallback = null) { const r = await this.get('meta', key); return r ? r.value : fallback; },
  setMeta(key, value) { return this.put('meta', { key, value }); },
};

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence() {
  try { return (await navigator.storage?.persist?.()) || false; } catch { return false; }
}
