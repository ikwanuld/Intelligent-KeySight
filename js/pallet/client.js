// Main-thread handle on the pallet reader worker.
//
//   const engine = new PalletEngine({ getConfig });
//   engine.onProgress((p) => showProgress(p));
//   await engine.init();                 // loads ~30 MB once, later from the device
//   const { candidates } = await engine.read(imageData);

export class PalletEngineError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// If the worker has shown no sign of life for this long while starting, it is
// given up on (and, when it was started with threads, tried again without).
const START_TIMEOUT_MS = 45000;

export class PalletEngine {
  constructor({ getConfig, options = {}, threads = 1, session = {}, startTimeoutMs = START_TIMEOUT_MS }) {
    Object.assign(this, { getConfig, options, threads, session, startTimeoutMs });
    this.name = 'paddle';
    this.worker = null; this.ready = null; this.info = null;
    this.pending = new Map(); this.nextId = 1; this.sentConfig = null;
    this.progress = null;            // last progress report, for late listeners
    this.listeners = new Set();
    this.cancelStart = null;         // gives up a start that is under way
  }

  /** Subscribe to loading progress ({loaded, total, downloading}). Returns an unsubscribe function. */
  onProgress(fn) { this.listeners.add(fn); if (this.progress) fn(this.progress); return () => this.listeners.delete(fn); }

  /**
   * Start (or join) loading. Rejects with a PalletEngineError; a later call tries again.
   * code 'DOWNLOAD': the reader's files are not on the device and could not be fetched.
   * code 'LOAD' / 'UNSUPPORTED': they are there but the reader did not come up.
   */
  init() {
    if (this.ready) return this.ready;
    const attempt = this._start(this.threads)
      .catch((e) => {
        // Threads are an extra. If the reader does not come up with them, it
        // must still come up without.
        if (this.threads > 1 && e.code !== 'DOWNLOAD' && e.code !== 'STOPPED') { this.threads = 1; return this._start(1); }
        throw e;
      })
      .catch((e) => { if (this.ready === attempt) this.ready = null; throw e; });
    this.ready = attempt;
    attempt.catch(() => {});         // callers handle it; avoid an unhandled-rejection report
    return attempt;
  }

  _start(threads) {
    return new Promise((resolve, reject) => {
      let settled = false, watchdog = null, w = null;
      // Everything here acts on THIS attempt's worker only: a later attempt
      // may already have a worker of its own by the time this one gives up.
      const fail = (code, message) => {
        if (settled) return;
        settled = true; clearTimeout(watchdog);
        try { w?.terminate(); } catch { /* already gone */ }
        if (this.worker === w) this._forget();
        if (this.cancelStart === cancel) this.cancelStart = null;
        reject(new PalletEngineError(code, message));
      };
      const cancel = () => fail('STOPPED', 'Pallet reader stopped');
      const alive = () => { clearTimeout(watchdog); watchdog = setTimeout(() => fail('LOAD', 'The pallet reader took too long to start.'), this.startTimeoutMs); };
      try {
        w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      } catch (e) {
        return fail('UNSUPPORTED', 'This browser cannot run the pallet reader.');
      }
      this.worker = w; this.cancelStart = cancel;
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') { if (!settled) alive(); this.progress = m; this.listeners.forEach((fn) => fn(m)); }
        else if (m.type === 'ready') {
          if (settled) return;
          settled = true; clearTimeout(watchdog); this.cancelStart = null;
          this.info = m.info; resolve(this);
        } else if (m.type === 'failed') fail(m.code === 'DOWNLOAD' ? 'DOWNLOAD' : 'LOAD', m.message);
        else if (m.type === 'result' || m.type === 'error') {
          const p = this.pending.get(m.id);
          if (!p) return;
          this.pending.delete(m.id);
          if (m.type === 'result') p.resolve(m); else p.reject(new Error(m.message));
        }
      };
      // The worker script (or one of its imports) could not be loaded, or the worker crashed.
      w.onerror = (e) => {
        e.preventDefault?.();
        const message = e.message || 'The pallet reader could not start.';
        if (!settled) return fail('LOAD', message);
        if (this.worker !== w) return;
        for (const p of this.pending.values()) p.reject(new Error(message));
        this.pending.clear();
        try { w.terminate(); } catch { /* already gone */ }
        this._forget(); this.ready = null;
      };
      this.sentConfig = this.getConfig();
      alive();
      w.postMessage({ type: 'init', config: this.sentConfig, options: this.options, threads, session: this.session });
    });
  }

  _forget() { this.worker = null; this.info = null; this.progress = null; }

  /**
   * Read one frame.
   * @param image  ImageData (its buffer is handed over to the worker)
   * @param skip   [{x0,y0,x1,y1}] places whose text is already known
   * @returns {{candidates, other, skipped, lines, detMs, recMs, recCalls}}
   */
  async read(image, { skip = [], options = {} } = {}) {
    await this.init();
    const w = this.worker;
    if (!w) throw new Error('Pallet reader stopped');
    const cfg = this.getConfig();
    if (cfg !== this.sentConfig) { this.sentConfig = cfg; w.postMessage({ type: 'config', config: cfg }); }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const buf = image.data.buffer;
      w.postMessage({ type: 'read', id, frame: { data: buf, width: image.width, height: image.height }, skip, options }, [buf]);
    });
  }

  /** Stop the worker and free its memory. init() starts a new one. */
  terminate() {
    this.cancelStart?.();                    // a start that is still under way is given up
    for (const p of this.pending.values()) p.reject(new Error('Pallet reader stopped'));
    this.pending.clear();
    try { this.worker?.terminate(); } catch { /* already gone */ }
    this._forget(); this.ready = null;
  }
}
