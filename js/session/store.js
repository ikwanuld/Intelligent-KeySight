// Sessions and scans. Every change is written to IndexedDB together with an
// outbox entry in ONE transaction, so a crash can never leave a scan saved
// but unsynced, or queued but missing.

import { db, uuid } from '../offline/db.js';
import { validate, normalize } from '../validation/validator.js';
import { suggest } from '../correction/corrector.js';
import { findDuplicate } from '../duplicate/duplicate.js';
import { evaluate, confidenceStatus } from './status.js';
import { canvasToBlob } from '../ocr/preprocess.js';

const iso = (t = Date.now()) => new Date(t).toISOString();
export const localDay = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const OPEN = ['DRAFT', 'IN_PROGRESS'];
export const isOpen = (s) => OPEN.includes(s.status);

export class Store {
  constructor({ getUser, getConfig, getDeviceId, onChange, onQueued }) {
    Object.assign(this, { getUser, getConfig, getDeviceId, onChange, onQueued });
    this.session = null;   // active session
    this.scans = [];       // scans of the active session, oldest first
  }

  // ---------------------------------------------------------------- write --

  _touch(rec) {
    rec.rev = (rec.rev || 0) + 1;
    rec.updated_at = iso();
    return rec;
  }

  /** Persist records + outbox entries atomically. items: [store, record, id] */
  async _commit(items, extra) {
    const stores = [...new Set([...items.map((i) => i[0]), 'outbox', ...(extra?.stores || [])])];
    await db.tx(stores, 'readwrite', (s) => {
      for (const [store, rec, id] of items) {
        s[store].put(rec);
        const entity = store.replace(/s$/, '');
        s.outbox.put({ key: `${entity}:${id}`, entity, entity_id: id, queued_at: iso() });
      }
      extra?.run?.(s);
    });
    this.onQueued?.();
    this.onChange?.();
  }

  _event(type, detail = {}, session = this.session) {
    return { event_id: uuid(), session_id: session.session_id, type, user_id: this.getUser().user_id,
      at: iso(), detail, rev: 1 };
  }

  // -------------------------------------------------------------- sessions --

  async startSession({ station, zone, device }) {
    const user = this.getUser();
    const day = localDay();
    const mine = (await db.byIndex('sessions', 'day', day)).filter((s) => s.device_id === this.getDeviceId());
    const seq = String(mine.length + 1).padStart(2, '0');
    const session = this._touch({
      session_id: uuid(),
      session_reference: `${station.station_code}-${day.replace(/-/g, '')}-${this.getDeviceId().slice(0, 3).toUpperCase()}${seq}`,
      created_by: user.user_id, created_by_name: user.name,
      station_id: station.station_id, station_code: station.station_code,
      zone_id: zone.zone_id, zone_name: zone.zone_name,   // name kept so history survives a rename
      day, started_at: iso(), completed_at: null, last_activity_at: iso(),
      status: 'DRAFT', completion_type: null,
      device_id: this.getDeviceId(), device: device || null,
      counters: { duplicates: 0, multi_scans: 0 },
      config_version: this.getConfig().config_version,
    });
    const ev = this._event('SESSION_STARTED', {}, session);
    await this._commit([['sessions', session, session.session_id], ['events', ev, ev.event_id]]);
    this.session = session; this.scans = [];
    return session;
  }

  async openSession(sessionId) {
    this.session = await db.get('sessions', sessionId);
    this.scans = (await db.byIndex('scans', 'session_id', sessionId)).sort((a, b) => a.created_at.localeCompare(b.created_at));
    return this.session;
  }

  closeActive() { this.session = null; this.scans = []; }

  canResume(session) {
    const u = this.getUser();
    return isOpen(session) && session.day === localDay() && u.authorized_station_ids.includes(session.station_id);
  }

  /** Record a resume. A different user taking over is logged as a takeover. */
  async resume(sessionId) {
    const s = await this.openSession(sessionId);
    if (!this.canResume(s)) throw new Error('This session can no longer be resumed.');
    const user = this.getUser();
    const takeover = user.user_id !== (s.resumed_by || s.created_by);
    const events = [this._event('SESSION_RESUMED', { from_device: s.device_id })];
    if (takeover) { events.push(this._event('STAFF_TAKEOVER', { from: s.resumed_by || s.created_by })); s.resumed_by = user.user_id; }
    s.device_id = this.getDeviceId();
    s.last_activity_at = iso();
    this._touch(s);
    await this._commit([['sessions', s, s.session_id], ...events.map((e) => ['events', e, e.event_id])]);
    return s;
  }

  async logEvent(type, detail) {
    if (!this.session) return;
    const ev = this._event(type, detail);
    await this._commit([['events', ev, ev.event_id]]);
  }

  async updateDevice(device) {
    if (!this.session) return;
    this.session.device = device; this._touch(this.session);
    await this._commit([['sessions', this.session, this.session.session_id]]);
  }

  counts(scans = this.scans) {
    const c = { containers: 0, pallets: 0, other: 0, pending: 0, rejected: 0 };
    for (const s of scans) {
      if (s.state === 'PENDING') c.pending++;
      else if (s.state === 'REJECTED') c.rejected++;
      else if (s.state === 'AUTO_SAVED' || !s.operational) c.other++;
      else if (s.category === 'PALLET') c.pallets++;
      else c.containers++;
    }
    return c;
  }

  async complete(type = 'MANUAL', session = this.session, at = Date.now()) {
    session.status = type === 'AUTO' ? 'AUTO_COMPLETED' : 'COMPLETED';
    session.completion_type = type;
    session.completed_at = iso(at);
    session.completed_by = type === 'AUTO' ? null : this.getUser().user_id;
    this._touch(session);
    const ev = this._event(type === 'AUTO' ? 'SESSION_AUTO_COMPLETED' : 'SESSION_COMPLETED',
      type === 'AUTO' ? { recorded_at: iso() } : {}, session);
    await this._commit([['sessions', session, session.session_id], ['events', ev, ev.event_id]]);
    if (this.session?.session_id === session.session_id) this.closeActive();
  }

  /**
   * Day-end rule: sessions left open on an earlier calendar day are finalised
   * as AUTO_COMPLETED at the end of their own day. Nothing is deleted;
   * unconfirmed items stay in the record as they were.
   */
  async autoCompleteStale() {
    const today = localDay();
    const stale = (await db.all('sessions')).filter((s) => isOpen(s) && s.day < today);
    for (const s of stale) {
      const [y, m, d] = s.day.split('-').map(Number);
      await this.complete('AUTO', s, new Date(y, m - 1, d, 23, 59, 59, 999).getTime());
    }
    return stale.length;
  }

  // ----------------------------------------------------------------- scans --

  _existing(exceptId) {
    return this.scans.filter((s) => s.scan_id !== exceptId)
      .map((s) => ({ value: s.value, valid: s.validation_status !== 'INVALID', scan: s }));
  }

  duplicateOf(value, valid, exceptId) {
    const d = findDuplicate({ value, valid }, this._existing(exceptId), this.getConfig());
    return d ? d.scan : null;
  }

  _describe(scan) {
    const ev = evaluate(scan, this.getConfig());
    const v = ev.validation;
    scan.validation_status = ev.status;
    scan.review_reasons = ev.reasons;
    scan.prefix = v.parts ? v.parts.prefix : normalize(scan.value).slice(0, 3);
    scan.category = v.category;
    scan.operational = v.operational;
    scan.rule_id = v.rule?.rule_id ?? null;
    scan.rule_version = v.rule?.rule_version ?? null;
    return ev;
  }

  /**
   * Take one reliable detection from the tracker (or Multi-Scan).
   * @param category what is being counted right now ('CONTAINER' or 'PALLET', from the scan mode)
   * @returns {{outcome:'PENDING'|'AUTO_SAVED'|'DUPLICATE'|'REJECTED_BEFORE', scan}}
   */
  async addDetection(r, source = 'SINGLE', { category = 'CONTAINER' } = {}) {
    const user = this.getUser();
    const obs = r.obs, a = obs.assess;
    const rawOk = a.raw.status !== 'INVALID' && !obs.partial;
    const counted = (v) => v.status !== 'INVALID' && v.category === category && v.operational;

    // Already in this session? Either exactly as read, or as the number the
    // reading is suggested to be (a misread of something scanned earlier
    // must not come back as a second item).
    let dup = this.duplicateOf(obs.raw, rawOk);
    if (!dup && a.suggestion) dup = this.duplicateOf(a.suggestion.suggestion, true);
    if (dup) {
      // Saved silently earlier, while the other kind of ULD was being
      // scanned, and now scanned on purpose: bring it up for confirmation.
      if (dup.state === 'AUTO_SAVED' && rawOk && counted(a.raw) && normalize(dup.value) === normalize(obs.raw)) {
        return this._promote(dup, r, source);
      }
      this.session.counters.duplicates++;   // aggregate only; no per-attempt records
      return { outcome: dup.state === 'REJECTED' ? 'REJECTED_BEFORE' : 'DUPLICATE', scan: dup };
    }

    const now = Date.now();
    const scan = {
      scan_id: uuid(), session_id: this.session.session_id,
      value: obs.raw, uld_number: null, raw_ocr: obs.raw,
      suggested_correction: a.suggestion ? a.suggestion.suggestion : null,
      correction_accepted: null, final_value: null,
      manually_added: false, manually_corrected: false,
      confirmed: false, review_acknowledged: false, confirmed_by: null, confirmed_at: null,
      image_reference: null,
      // What the OCR engine actually read, frame by frame (server: OCR_OBSERVATIONS).
      ocr_observations: (r.variants || [{ raw_text: obs.raw, frames: 1, overall_confidence: Math.round(r.conf), character_confidence: obs.charConf }]).slice(0, 6),
      env: obs.env || null,
      history: [{ action: 'DETECTED', by: user.user_id, at: iso(now), value: obs.raw }],
      created_by: user.user_id, created_at: iso(now),
    };
    this._reading(scan, r, source, now);
    const ev = this._describe(scan);

    // A recognised ULD that is not what is being counted right now (a pallet
    // while scanning containers, or the other way round): saved silently,
    // never shown as a popup, never counted. Only when the raw reading is
    // itself usable, because applying a correction silently is not allowed.
    const other = rawOk && ev.validation.category !== 'OTHER' && !counted(ev.validation);
    scan.state = other ? 'AUTO_SAVED' : 'PENDING';
    if (other) { scan.final_value = scan.uld_number = scan.value; }

    // The crop is kept on the device while the item is unresolved and is
    // deleted again if the scan turns out to be a clean, confident read.
    let image = await this._crop(scan, obs, now);
    if (image && other && this._needsImage(scan)) { image.upload = true; scan.image_reference = image.image_reference; }
    if (image && other && !image.upload) image = null;
    if (image) scan.local_image = image.image_reference;

    return this._saveScan(scan, other ? 'AUTO_SAVED' : 'PENDING', image);
  }

  /** The part of a scan record that describes one reading (set when detected, replaced when promoted). */
  _reading(scan, r, source, now) {
    const cfg = this.getConfig(), obs = r.obs;
    const review = [...(obs.reviewReasons || [])];
    if (r.conflict) review.push('Read differently in another frame');
    scan.source = source;
    scan.engine = obs.engine || null; scan.pipeline = obs.pipeline || 'container';
    scan.cloud_fallback = !!r.cloud;
    scan.confidence_status = confidenceStatus(r.conf, cfg);
    scan.confidence = { overall: Math.round(r.conf), min: Math.round(obs.minConf), characters: obs.charConf,
      detection: null, image_quality: obs.env?.quality_score ?? null };
    scan.timing = { first_seen_at: iso(r.firstSeen || now), shown_at: iso(now), ocr_ms: obs.ocrMs ?? null, frames: r.frames || 1 };
    // review: reasons for a second look that come from how it was read
    // unreadable: the reader gave up; the value is only a starting point for editing
    scan.flags = { disagreement: !!r.disagreement, local_ocr: r.localRaw ?? null, review, unreadable: !!obs.partial };
  }

  async _crop(scan, obs, now) {
    if (!obs.evidence) return null;
    const blob = await canvasToBlob(obs.evidence);
    return blob ? { image_reference: uuid(), scan_id: scan.scan_id, session_id: scan.session_id, blob, created_at: iso(now), upload: false } : null;
  }

  /** An "Other ULD" saved silently earlier is now scanned in its own mode: queue it like a new detection. */
  async _promote(scan, r, source) {
    const now = Date.now(), obs = r.obs;
    this._reading(scan, r, source, now);
    scan.state = 'PENDING'; scan.final_value = scan.uld_number = null;
    scan.suggested_correction = null; scan.correction_accepted = null;
    scan.history.push({ action: 'DETECTED', by: this.getUser().user_id, at: iso(now), value: obs.raw, note: 'scanned again in its own mode' });
    this._describe(scan);
    const image = await this._crop(scan, obs, now);
    if (image) scan.local_image = image.image_reference;
    return this._saveScan(scan, 'PENDING', image);
  }

  async _saveScan(scan, outcome, image) {
    this._touch(scan);
    const items = [['scans', scan, scan.scan_id]];
    const s = this.session;
    if (s.status === 'DRAFT') s.status = 'IN_PROGRESS';
    s.last_activity_at = iso(); this._touch(s);
    items.push(['sessions', s, s.session_id]);
    if (!this.scans.includes(scan)) this.scans.push(scan);
    await this._commit(items, image ? {
      stores: ['images'],
      run: (st) => {
        st.images.put(image);
        if (image.upload) st.outbox.put({ key: `image:${image.image_reference}`, entity: 'image', entity_id: image.image_reference, queued_at: iso() });
      },
    } : undefined);
    return { outcome, scan };
  }

  /** Which scans keep their crop (data minimisation: clean reads keep none). */
  _needsImage(scan) {
    return scan.state === 'REJECTED' || scan.manually_corrected || !!scan.suggested_correction ||
      scan.flags?.disagreement || scan.flags?.unreadable || scan.flags?.review?.length > 0 ||
      scan.confidence_status !== 'HIGH' || scan.validation_status === 'INVALID' ||
      scan.history.some((h) => h.action === 'REJECTED');
  }

  async _settleImage(scan) {
    const ref = scan.local_image;
    if (!ref) return null;
    if (this._needsImage(scan)) {
      scan.image_reference = ref;
      return (s) => {
        const req = s.images.get(ref);
        req.onsuccess = () => { if (req.result) { s.images.put({ ...req.result, upload: true }); } };
        s.outbox.put({ key: `image:${ref}`, entity: 'image', entity_id: ref, queued_at: iso() });
      };
    }
    scan.local_image = null; scan.image_reference = null;
    return (s) => { s.images.delete(ref); };
  }

  async _update(scan, mutate) {
    mutate(scan);
    this._describe(scan);
    const imageOp = scan.state !== 'PENDING' ? await this._settleImage(scan) : null;
    this._touch(scan);
    this.session.last_activity_at = iso(); this._touch(this.session);
    await this._commit([['scans', scan, scan.scan_id], ['sessions', this.session, this.session.session_id]],
      imageOp ? { stores: ['images'], run: imageOp } : undefined);
    return scan;
  }

  _get(id) {
    const s = this.scans.find((x) => x.scan_id === id);
    if (!s) throw new Error('Scan not found');
    return s;
  }

  async confirm(id) {
    const scan = this._get(id), user = this.getUser();
    const ev = evaluate(scan, this.getConfig());
    if (!ev.confirmable) throw new Error('This ULD number is not valid and cannot be confirmed.');
    return this._update(scan, (s) => {
      s.state = 'CONFIRMED'; s.confirmed = true;
      s.review_acknowledged = ev.status === 'NEEDS_REVIEW';
      s.confirmed_by = user.user_id; s.confirmed_at = iso();
      s.final_value = s.uld_number = normalize(s.value);
      s.history.push({ action: 'CONFIRMED', by: user.user_id, at: iso(), value: s.final_value });
    });
  }

  async reject(id) {
    const scan = this._get(id), user = this.getUser();
    return this._update(scan, (s) => {
      s.state = 'REJECTED'; s.confirmed = false;
      s.history.push({ action: 'REJECTED', by: user.user_id, at: iso(), value: s.value });
    });
  }

  async resolveSuggestion(id, accept) {
    const scan = this._get(id), user = this.getUser();
    return this._update(scan, (s) => {
      s.correction_accepted = !!accept;
      if (accept) s.value = s.suggested_correction;
      s.history.push({ action: accept ? 'SUGGESTION_ACCEPTED' : 'SUGGESTION_KEPT_ORIGINAL', by: user.user_id, at: iso(), value: s.value });
    });
  }

  /** Check a typed value before saving (used live by the edit sheet). */
  check(value, exceptId) {
    const cfg = this.getConfig();
    const v = validate(value, cfg);
    const s = suggest(value, cfg);
    const dup = v.value ? this.duplicateOf(v.value, v.status !== 'INVALID', exceptId) : null;
    return { validation: v, suggestion: s ? s.suggestion : null, duplicate: dup };
  }

  /** Edit a pending or rejected item, then confirm it. */
  async editAndConfirm(id, value, { suggestion = null, accepted = null } = {}) {
    const scan = this._get(id), user = this.getUser();
    const c = this.check(value, id);
    if (c.validation.status === 'INVALID') throw new Error(c.validation.reasons[0]);
    if (c.duplicate) throw new Error('Already scanned in this session.');
    return this._update(scan, (s) => {
      const from = s.value, wasRejected = s.state === 'REJECTED';
      if (normalize(value) !== normalize(from)) {
        s.manually_corrected = true;
        s.history.push({ action: 'EDITED', by: user.user_id, at: iso(), from, value: c.validation.value });
      } else if (s.flags?.unreadable) {
        // The reader was not sure, staff looked and found the number right as it stood.
        s.flags = { ...s.flags, unreadable: false, checked_by_staff: true };
      }
      if (suggestion) { s.suggested_correction = suggestion; s.correction_accepted = accepted; }
      s.value = c.validation.value;
      s.state = 'CONFIRMED'; s.confirmed = true;
      s.confirmed_by = user.user_id; s.confirmed_at = iso();
      s.final_value = s.uld_number = c.validation.value;
      s.review_acknowledged = c.validation.status === 'NEEDS_REVIEW';
      s.history.push({ action: wasRejected ? 'CONFIRMED_AFTER_REJECT' : 'CONFIRMED', by: user.user_id, at: iso(), value: s.final_value });
    });
  }

  async addManual(input, { suggestion = null, accepted = null, typed = null } = {}) {
    const user = this.getUser();
    const c = this.check(input);
    if (c.validation.status === 'INVALID') throw new Error(c.validation.reasons[0]);
    if (c.duplicate) throw new Error('Already scanned in this session.');
    const now = iso();
    const scan = {
      scan_id: uuid(), session_id: this.session.session_id,
      value: c.validation.value, uld_number: c.validation.value, raw_ocr: null,
      manual_input: typed || c.validation.value,           // what staff originally typed
      suggested_correction: suggestion, correction_accepted: accepted, final_value: c.validation.value,
      confidence_status: null, manually_added: true, manually_corrected: false,
      state: 'CONFIRMED', confirmed: true, review_acknowledged: c.validation.status === 'NEEDS_REVIEW',
      confirmed_by: user.user_id, confirmed_at: now, image_reference: null, source: 'MANUAL',
      engine: null, cloud_fallback: false, confidence: null, env: null, timing: null, flags: {},
      history: [{ action: 'ADDED_MANUALLY', by: user.user_id, at: now, value: c.validation.value }],
      created_by: user.user_id, created_at: now,
    };
    this._describe(scan);
    return (await this._saveScan(scan, 'CONFIRMED')).scan;
  }

  async bumpCounter(name) {
    if (!this.session) return;
    this.session.counters[name] = (this.session.counters[name] || 0) + 1;
  }

  // --------------------------------------------------------------- reading --

  /** Copy a session fetched from the server onto this device (for resume). */
  async importRemote({ session, scans = [], events = [] }) {
    await db.tx(['sessions', 'scans', 'events', 'syncmeta'], 'readwrite', (s) => {
      const put = (store, entity, idKey, rec) => {
        const { server_rev, ...data } = rec;
        s[store].put(data);
        s.syncmeta.put({ key: `${entity}:${data[idKey]}`, server_rev: server_rev ?? null, state: 'SYNCED' });
      };
      put('sessions', 'session', 'session_id', session);
      for (const x of scans) put('scans', 'scan', 'scan_id', x);
      for (const x of events) put('events', 'event', 'event_id', x);
    });
  }

  /** Daily activity for one staff member: totals, zone breakdown, sessions. */
  async sessionsByDay(userId) {
    const all = (await db.all('sessions')).filter((s) => !userId || s.created_by === userId || s.resumed_by === userId);
    const scans = await db.all('scans');
    const bySession = new Map();
    for (const s of scans) { if (!bySession.has(s.session_id)) bySession.set(s.session_id, []); bySession.get(s.session_id).push(s); }
    const days = new Map();
    for (const s of all.sort((a, b) => b.started_at.localeCompare(a.started_at))) {
      const c = this.counts(bySession.get(s.session_id) || []);
      if (!days.has(s.day)) days.set(s.day, { day: s.day, containers: 0, pallets: 0, other: 0, zones: new Map(), sessions: [] });
      const d = days.get(s.day);
      d.containers += c.containers; d.pallets += c.pallets; d.other += c.other;
      const zk = `${s.station_code} ${s.zone_name}`;
      const z = d.zones.get(zk) || { containers: 0, pallets: 0 };
      z.containers += c.containers; z.pallets += c.pallets;
      d.zones.set(zk, z);
      d.sessions.push({ session: s, counts: c });
    }
    return [...days.values()];
  }
}
