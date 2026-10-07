// Background sync. Local data is the source of truth until the server has
// acknowledged it; nothing is ever removed locally because a request failed.
//
// Conflicts are never resolved by "last write wins": the server keeps both
// versions and flags them for admin review, and the device keeps its own
// copy marked CONFLICT.

import { db, uuid } from '../offline/db.js';
import { api } from '../api/client.js';

const ORDER = { session: 0, scan: 1, event: 2, image: 3 };
const STORE = { session: 'sessions', scan: 'scans', event: 'events' };
const LOCAL_ONLY = ['local_image'];
const BATCH = 40;

export class Sync {
  constructor({ getDeviceId, onState }) {
    this.getDeviceId = getDeviceId; this.onState = onState;
    this.state = api.enabled ? 'SYNCED' : 'LOCAL';
    this.running = false; this.backoff = 5000; this.timer = null; this.pending = 0;
    addEventListener('online', () => this.kick(0));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.kick(0); });
  }

  _set(state) { this.state = state; this.onState?.(state, this.pending); }

  /** Something was written locally: show it as pending straight away. */
  queued() {
    if (api.enabled && this.state === 'SYNCED') this._set('PENDING');
    this.kick();
  }

  /** Ask for a sync soon. */
  kick(delay = 1500) {
    if (!api.enabled) return this._refreshLocal();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), delay);
  }

  async _refreshLocal() {
    this.pending = (await db.all('outbox')).length;
    this._set('LOCAL');
  }

  async run() {
    if (this.running || !api.enabled) return;
    this.running = true;
    try {
      let ops = (await db.all('outbox')).sort((a, b) => ORDER[a.entity] - ORDER[b.entity] || a.queued_at.localeCompare(b.queued_at));
      this.pending = ops.length;
      if (!ops.length) return this._set('SYNCED');
      if (!navigator.onLine) return this._set('PENDING');
      this._set('SYNCING');

      const data = ops.filter((o) => o.entity !== 'image');
      for (let i = 0; i < data.length; i += BATCH) await this._pushBatch(data.slice(i, i + BATCH));
      for (const o of ops.filter((x) => x.entity === 'image')) await this._pushImage(o);

      this.pending = (await db.all('outbox')).length;
      this.backoff = 5000;
      this._set(this.pending ? 'PENDING' : 'SYNCED');
      if (this.pending) this.kick(2000); // records changed while we were syncing
    } catch (e) {
      // Offline, server down, token expired: keep everything and retry later.
      this.pending = (await db.all('outbox')).length;
      if (e?.status === 401) { this._set('AUTH'); return; } // needs a fresh sign-in; data stays queued
      this._set('PENDING');
      this.backoff = Math.min(this.backoff * 2, 5 * 60 * 1000);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(), this.backoff);
    } finally {
      this.running = false;
    }
  }

  async _pushBatch(ops) {
    const payload = [];
    for (const o of ops) {
      const rec = await db.get(STORE[o.entity], o.entity_id);
      if (!rec) { await db.del('outbox', o.key); continue; }
      const meta = await db.get('syncmeta', o.key);
      const dataOut = { ...rec };
      for (const k of LOCAL_ONLY) delete dataOut[k];
      payload.push({ op_id: `${o.entity}:${o.entity_id}:${rec.rev}`, entity: o.entity, entity_id: o.entity_id,
        base_rev: meta?.server_rev ?? null, data: dataOut, _rev: rec.rev, _key: o.key });
    }
    if (!payload.length) return;
    const res = await api.sync(this.getDeviceId(), payload.map(({ _rev, _key, ...op }) => op));
    const byId = new Map((res.results || []).map((r) => [r.op_id, r]));

    for (const p of payload) {
      const r = byId.get(p.op_id);
      if (!r) continue; // not acknowledged: stays queued
      const store = STORE[p.entity];
      await db.tx([store, 'syncmeta', 'outbox', 'conflicts'], 'readwrite', (s) => {
        const req = s[store].get(p.entity_id);
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return;
          const unchanged = cur.rev === p._rev;   // not edited again while this version was in flight
          if (r.status === 'applied' || r.status === 'duplicate') {
            s.syncmeta.put({ key: p._key, server_rev: r.server_rev, state: unchanged ? 'SYNCED' : 'PENDING' });
            if (unchanged) s.outbox.delete(p._key);
          } else if (r.status === 'conflict') {
            // The server kept both versions for admin review. The device copy
            // stays exactly as it is.
            s.syncmeta.put({ key: p._key, server_rev: p.base_rev, state: 'CONFLICT' });
            s.conflicts.put({ conflict_id: uuid(), entity: p.entity, entity_id: p.entity_id, local: p.data,
              server: r.server_data ?? null, server_rev: r.server_rev ?? null, detected_at: new Date().toISOString() });
            if (unchanged) s.outbox.delete(p._key);
          } else { // 'rejected': the server refused this record; keep it, stop retrying this version
            s.syncmeta.put({ key: p._key, server_rev: p.base_rev, state: 'ERROR', error: r.reason || 'rejected' });
            if (unchanged) s.outbox.delete(p._key);
          }
        };
      });
    }
  }

  async _pushImage(o) {
    const img = await db.get('images', o.entity_id);
    if (!img || !img.upload) { await db.del('outbox', o.key); return; }
    await api.uploadImage({ image_reference: img.image_reference, scan_id: img.scan_id, session_id: img.session_id,
      captured_at: img.created_at }, img.blob);
    // The server now holds the crop; drop the local copy.
    await db.tx(['images', 'outbox'], 'readwrite', (s) => { s.images.delete(img.image_reference); s.outbox.delete(o.key); });
  }
}
