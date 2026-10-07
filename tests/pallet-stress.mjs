// Stress test of the pallet reader: the reference photos made worse on
// purpose (further away, turned, blurred, dark, over-exposed, compressed),
// to see where reading stops working and, above all, whether a WRONG number
// is ever offered.
//
//   node tests/pallet-stress.mjs [photo-dir] [--limit 736] [--only blur2,far50] [--json out.json]
//
// Same requirements as tests/pallet-eval.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DEFAULT_CONFIG } from '../js/core/defaults.js';
import { PaddleEngine } from '../js/paddle/engine.js';
import { PalletReader } from '../js/pallet/reader.js';
import { toCandidate } from '../js/pallet/candidate.js';

const require = createRequire(process.env.NODE_MODULES_DIR ? path.join(process.env.NODE_MODULES_DIR, 'x.js') : import.meta.url);
const sharp = require('sharp');
const ort = require('onnxruntime-node');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : d; };
const limit = Number(flag('limit', 736)), only = flag('only', null), jsonOut = flag('json', null);
const root = path.dirname(new URL(import.meta.url).pathname);
const dir = args[0] || path.join(root, 'pallet-photos');
const M = process.env.MODELS || path.join(root, '..', 'vendor', 'paddle');
const files = { det: process.env.DET || 'det.onnx', rec: process.env.REC || 'rec.onnx', dict: process.env.DICT || 'dict.txt' };

const BG = { r: 96, g: 96, b: 96, alpha: 1 };
// name -> how the photo is damaged (s = a sharp pipeline, meta = its size)
export const VARIANTS = {
  original: (s) => s,
  far75: (s, m) => s.resize(Math.round(m.width * 0.75)),
  far50: (s, m) => s.resize(Math.round(m.width * 0.5)),
  far35: (s, m) => s.resize(Math.round(m.width * 0.35)),
  turn90: (s) => s.rotate(90),
  turn180: (s) => s.rotate(180),
  turn270: (s) => s.rotate(270),
  tilt12: (s) => s.rotate(12, { background: BG }),
  'tilt-12': (s) => s.rotate(-12, { background: BG }),
  tilt30: (s) => s.rotate(30, { background: BG }),
  blur1: (s) => s.blur(1.2),
  blur2: (s) => s.blur(2.4),
  dark: (s) => s.linear(0.35, 0),
  bright: (s) => s.linear(1.5, 40),
  lowcontrast: (s) => s.linear(0.4, 90),
  jpeg20: (s) => s.jpeg({ quality: 20 }),
  'far50+blur1': (s, m) => s.resize(Math.round(m.width * 0.5)).blur(1.2),
  'far50+dark': (s, m) => s.resize(Math.round(m.width * 0.5)).linear(0.35, 0),
};

async function render(file, fn) {
  const base = sharp(file).rotate();
  const meta = await sharp(file).metadata();
  const buf = await fn(base, meta).toBuffer();           // apply, then decode again (two steps: some ops reorder)
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

const engine = await PaddleEngine.create({
  ort, det: path.join(M, files.det), rec: path.join(M, files.rec), dict: fs.readFileSync(path.join(M, files.dict), 'utf8'),
  sessionOptions: { intraOpNumThreads: 1, interOpNumThreads: 1 },
});
const reader = new PalletReader(engine, () => DEFAULT_CONFIG, { detLimit: limit, ...(process.env.READER_OPTS ? JSON.parse(process.env.READER_OPTS) : {}) });
const gt = JSON.parse(fs.readFileSync(path.join(dir, 'ground-truth.json'), 'utf8'));
const names = only ? only.split(',') : Object.keys(VARIANTS);
const out = [];

console.log(`Models: ${files.det} + ${files.rec}, detector input ${limit}px`);
console.log('variant          read      as-is  review  suggest   WRONG (clean / flagged / suggestion)');
for (const name of names) {
  const t = { need: 0, read: 0, clean: 0, review: 0, sugg: 0, wrongClean: 0, wrongFlag: 0, wrongSugg: 0, wrongs: [] };
  for (const key of Object.keys(gt).sort()) {
    const img = await render(path.join(dir, `${key}.jpg`), VARIANTS[name]);
    const res = await reader.readFrame(img);
    const expected = gt[key];
    const offers = res.readings.map((r) => toCandidate(r, DEFAULT_CONFIG)).filter((c) => c.status !== 'INVALID').map((c) => {
      // What the card would put in front of staff: the suggestion when there is one, else the reading.
      const viaSuggestion = !!c.assess.suggestion;
      return { id: viaSuggestion ? c.assess.suggestion.suggestion : c.raw, viaSuggestion,
        flagged: c.status !== 'VALID' || c.conf < DEFAULT_CONFIG.thresholds.high, conf: c.meanConf, minConf: c.minConf, rival: c.rival, status: c.status, reasons: c.reviewReasons };
    });
    for (const g of expected) {
      if (g.level === 'optional' || g.level === 'damaged') continue;
      t.need++;
      const hit = offers.find((o) => o.id === g.id);
      if (!hit) continue;
      t.read++;
      if (hit.viaSuggestion) t.sugg++; else if (hit.flagged) t.review++; else t.clean++;
      out.push({ variant: name, key, id: g.id, ok: true, kind: hit.viaSuggestion ? 'sugg' : hit.flagged ? 'review' : 'clean', conf: hit.conf, minConf: hit.minConf, rival: hit.rival, status: hit.status, reasons: hit.reasons });
    }
    for (const o of offers) {
      if (expected.some((g) => g.id === o.id)) continue;
      if (o.viaSuggestion) t.wrongSugg++; else if (o.flagged) t.wrongFlag++; else t.wrongClean++;
      t.wrongs.push(`${key}:${o.id}${o.viaSuggestion ? '(sugg)' : o.flagged ? '(review)' : ''} ${o.conf.toFixed(0)}/${o.minConf.toFixed(0)}`);
      out.push({ variant: name, key, id: o.id, ok: false, kind: o.viaSuggestion ? 'sugg' : o.flagged ? 'review' : 'clean', conf: o.conf, minConf: o.minConf, rival: o.rival, status: o.status, reasons: o.reasons });
    }
  }
  console.log(`${name.padEnd(15)} ${String(t.read).padStart(2)}/${t.need}   ${String(t.clean).padStart(5)}  ${String(t.review).padStart(6)}  ${String(t.sugg).padStart(7)}   ${t.wrongClean} / ${t.wrongFlag} / ${t.wrongSugg}  ${t.wrongs.join('  ')}`);
}
const good = out.filter((x) => x.ok), bad = out.filter((x) => !x.ok);
const need = names.length * Object.values(gt).flat().filter((g) => g.level !== 'optional' && g.level !== 'damaged').length;
console.log(`\nAll variants together: ${good.length}/${need} plates read (${(100 * good.length / need).toFixed(1)}%), of which ${good.filter((x) => x.kind === 'clean').length} as a confident result.`);
console.log(`Wrong numbers: ${bad.filter((x) => x.kind === 'clean').length} shown as a confident result, ${bad.filter((x) => x.kind !== 'clean').length} shown for review (${(100 * bad.filter((x) => x.kind !== 'clean').length / need).toFixed(1)}%).`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
if (bad.some((x) => x.kind === 'clean')) process.exitCode = 1;
