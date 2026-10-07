// Scan pipeline: camera frame -> quality + text detection -> crop -> OCR ->
// candidates -> tracking. Knows nothing about sessions or UI; it reports
// through callbacks.

import { toGray, detectTextRegions } from '../detection/detector.js';
import { QualityAnalyzer, estimateAngle } from '../detection/quality.js';
import { cropCanvas, enhance, makeCanvas } from '../ocr/preprocess.js';
import { groupLines } from '../ocr/engine.js';
import { extractCandidates } from '../ocr/candidates.js';
import { canonical } from '../duplicate/duplicate.js';

const PROC_W = 480;           // analysis resolution (detector + quality)
const FRAME_INTERVAL = 90;    // ms between analysed frames
const PLAN = [0, 1, 'C', 0, 2, 'C']; // which region to OCR while searching

export class ScanPipeline {
  constructor({ video, engine, tracker, getConfig, getView, onFrame, onResults, onError }) {
    Object.assign(this, { video, engine, tracker, getConfig, getView, onFrame, onResults, onError });
    this.proc = makeCanvas(PROC_W, 10);
    this.quality = new QualityAnalyzer();
    this.running = false; this.paused = false; this.busy = false;
    this.attempt = 0; this.lastHit = null; this.lastQuality = null;
    this.ocrMs = []; this.passes = 0; this.partialSeen = 0; this.lastAngle = null;
  }

  start() { if (this.running) return; this.running = true; this._tick(); }
  stop() { this.running = false; clearTimeout(this.timer); }
  setPaused(p) {
    p = !!p;
    if (p === this.paused) return;
    this.paused = p;
    if (!p) this.tracker.reset();   // what was in view before the pause may be gone
  }

  /**
   * The part of the camera image that staff can actually see, in video
   * pixels. Only this area is analysed, so nothing off-screen is ever
   * scanned. All normalised coordinates in this class are relative to it.
   */
  _view() {
    const v = this.video;
    return this.getView?.() || { sx: 0, sy: 0, sw: v.videoWidth, sh: v.videoHeight };
  }

  get avgOcrMs() {
    return this.ocrMs.length ? this.ocrMs.reduce((a, b) => a + b, 0) / this.ocrMs.length : 0;
  }

  _tick() {
    if (!this.running) return;
    try { this._frame(); } catch (e) { this.onError?.(e); }
    this.timer = setTimeout(() => this._tick(), FRAME_INTERVAL);
  }

  _analyse() {
    const view = this._view();
    const ph = Math.max(8, Math.round((view.sh * PROC_W) / view.sw));
    if (this.proc.height !== ph) this.proc.height = ph;
    const ctx = this.proc.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.video, view.sx, view.sy, view.sw, view.sh, 0, 0, PROC_W, ph);
    const gray = toGray(ctx.getImageData(0, 0, PROC_W, ph));
    const regions = detectTextRegions(gray, PROC_W, ph);
    const q = this.quality.analyze(gray, PROC_W, ph, regions[0]);
    const norm = regions.map((r) => ({ x0: r.x0 / PROC_W, y0: r.y0 / ph, x1: r.x1 / PROC_W, y1: r.y1 / ph, score: r.score }));
    return { regions: norm, q };
  }

  _frame() {
    const v = this.video;
    if (this.paused || v.readyState < 2 || !v.videoWidth) return;
    const { regions, q } = this._analyse();
    this.lastQuality = q;
    const now = Date.now();
    // A box is drawn only while its text is still being read: about two OCR
    // passes, so it disappears quickly once the camera moves on.
    const liveMs = Math.min(900, Math.max(300, 2.2 * (this.avgOcrMs + FRAME_INTERVAL)));
    const live = this.tracker.tracks.filter((t) => now - t.lastSeen < liveMs);
    this.onFrame?.({ regions, quality: q, live, angle: this.lastAngle,
      partial: this.partialSeen >= 2, hasText: regions.length > 0 || live.length > 0 });
    if (!this.busy) this._ocrPass(regions);
  }

  // Choose what to read next. While a number is in view we keep reading the
  // region it was found in; while searching we rotate through the detector's
  // proposals and fall back to the centre of the frame, so a missed detection
  // never leaves the scanner blind.
  _chooseRoi(regions) {
    const center = { x0: 0.04, y0: 0.24, x1: 0.96, y1: 0.76, center: true };
    if (this.lastHit) {
      const h = this.lastHit;
      const near = regions.find((r) => r.x0 < h.x1 && r.x1 > h.x0 && r.y0 < h.y1 && r.y1 > h.y0);
      return near || center;
    }
    const slot = PLAN[this.attempt % PLAN.length];
    return slot === 'C' ? center : (regions[slot] || center);
  }

  _roiRect(roi) {
    const view = this._view(), vw = view.sw, vh = view.sh;
    let { x0, y0, x1, y1 } = roi;
    if (!roi.center) {
      const h = y1 - y0, w = x1 - x0;
      const padY = h * 0.35, padX = w * 0.05 + h * 0.6 * (vh / vw);
      x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
    }
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(1, x1); y1 = Math.min(1, y1);
    return { sx: view.sx + x0 * vw, sy: view.sy + y0 * vh, sw: (x1 - x0) * vw, sh: (y1 - y0) * vh };
  }

  /** OCR one rectangle of a source image and return candidates in frame coords. */
  async _read(source, rect, mode, frame) {
    let scale;
    if (mode === 'line') scale = Math.min(3, 72 / rect.sh, 1400 / rect.sw);
    else scale = Math.min(1.5, 1000 / rect.sw);
    const color = cropCanvas(source, rect, rect.sw * scale, rect.sh * scale);
    const gray = makeCanvas(color.width, color.height);
    gray.getContext('2d', { willReadFrequently: true }).drawImage(color, 0, 0);
    enhance(gray);
    const { symbols, ms } = await this.engine.recognize(gray, { mode });
    const cands = extractCandidates(groupLines(symbols), this.getConfig());
    for (const c of cands) {
      const b = c.bbox;
      // Evidence crop: the number plus a little context, never the full frame.
      const pw = (b.x1 - b.x0) * 0.08, phh = (b.y1 - b.y0) * 0.35;
      const er = { sx: Math.max(0, b.x0 - pw), sy: Math.max(0, b.y0 - phh) };
      er.sw = Math.min(color.width - er.sx, b.x1 - b.x0 + 2 * pw);
      er.sh = Math.min(color.height - er.sy, b.y1 - b.y0 + 2 * phh);
      const es = Math.min(1, 480 / er.sw);
      c.evidence = cropCanvas(color, er, er.sw * es, er.sh * es);
      c.angle = estimateAngle(c.charBoxes);
      const toFrame = (k) => k && ({
        x0: (rect.sx + k.x0 / scale - frame.sx) / frame.sw, y0: (rect.sy + k.y0 / scale - frame.sy) / frame.sh,
        x1: (rect.sx + k.x1 / scale - frame.sx) / frame.sw, y1: (rect.sy + k.y1 / scale - frame.sy) / frame.sh,
      });
      c.bbox = toFrame(b);
      delete c.charBoxes;
      c.ocrMs = Math.round(ms);
      c.engine = this.engine.name;
    }
    return { cands, ms };
  }

  async _ocrPass(regions) {
    this.busy = true;
    try {
      const roi = this._chooseRoi(regions);
      const rect = this._roiRect(roi);
      const aspect = rect.sw / rect.sh;
      const mode = !roi.center && aspect >= 3.5 ? 'line' : 'sparse';
      const q = this.lastQuality;
      const { cands, ms } = await this._read(this.video, rect, mode, this._view());
      this.passes++;
      this.ocrMs.push(ms); if (this.ocrMs.length > 12) this.ocrMs.shift();
      if (this.paused || !this.running) return;

      const readable = cands.filter((c) => c.status !== 'INVALID');
      if (cands.length) { this.attempt = 0; this.lastHit = cands[0].bbox; }
      else { this.attempt++; this.lastHit = null; }
      this.partialSeen = cands.length && !readable.length ? this.partialSeen + 1 : 0;
      this.lastAngle = cands[0]?.angle || null;

      const env = q ? { ...q, tilt: this.lastAngle?.tilt ?? null, perspective: this.lastAngle?.perspective ?? null,
        quality_score: qualityScore(q) } : null;
      for (const c of cands) c.env = env;
      const { results } = this.tracker.update(cands, Date.now());
      if (results.length) this.onResults?.(results);
    } catch (e) {
      this.onError?.(e);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Multi-Scan: read one captured frame for every ULD number in it. The whole
   * frame is read in sparse mode, then each detected region is re-read as a
   * single line; the stronger reading of each number is kept.
   */
  async multiScan() {
    const view = this._view(), vw = Math.round(view.sw), vh = Math.round(view.sh);
    const still = makeCanvas(vw, vh);
    still.getContext('2d').drawImage(this.video, view.sx, view.sy, view.sw, view.sh, 0, 0, vw, vh);
    const frame = { sx: 0, sy: 0, sw: vw, sh: vh };
    const { regions, q } = this._analyse();
    const env = { ...q, quality_score: qualityScore(q) };
    const cfg = this.getConfig();
    const found = new Map();
    const keep = (c) => {
      const key = canonical(c.raw, cfg);
      const cur = found.get(key);
      const rank = (x) => (x.status === 'VALID' ? 2000 : x.status === 'NEEDS_REVIEW' ? 1000 : 0) + x.conf;
      if (!cur || rank(c) > rank(cur)) found.set(key, c);
    };
    const full = await this._read(still, frame, 'sparse', frame);
    full.cands.forEach(keep);
    for (const r of regions) {
      const h = r.y1 - r.y0, w = r.x1 - r.x0;
      const rect = {
        sx: Math.max(0, r.x0 - w * 0.05 - h * 0.6 * (vh / vw)) * vw, sy: Math.max(0, r.y0 - h * 0.35) * vh,
      };
      rect.sw = Math.min(vw - rect.sx, (w * 1.1 + h * 1.2 * (vh / vw)) * vw);
      rect.sh = Math.min(vh - rect.sy, h * 1.7 * vh);
      if (rect.sw / rect.sh < 3.5) continue;
      (await this._read(still, rect, 'line', frame)).cands.forEach(keep);
    }
    const out = [...found.values()].filter((c) => !c.partial);
    for (const c of out) c.env = env;
    return out.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  }
}

/** 0-100 image-quality figure for admin analytics (never shown to staff). */
export function qualityScore(q) {
  let s = 100;
  if (q.lighting === 'VERY_LOW_LIGHT') s -= 45; else if (q.lighting === 'LOW_LIGHT') s -= 25;
  else if (q.lighting === 'GLARE') s -= 30;
  s -= Math.min(30, q.motion * 1.5);
  if (q.sharpness < 40) s -= 20; else if (q.sharpness < 120) s -= 8;
  return Math.max(0, Math.round(s));
}
