// Pallet scan pipeline: camera frame -> pallet reader (in a worker) ->
// tracking. Same outside shape as ScanPipeline (start / stop / setPaused /
// multiScan, onFrame / onResults / onError), so the scanner screen can swap
// one for the other when staff switch between Containers and Pallets.
//
// What is different inside: a whole frame is read at once (every plate in
// view, any orientation), and a pass takes around a second on a phone, so
// the pipeline avoids reading the same thing twice while the camera is still.

import { toGray } from '../detection/detector.js';
import { QualityAnalyzer } from '../detection/quality.js';
import { makeCanvas } from '../ocr/preprocess.js';
import { qualityScore } from './pipeline.js';
import { PlateTracker } from '../pallet/tracker.js';

const TICK = 120;             // ms between quality checks and overlay refreshes
const PROC_W = 320;           // width of the small frame used for quality
const LIVE_SIDE = 1280;       // longest side of the frame handed to the reader
const STILL_SIDE = 1600;      // same, for Multi-Scan
const STILL_LIMIT = 832;      // detector input for Multi-Scan (memory grows with this and is never given back)
const KNOWN_MS = 3000;        // how long "already read" / "not a number" is trusted for a place (at least; longer on slow phones)
const MOTION_RESET = 7;       // frame-to-frame change that means the camera moved
const LIMITS = [416, 480, 576, 640, 736];   // detector input sizes to move between
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toCanvas(image) {
  if (!image) return null;
  const c = makeCanvas(image.width, image.height);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(image.data.buffer || image.data), image.width, image.height), 0, 0);
  return c;
}

export class PalletPipeline {
  constructor({ video, engine, tracker, getConfig, getView, onFrame, onResults, onError }) {
    Object.assign(this, { video, engine, tracker, getConfig, getView, onFrame, onResults, onError });
    this.proc = makeCanvas(PROC_W, 10);
    this.grab = makeCanvas(32, 32);
    this.quality = new QualityAnalyzer();
    this.running = false; this.paused = false; this.busy = false;
    this.lastQuality = null; this.moved = 0;
    this.known = [];            // places whose text was read and is not a ULD number
    this.marks = [];            // text seen on the last pass that is not (yet) a result
    this.linesSeen = 0; this.partialSeen = 0;
    this.passMs = []; this.detMs = []; this.passes = 0; this.limit = 2; this.sinceTune = 0;
  }

  start() { if (this.running) return; this.running = true; this._tick(); }
  stop() { this.running = false; clearTimeout(this.timer); }
  setPaused(p) {
    p = !!p;
    if (p === this.paused) return;
    this.paused = p;
    if (!p) { this.tracker.reset(); this.known = []; this.marks = []; }   // what was in view before the pause may be gone
  }

  _view() {
    const v = this.video;
    return this.getView?.() || { sx: 0, sy: 0, sw: v.videoWidth, sh: v.videoHeight };
  }

  /** Average time of one full pass (kept under the container pipeline's name for the device report). */
  get avgOcrMs() { return this.passMs.length ? this.passMs.reduce((a, b) => a + b, 0) / this.passMs.length : 0; }

  _tick() {
    if (!this.running) return;
    try { this._frame(); } catch (e) { this.onError?.(e); }
    this.timer = setTimeout(() => this._tick(), TICK);
  }

  /** Brightness, glare, sharpness and movement, measured on the main plate when there is one. */
  _quality(live = []) {
    const view = this._view();
    const ph = Math.max(8, Math.round((view.sh * PROC_W) / view.sw));
    if (this.proc.height !== ph) this.proc.height = ph;
    const ctx = this.proc.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.video, view.sx, view.sy, view.sw, view.sh, 0, 0, PROC_W, ph);
    const gray = toGray(ctx.getImageData(0, 0, PROC_W, ph));
    const b = live[0]?.bbox;
    const box = b ? {
      x0: Math.max(0, Math.round(b.x0 * PROC_W)), y0: Math.max(0, Math.round(b.y0 * ph)),
      x1: Math.min(PROC_W - 1, Math.round(b.x1 * PROC_W)), y1: Math.min(ph - 1, Math.round(b.y1 * ph)),
    } : undefined;
    const q = this.quality.analyze(gray, PROC_W, ph, box && box.x1 > box.x0 && box.y1 > box.y0 ? box : undefined);
    if (this.quality.lastMotion > MOTION_RESET) { this.moved = Date.now(); this.tracker.movedAt = this.moved; }
    return q;
  }

  _frame() {
    const v = this.video;
    if (this.paused || v.readyState < 2 || !v.videoWidth) return;
    const now = Date.now();
    // A plate stays outlined for about two passes after it was last seen,
    // but not once the camera has moved on: an outline around where a plate
    // used to be is worse than none.
    const liveMs = Math.min(4000, Math.max(900, 2.2 * this.avgOcrMs + 300));
    const seen = (t) => now - t.lastSeen < liveMs && t.lastSeen > this.moved;
    const q = this._quality(this.tracker.tracks.filter(seen));
    const live = this.tracker.tracks.filter(seen);
    this.lastQuality = q;
    this.onFrame?.({ regions: this.marks, quality: q, live, angle: null,
      partial: this.partialSeen >= 2, hasText: live.length > 0 || this.linesSeen > 0 });
    if (!this.busy) this._pass();
  }

  _grab(maxSide) {
    const view = this._view();
    const s = Math.min(1, maxSide / Math.max(view.sw, view.sh));
    const w = Math.max(32, Math.round(view.sw * s)), h = Math.max(32, Math.round(view.sh * s));
    if (this.grab.width !== w || this.grab.height !== h) { this.grab.width = w; this.grab.height = h; }
    const ctx = this.grab.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.video, view.sx, view.sy, view.sw, view.sh, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  /** Give a candidate from the worker the fields the rest of the app expects. */
  _finish(c, res, env) {
    c.env = env;
    c.ocrMs = Math.round(res.detMs + res.recMs);
    return c;
  }

  // Slow phone: look at a smaller picture. Fast phone: a larger one (small plates further away).
  _tune(detMs) {
    this.detMs.push(detMs); if (this.detMs.length > 4) this.detMs.shift();
    if (++this.sinceTune < 4) return;
    const avg = this.detMs.reduce((a, b) => a + b, 0) / this.detMs.length;
    if (avg > 800 && this.limit > 0) { this.limit--; this.sinceTune = 0; this.detMs = []; }
    else if (avg < 260 && this.limit < LIMITS.length - 1) { this.limit++; this.sinceTune = 0; this.detMs = []; }
  }

  async _pass() {
    this.busy = true;
    try {
      const started = Date.now();
      // Places that need no second reading: plates already reported and text
      // that is not a number. Only trusted while the camera has not moved.
      const keep = Math.max(KNOWN_MS, 3 * this.avgOcrMs);
      const fresh = (t) => t > this.moved && started - t < keep;
      const skip = [], refs = [];
      for (const t of this.tracker.tracks) {
        if (t.emitted && t.emitted.status !== 'INVALID' && t.lineBounds && fresh(t.lastRead)) { skip.push(t.lineBounds); refs.push({ track: t }); }
      }
      this.known = this.known.filter((k) => fresh(k.at));
      for (const k of this.known) { skip.push(k.bounds); refs.push({ known: k }); }

      const q = this.lastQuality;
      const t0 = performance.now();
      const res = await this.engine.read(this._grab(LIVE_SIDE), { skip, options: { detLimit: LIMITS[this.limit] } });
      const ms = performance.now() - t0;
      this.passes++;
      this.passMs.push(ms); if (this.passMs.length > 8) this.passMs.shift();
      this._tune(res.detMs);
      if (this.paused || !this.running) return;

      // Everything learnt from this pass is dated to when its picture was
      // taken, not to when the answer arrived: if the camera moved while the
      // frame was being read, what it showed is already out of date.
      const now = started;
      this.tracker.minTtlMs = 2.5 * this.avgOcrMs + 600;
      for (const s of res.skipped) {
        const r = refs[s.index];
        if (r.track) this.tracker.touch(r.track.id, s.bounds, now); else r.known.bounds = s.bounds;
      }
      for (const b of res.other) this.known.push({ bounds: b, at: now });

      const env = q ? { ...q, tilt: null, perspective: null, quality_score: qualityScore(q) } : null;
      const cands = res.candidates.map((c) => this._finish(c, res, env));
      this.linesSeen = res.lines;
      this.partialSeen = cands.length && cands.every((c) => c.status === 'INVALID') ? this.partialSeen + 1 : 0;
      const { results } = this.tracker.update(cands, now);
      // Corner marks: text that was found but has not turned into a result.
      this.marks = [...res.other, ...this.tracker.tracks.filter((t) => !t.emitted && t.lastSeen === now).map((t) => t.bbox)];
      for (const r of results) r.obs.evidence = toCanvas(r.obs.evidenceImage);
      if (results.length) this.onResults?.(results);
    } catch (e) {
      if (!this.running) return;              // stopped while a frame was being read: nothing to report
      this.onError?.(e);
      await sleep(800);                       // do not spin on a reader that keeps failing
    } finally {
      this.busy = false;
    }
  }

  /**
   * Multi-Scan: every plate in view from one deliberate snap. Two frames are
   * read a moment apart: a number that is not rock solid has to come out the
   * same in both, exactly as in continuous scanning. What was read only once
   * is still returned, marked for review.
   * @returns candidates, top to bottom; `.unreadable` = plates seen but not read
   */
  async multiScan() {
    const tracker = new PlateTracker(this.getConfig);
    tracker.minTtlMs = 60000;                   // both frames belong to the same snap, however long they take
    const q = this._quality();
    const env = { ...q, tilt: null, perspective: null, quality_score: qualityScore(q) };
    let skip = [];
    for (let pass = 0; pass < 2; pass++) {
      if (pass) await sleep(150);
      const res = await this.engine.read(this._grab(STILL_SIDE), { skip, options: { detLimit: STILL_LIMIT, maxLines: 14 } });
      const now = Date.now();
      for (const s of res.skipped) if (skip[s.index].id != null) tracker.touch(skip[s.index].id, s.bounds, now);
      tracker.update(res.candidates.map((c) => this._finish(c, res, env)), now);
      if (tracker.tracks.every((t) => t.emitted && t.emitted.status !== 'INVALID')) break;   // nothing left in doubt
      skip = [...tracker.tracks.filter((t) => t.emitted && t.emitted.status !== 'INVALID').map((t) => ({ ...t.lineBounds, id: t.id })),
        ...res.other];
    }
    const out = [];
    let unreadable = 0;
    for (const t of tracker.tracks) {
      let pick = t.emitted;
      if (!pick) {
        // Seen in one frame only (or read differently in the two): best readable version, for review.
        let best = null;
        for (const g of t.groups.values()) for (const m of g.members.values()) {
          if (m.obs.status !== 'INVALID' && (!best || m.obs.conf > best.conf)) best = m.obs;
        }
        if (best) pick = { obs: best, conf: best.conf, frames: 1, status: best.status, conflict: t.groups.size > 1, once: true };
      }
      if (!pick || pick.status === 'INVALID') { unreadable++; continue; }
      const c = pick.obs;
      c.conf = pick.conf; c.frames = pick.frames; c.conflict = !!pick.conflict; c.variants = pick.variants;
      if (pick.once && !pick.conflict) c.reviewReasons = [...c.reviewReasons, 'Read in one frame only'];
      c.evidence = toCanvas(c.evidenceImage);
      out.push(c);
    }
    out.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
    out.unreadable = unreadable;
    return out;
  }
}
