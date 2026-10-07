// Scene-text OCR engine (PaddleOCR detection + recognition models running on
// ONNX Runtime). Runtime-agnostic: the caller passes the `ort` module, so the
// same class works with onnxruntime-web in the browser and onnxruntime-node
// in the test harness.
//
//   const engine = await PaddleEngine.create({ ort, det, rec, dict });
//   const { boxes } = await engine.detect(image);          // where is text?
//   const line = await engine.read(image, boxes[0]);       // what does it say?

import { cropBox, resize, toTensorData, autoContrast } from './image.js';
import { dbBoxes } from './db.js';
import { buildCharset, ctcDecode, JUNK } from './ctc.js';

const REC_H = 48;          // recogniser input height (fixed by the model)
const REC_MIN_W = 320;     // narrower crops are right-padded, as in training
const REC_MAX_W = 960;

export class PaddleEngine {
  constructor(ort, det, rec, charset) {
    Object.assign(this, { ort, det, rec, charset });
    this.name = 'paddle';
    this.stats = { detMs: 0, recMs: 0, recCalls: 0 };
  }

  /**
   * @param det, rec  model bytes (ArrayBuffer / Uint8Array) or a file path (Node)
   * @param dict      dictionary text for the recognition model
   */
  static async create({ ort, det, rec, dict, sessionOptions = {} }) {
    const [d, r] = await Promise.all([
      ort.InferenceSession.create(det, sessionOptions),
      ort.InferenceSession.create(rec, sessionOptions),
    ]);
    // The class count is only known after one run (dynamic output shape).
    const probe = await r.run({ [r.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * REC_H * 64), [1, 3, REC_H, 64]) });
    const classes = probe[r.outputNames[0]].dims[2];
    return new PaddleEngine(ort, d, r, buildCharset(dict, classes));
  }

  /**
   * Find text lines.
   * @param limit   longest side of the detector input in pixels (speed vs. small text)
   * @param enhance stretch the contrast of the detector input first
   * @returns {{boxes: {cx,cy,w,h,angle,score}[], ms:number}} boxes in image pixels
   */
  async detect(img, { limit = 736, thresh = 0.3, boxThresh = 0.3, unclipRatio = 1.6, enhance = false } = {}) {
    const t0 = now();
    const scale = Math.min(1, limit / Math.max(img.width, img.height));
    const rw = Math.max(32, Math.round((img.width * scale) / 32) * 32);
    const rh = Math.max(32, Math.round((img.height * scale) / 32) * 32);
    let small = rw === img.width && rh === img.height ? img : resize(img, rw, rh);
    if (enhance) small = autoContrast(small === img ? { data: new Uint8ClampedArray(img.data), width: rw, height: rh } : small);
    const input = new this.ort.Tensor('float32', toTensorData(small), [1, 3, rh, rw]);
    const out = await this.det.run({ [this.det.inputNames[0]]: input });
    const prob = out[this.det.outputNames[0]].data;
    const sx = img.width / rw, sy = img.height / rh, s = (sx + sy) / 2;
    const boxes = dbBoxes(prob, rw, rh, { thresh, boxThresh, unclipRatio })
      .map((b) => ({ cx: b.cx * sx, cy: b.cy * sy, w: b.w * s, h: b.h * s, angle: b.angle, score: b.score }));
    const ms = now() - t0;
    this.stats.detMs = ms;
    return { boxes, ms };
  }

  /**
   * Read one text line.
   * @param box   rotated rectangle in image pixels
   * @param flip    read the box upside down
   * @param enhance stretch the contrast of the crop first
   * @returns {{chars:{ch,conf,x}[], text:string, conf:number, ms:number, crop:object}}
   */
  async read(img, box, { flip = false, enhance = false } = {}) {
    const t0 = now();
    const w = Math.max(16, Math.min(REC_MAX_W, Math.ceil((REC_H * box.w) / Math.max(1, box.h))));
    const crop = cropBox(img, box, w, REC_H, flip);
    if (enhance) autoContrast(crop);
    const padW = Math.max(REC_MIN_W, w);
    const input = new this.ort.Tensor('float32', toTensorData(crop, padW), [1, 3, REC_H, padW]);
    const out = await this.rec.run({ [this.rec.inputNames[0]]: input });
    const o = out[this.rec.outputNames[0]];
    const T = o.dims[1], C = o.dims[2];
    const chars = ctcDecode(o.data, T, C, this.charset, w / padW);
    const real = chars.filter((c) => c.ch !== ' ' && c.ch !== JUNK);
    const conf = real.length ? real.reduce((s, c) => s + c.conf, 0) / real.length : 0;
    const ms = now() - t0;
    this.stats.recMs += ms; this.stats.recCalls++;
    return { chars, text: chars.map((c) => (c.ch === JUNK ? '·' : c.ch)).join(''), conf, ms, crop };
  }
}

function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
