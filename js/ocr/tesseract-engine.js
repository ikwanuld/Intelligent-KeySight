// Local OCR engine: Tesseract (LSTM) compiled to WebAssembly, served from
// /vendor so it works with no network at all.

import { registerEngine } from './engine.js';

const WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PSM = { line: '7', sparse: '11' };

class TesseractEngine {
  constructor(options = {}) {
    this.name = 'tesseract';
    this.base = options.base || new URL('vendor/tesseract/', document.baseURI).href;
    this.worker = null;
    this.mode = null;
    this.chain = Promise.resolve();
  }

  async init() {
    if (this.worker) return;
    const T = globalThis.Tesseract;
    if (!T) throw new Error('Tesseract script not loaded');
    this.worker = await T.createWorker('eng', T.OEM.LSTM_ONLY, {
      workerPath: this.base + 'worker.min.js',
      corePath: this.base,
      langPath: this.base,
      gzip: true,
      workerBlobURL: false,
    });
    await this.worker.setParameters({ tessedit_char_whitelist: WHITELIST, user_defined_dpi: '300' });
  }

  // Calls are serialised: one worker, one recognition at a time.
  recognize(canvas, opts = {}) {
    const run = async () => {
      const mode = opts.mode || 'line';
      if (mode !== this.mode) {
        await this.worker.setParameters({ tessedit_pageseg_mode: PSM[mode] });
        this.mode = mode;
      }
      const t0 = performance.now();
      const { data } = await this.worker.recognize(canvas, {}, { text: false, blocks: true });
      const symbols = [];
      for (const block of data.blocks || []) {
        for (const para of block.paragraphs || []) {
          for (const line of para.lines || []) {
            for (const word of line.words || []) {
              for (const s of word.symbols || []) {
                symbols.push({ ch: s.text, conf: s.confidence, bbox: s.bbox });
              }
            }
          }
        }
      }
      return { symbols, ms: performance.now() - t0 };
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async terminate() {
    if (this.worker) { await this.worker.terminate(); this.worker = null; this.mode = null; }
  }
}

registerEngine('tesseract', (options) => new TesseractEngine(options));
