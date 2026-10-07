// Scanner screen. Camera stays visible; results arrive as small cards over
// the bottom of the picture and scanning carries on behind them.
//
// Two scan modes share this screen: Containers and Pallets. Each has its own
// reading pipeline; everything after a number has been read (duplicates,
// confirmation cards, counts, storage) is the same.

import { h, clear, uld, syncChip } from './dom.js';
import { scanCard } from './card.js';
import { editSheet, completeSheet } from './sheets.js';
import { sessionView } from './sessionview.js';
import { Camera } from '../camera/camera.js';
import { ScanPipeline } from '../scanner/pipeline.js';
import { PalletPipeline } from '../scanner/pallet-pipeline.js';
import { Tracker } from '../tracking/tracker.js';
import { PlateTracker } from '../pallet/tracker.js';
import { guidance } from '../detection/quality.js';
import { collectDevice, performanceClass } from '../analytics/device.js';
import { localDay } from '../session/store.js';
import { cloudRead } from '../ocr/cloud-engine.js';
import { scanModes } from '../core/defaults.js';
import { lookupPrefix } from '../validation/validator.js';
import { db } from '../offline/db.js';

const TONE = { VALID: '#2FBF71', NEEDS_REVIEW: '#F0A91E', INVALID: '#FF6B5E' };
const mb = (bytes) => (bytes / 1e6).toFixed(0);

export function scannerScreen(root, ctx) {
  const store = ctx.store, session = store.session;
  const cfg = () => ctx.config();
  const modes = scanModes(cfg());
  let mode = modes[0];

  // ------------------------------------------------------------------ DOM --
  const video = h('video', { muted: true, autoplay: true, playsInline: true });
  const overlay = h('canvas', { 'aria-hidden': 'true' });
  const guide = h('div', { class: 'guide', dataset: { l: 'idle' }, role: 'status' }, 'Starting camera');
  const toast = h('div', { class: 'toast', hidden: true, role: 'status' });
  const pausedEl = h('div', { class: 'paused', hidden: true }, 'Scanning paused');
  const errEl = h('div', { class: 'camerr', hidden: true });
  const queueEl = h('div', { class: 'queue' });
  const cam = h('div', { class: 'cam' }, video, overlay, guide, toast, pausedEl, errEl, queueEl);

  // What is being scanned. Only shown when there is a choice.
  const modeBtns = new Map(modes.map((m) => [m.mode, h('button', { class: 'seg', role: 'tab', dataset: { mode: m.mode },
    onclick: () => setMode(m.mode) }, m.label)]));
  const modeBar = modes.length > 1 ? h('div', { class: 'modes', role: 'tablist', 'aria-label': 'What to scan' }, [...modeBtns.values()]) : null;

  const n = { c: h('b', null, '0'), l: h('b', null, '0'), p: h('b', null, '0'), r: h('b', null, '0') };
  const tiles = { CONTAINER: h('div', null, n.c, h('span', null, 'Containers')), PALLET: h('div', null, n.l, h('span', null, 'Pallets')) };
  const countsBtn = h('button', { class: 'counts', 'aria-label': 'Open session details', onclick: () => openView(false) },
    tiles.CONTAINER, tiles.PALLET,
    h('div', null, n.p, h('span', null, 'Pending')), h('div', null, n.r, h('span', null, 'Rejected')));
  const multiBtn = h('button', { class: 'btn slim' }, 'Multi-scan');
  const manualBtn = h('button', { class: 'btn slim plain', onclick: () => openEdit(null) }, 'Add manually');
  const completeBtn = h('button', { class: 'btn primary slim wide', onclick: () => openComplete() }, 'Complete session');
  const chip = syncChip(ctx.sync);

  const screen = h('div', { class: 'scanner' },
    h('div', { class: 'scanbar' },
      h('button', { class: 'iconbtn', onclick: () => leave() }, 'Sessions'),
      h('div', { class: 'where' }, h('span', { class: 'stn' }, session.station_code), h('span', { class: 'zone' }, session.zone_name)),
      chip),
    cam,
    h('div', { class: 'panel' }, modeBar, countsBtn, h('div', { class: 'acts' }, multiBtn, manualBtn, completeBtn)));
  clear(root).append(screen);

  // ---------------------------------------------------------------- state --
  const camera = new Camera(video);
  let tracker = null;
  let pipeline = null, view = null, sheets = 0, shownKey = '', flashTimer = null, wake = null, alive = true;
  let cameraInfo = null, perfChecked = false, cameraOn = false, pipeToken = 0;
  let chain = Promise.resolve();
  const enqueue = (fn) => { chain = chain.then(fn).catch((e) => ctx.report(e)); return chain; };

  // --------------------------------------------------------------- render --
  const pendingList = () => store.scans.filter((s) => s.state === 'PENDING');

  function paintMode() {
    for (const [m, b] of modeBtns) b.setAttribute('aria-selected', String(m === mode.mode));
    // The tile of what is being counted right now is the big one.
    for (const [cat, t] of Object.entries(tiles)) t.classList.toggle('main', cat === mode.category);
  }

  function render() {
    if (!alive || !store.session) return;
    const c = store.counts();
    n.c.textContent = c.containers; n.l.textContent = c.pallets; n.p.textContent = c.pending; n.r.textContent = c.rejected;
    chip.paint();

    const pending = pendingList();
    const top = pending[0];
    const key = top ? `${top.scan_id}:${top.rev}:${pending.length}` : '';
    if (key !== shownKey) {   // don't rebuild a card mid-swipe for unrelated changes
      shownKey = key;
      [...queueEl.querySelectorAll('.card, .more')].forEach((x) => x.remove());
      if (top) {
        if (pending.length > 1) {
          queueEl.append(h('button', { class: 'more', onclick: () => openView(false) }, `${pending.length - 1} more pending`));
        }
        queueEl.append(scanCard(top, ctx, { onEdit: openEdit, onConfirmed: flash }));
      }
    }

    // Queue overflow: stop scanning and bring the queue full-screen until it
    // drops back under the threshold, then carry on automatically.
    const over = pending.length >= cfg().queue.overflowThreshold;
    if (over && !view) openView(true);
    else if (over && view && !view.forced) { view.forced = true; }
    else if (!over && view?.forced) { view.close(); }
    view?.render();
    updatePause();
  }

  function flash(scan) {
    queueEl.querySelector('.flash')?.remove();
    queueEl.prepend(h('div', { class: 'flash', role: 'status' }, h('span', null, '✓ Confirmed'), uld(scan.value)));
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => queueEl.querySelector('.flash')?.remove(), 1100);
  }

  function showToast(text, value, kind = '') {
    clear(toast).append(h('span', null, text));
    if (value) toast.append(uld(value));
    toast.className = `toast ${kind}`; toast.hidden = false;
  }

  function updatePause() {
    const overflow = !!view?.forced;
    const paused = overflow || sheets > 0 || !!view;
    pipeline?.setPaused(paused);
    pausedEl.hidden = !overflow;
  }

  // ---------------------------------------------------------------- sheets --
  function openEdit(scan) {
    sheets++; updatePause();
    editSheet(ctx, { scan, onDone: () => { sheets--; updatePause(); } });
  }
  function openView(forced) {
    if (view) return;
    view = sessionView(ctx, { session, scans: () => store.scans, forced, onEdit: openEdit,
      title: forced ? 'Review pending scans' : 'Scan session',
      onComplete: () => openComplete(), onClose: () => { view = null; updatePause(); } });
    updatePause();
  }
  function openComplete() {
    sheets++; updatePause();
    completeSheet(ctx, {
      onComplete: async () => { await store.complete('MANUAL'); cleanup(); ctx.go('home', { notice: `Session ${session.session_reference} completed.` }); },
      onClose: () => { sheets--; if (alive) updatePause(); },
    });
  }

  // ------------------------------------------------------------- detection --
  async function handle(results, source) {
    const tally = { added: 0, dup: 0, other: 0 };
    const category = mode.category;
    for (const r of results) {
      if (!store.session) return tally;
      // Unreadable, and by its type code not what is being counted right now
      // (a pallet plate while scanning containers, or the other way round):
      // nothing to ask staff about.
      if (r.status === 'INVALID') {
        const known = lookupPrefix(cfg(), String(r.obs.raw || '').slice(0, 3));
        if (known && known.category !== category) { if (r.track) r.track.outcome = 'IGNORED'; continue; }
      }
      // Local OCR could not read it: ask the cloud once, with the crop only.
      // (Container numbers only: the cloud path does not know about rivets.)
      const viaCloud = r.status === 'INVALID' && r.obs.pipeline !== 'pallet' ? await cloudRead(r, cfg()) : null;
      const res = await store.addDetection(viaCloud || r, source, { category });
      if (r.track) { r.track.outcome = res.outcome; }
      if (res.outcome === 'DUPLICATE' || res.outcome === 'REJECTED_BEFORE') {
        tally.dup++;
        // A re-read of something added seconds ago is not worth a warning.
        const fresh = Date.now() - Date.parse(res.scan.created_at) < 5000;
        if (source === 'SINGLE' && !fresh) {
          showToast(res.outcome === 'DUPLICATE' ? 'Already scanned' : 'Rejected earlier. Fix it under Rejected.', res.scan.value);
        }
      } else {
        if (res.outcome === 'AUTO_SAVED') tally.other++; else tally.added++;
        if (source === 'SINGLE') toast.hidden = true;   // replaced by the next relevant detection
      }
    }
    return tally;
  }

  multiBtn.onclick = () => enqueue(async () => {
    if (!pipeline) return;
    multiBtn.disabled = true; multiBtn.textContent = 'Reading';
    pipeline.setPaused(true);
    try {
      const cands = await pipeline.multiScan();
      store.session.counters.multi_scans = (store.session.counters.multi_scans || 0) + 1;
      const now = Date.now();
      const t = await handle(cands.map((c) => ({ obs: c, conf: c.conf, frames: c.frames || 1, firstSeen: now,
        disagreement: false, conflict: !!c.conflict, variants: c.variants })), 'MULTI');
      const parts = [];
      if (t.added) parts.push(`${t.added} added`);
      if (t.other) parts.push(`${t.other} other ULD saved`);
      if (t.dup) parts.push(`${t.dup} already scanned`);
      if (cands.unreadable) parts.push(`${cands.unreadable} could not be read`);
      showToast(parts.length ? parts.join(', ') : 'No ULD numbers found. Move closer and try again.', null, parts.length ? 'info' : '');
    } finally {
      multiBtn.disabled = false; multiBtn.textContent = 'Multi-scan';
      updatePause();
    }
  });

  function draw(f) {
    const dpr = window.devicePixelRatio || 1;
    const cw = cam.clientWidth, ch = cam.clientHeight;
    if (overlay.width !== Math.round(cw * dpr)) { overlay.width = Math.round(cw * dpr); overlay.height = Math.round(ch * dpr); }
    const g = overlay.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    if (!video.videoWidth) return;
    // Coordinates from the pipeline are relative to the visible camera area.
    const box = (b) => [b.x0 * cw, b.y0 * ch, (b.x1 - b.x0) * cw, (b.y1 - b.y0) * ch];

    // What the detector is looking at: quiet corner marks.
    g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 2;
    for (const r of f.regions.slice(0, 6)) {
      const [x, y, w, hh] = box(r), k = Math.min(14, w / 4, hh / 2);
      g.beginPath();
      g.moveTo(x, y + k); g.lineTo(x, y); g.lineTo(x + k, y);
      g.moveTo(x + w - k, y); g.lineTo(x + w, y); g.lineTo(x + w, y + k);
      g.moveTo(x + w, y + hh - k); g.lineTo(x + w, y + hh); g.lineTo(x + w - k, y + hh);
      g.moveTo(x + k, y + hh); g.lineTo(x, y + hh); g.lineTo(x, y + hh - k);
      g.stroke();
    }
    // What has been read: a solid outline with the number.
    for (const t of f.live) {
      if (!t.bbox) continue;
      const [x, y, w, hh] = box(t.bbox);
      const dup = t.outcome === 'DUPLICATE' || t.outcome === 'REJECTED_BEFORE';
      const st = t.emitted && (t.emitted.obs.assess.suggestion ? 'NEEDS_REVIEW' : t.emitted.status);
      const col = t.emitted ? (dup ? TONE.NEEDS_REVIEW : TONE[st]) : '#FFFFFF';
      g.strokeStyle = col; g.lineWidth = 3; g.setLineDash(dup ? [8, 6] : []);
      if (t.quad) {           // a plate at an angle: follow it instead of boxing it
        g.beginPath();
        t.quad.forEach(([px, py], i) => (i ? g.lineTo(px * cw, py * ch) : g.moveTo(px * cw, py * ch)));
        g.closePath(); g.stroke();
      } else {
        g.strokeRect(x - 4, y - 4, w + 8, hh + 8);
      }
      g.setLineDash([]);
      const label = t.lastObs?.raw || '';
      g.font = "700 15px 'B612 Mono', monospace";
      const tw = g.measureText(label).width + 12;
      const ly = y - 30 > 4 ? y - 30 : y + hh + 8;
      g.fillStyle = 'rgba(17,28,38,.88)'; g.fillRect(x - 4, ly, tw, 22);
      g.fillStyle = col; g.fillText(label, x + 2, ly + 16);
    }
  }

  // The video is shown with object-fit: cover, so part of each frame is off
  // screen. Tell the pipeline which part is visible; it scans only that.
  function getView() {
    const vw = video.videoWidth, vh = video.videoHeight, cw = cam.clientWidth, ch = cam.clientHeight;
    if (!vw || !cw || !ch) return null;
    const s = Math.max(cw / vw, ch / vh), sw = cw / s, sh = ch / s;
    return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh };
  }

  function onFrame(f) {
    if (!alive || !pipeline) return;
    draw(f);
    const gd = guidance(f.quality, { hasText: f.hasText, angle: f.angle, partial: f.partial });
    guide.dataset.l = gd.level; guide.textContent = gd.text;
    if (!perfChecked && pipeline.passes >= (mode.pipeline === 'pallet' ? 6 : 10)) {
      perfChecked = true;
      const ms = Math.round(pipeline.avgOcrMs);
      if (!session.device) return;
      if (mode.pipeline === 'pallet') {
        if (session.device.pallet_pass_ms !== ms) store.updateDevice({ ...session.device, pallet_pass_ms: ms });
      } else {
        const cls = performanceClass(cameraInfo, pipeline.avgOcrMs);
        if (session.device.performance_class !== cls) store.updateDevice({ ...session.device, performance_class: cls, avg_ocr_ms: ms });
      }
    }
  }

  // ------------------------------------------------------------- pipelines --
  function showError(lines, retry) {
    clear(errEl).append(...lines.map((t, i) => h('p', i ? { class: 'small' } : null, t)));
    if (retry) errEl.append(h('button', { class: 'btn', onclick: retry }, 'Try again'));
    errEl.hidden = false;
  }

  /** Start reading in the current mode (the camera is already running). */
  async function startPipeline() {
    const my = ++pipeToken;
    pipeline?.stop(); pipeline = null; tracker = null; perfChecked = false;
    errEl.hidden = true; toast.hidden = true;
    const g = overlay.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, overlay.width, overlay.height);
    const stale = () => my !== pipeToken || !alive || !cameraOn;
    const common = { video, getConfig: cfg, getView, onFrame,
      onResults: (r) => enqueue(() => (stale() ? null : handle(r, 'SINGLE'))), onError: (e) => ctx.report(e) };

    if (mode.pipeline === 'pallet') {
      guide.dataset.l = 'idle'; guide.textContent = 'Preparing pallet reader';
      const engine = ctx.palletEngine();
      const off = engine.onProgress((p) => {
        if (!stale() && p.downloading) guide.textContent = `Downloading pallet reader ${mb(p.loaded)} of ${mb(p.total)} MB`;
      });
      try {
        await engine.init();
      } catch (e) {
        off();
        if (stale()) return;
        guide.textContent = 'Pallet reader unavailable';
        showError(e.code === 'DOWNLOAD'
          ? ['The pallet reader is not on this phone yet.', 'Connect to the internet once and open Pallets again to download it (about 30 MB). After that it works offline.', 'You can still add pallets manually.']
          : ['The pallet reader could not start.', 'You can still add pallets manually, or switch to Containers.'], startPipeline);
        if (e.code !== 'DOWNLOAD') ctx.report(e);      // no connection is not a fault
        return;
      }
      off();
      if (stale()) return;
      ctx.releaseEngine();                 // the container reader is not needed while pallets are scanned
      tracker = new PlateTracker(cfg);
      pipeline = new PalletPipeline({ ...common, engine, tracker });
    } else {
      guide.dataset.l = 'idle'; guide.textContent = 'Preparing scanner';
      let engine;
      try { engine = await ctx.engine(); }
      catch (e) {
        if (stale()) return;
        showError(['The text reader could not load. Check the connection once, then reopen the app.', 'You can still add ULDs manually.']);
        return;
      }
      if (stale()) return;
      ctx.releasePalletEngine();           // and the other way round
      tracker = new Tracker(cfg);
      pipeline = new ScanPipeline({ ...common, engine, tracker });
    }
    pipeline.start();
    updatePause();
  }

  function setMode(name) {
    const next = modes.find((m) => m.mode === name);
    if (!next || next === mode) return;
    mode = next;
    paintMode();
    db.setMeta('scan_mode', mode.mode).catch(() => {});      // next session starts where this one left off
    store.logEvent('SCAN_MODE_CHANGED', { mode: mode.mode });
    if (cameraOn) startPipeline();
  }

  // ---------------------------------------------------------------- camera --
  async function startCamera() {
    errEl.hidden = true;
    guide.textContent = 'Starting camera'; guide.dataset.l = 'idle';
    try {
      cameraInfo = await camera.start();
    } catch (e) {
      clear(errEl).append(h('p', null, e.message || 'Camera could not start.'),
        h('button', { class: 'btn', onclick: startCamera }, 'Try again'),
        h('p', { class: 'small' }, 'You can still add ULDs manually.'));
      errEl.hidden = false; guide.textContent = 'Camera unavailable';
      return;
    }
    if (!alive) return camera.stop();
    cameraOn = true;
    if (!session.device || session.device_id !== ctx.deviceId || !session.device.camera_resolution) {
      store.updateDevice(await collectDevice(cameraInfo));
    }
    await startPipeline();
    try { wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  }

  function stopCamera() {
    cameraOn = false; pipeToken++;
    pipeline?.stop(); pipeline = null; camera.stop();
    try { wake?.release(); } catch { /* already released */ } wake = null;
  }

  const onVisibility = () => {
    if (!alive) return;
    if (document.hidden) { stopCamera(); store.logEvent('SESSION_PAUSED', { reason: 'app_hidden' }); }
    else { store.logEvent('SESSION_UNPAUSED', {}); startCamera(); }
  };
  document.addEventListener('visibilitychange', onVisibility);

  // Day-end rule: a session cannot continue into the next calendar day.
  const dayTimer = setInterval(async () => {
    if (!alive || localDay() === session.day) return;
    cleanup();
    await store.autoCompleteStale();
    ctx.go('home', { notice: 'The day ended, so the session was closed automatically. Start a new session to continue.' });
  }, 20000);

  const unsub = ctx.subscribe(render);

  function cleanup() {
    if (!alive) return;
    alive = false;
    stopCamera(); clearInterval(dayTimer); clearTimeout(flashTimer); unsub();
    document.removeEventListener('visibilitychange', onVisibility);
    view?.el.remove(); view = null;
    document.querySelectorAll('.scrim').forEach((x) => x.remove());
  }

  async function leave() {
    await store.logEvent('SESSION_PAUSED', { reason: 'left_scanner' });
    cleanup(); store.closeActive(); ctx.go('home');
  }

  // Handle for automated tests and support (same idea as window.__uld in app.js).
  if (window.__uld) window.__uld.scanner = { get pipeline() { return pipeline; }, get tracker() { return tracker; }, get mode() { return mode.mode; } };

  paintMode();
  render();
  // Open in the mode that was used last on this phone, then start the camera.
  db.getMeta('scan_mode').catch(() => null).then((saved) => {
    if (!alive) return;
    const m = modes.find((x) => x.mode === saved);
    if (m) { mode = m; paintMode(); }
    startCamera();
  });
  return cleanup;
}
