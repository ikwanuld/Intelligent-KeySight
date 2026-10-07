// Accuracy check of the pallet reader on real photos.
//
//   node tests/pallet-eval.mjs [photo-dir] [--out annotated-dir] [--limit 736]
//
// Photo dir must contain *.jpg and ground-truth.json:
//   { "<file name without .jpg>": [ { "id": "PAG70229R7", "level": "clear|hard|damaged|optional" } ] }
// Needs dev dependencies:  npm i -D onnxruntime-node sharp
// (or NODE_MODULES_DIR=/path/with/node_modules).
//
// A photo "passes" when every expected ID is read (optional ones may be
// missed) and no wrong ID is shown as a confident result. That second
// condition matters most: a wrong number that looks right is worse than no
// number. A wrong number shown "for review" (staff are told why to check it)
// is counted separately.

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
const outDir = flag('out', null), limit = Number(flag('limit', 736)), quiet = flag('quiet', null) !== null;
const root = path.dirname(new URL(import.meta.url).pathname);
const dir = args[0] || path.join(root, 'pallet-photos');
const M = process.env.MODELS || path.join(root, '..', 'vendor', 'paddle');
const files = { det: process.env.DET || 'det.onnx', rec: process.env.REC || 'rec.onnx', dict: process.env.DICT || 'dict.txt' };

export async function loadImage(file) {
  const { data, info } = await sharp(file).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

const engine = await PaddleEngine.create({
  ort, det: path.join(M, files.det), rec: path.join(M, files.rec), dict: fs.readFileSync(path.join(M, files.dict), 'utf8'),
  sessionOptions: { intraOpNumThreads: 1, interOpNumThreads: 1 },
});
const reader = new PalletReader(engine, () => DEFAULT_CONFIG, { detLimit: limit, ...(process.env.READER_OPTS ? JSON.parse(process.env.READER_OPTS) : {}) });
const gt = JSON.parse(fs.readFileSync(path.join(dir, 'ground-truth.json'), 'utf8'));
if (outDir) fs.mkdirSync(outDir, { recursive: true });

const tally = { clear: [0, 0], hard: [0, 0], damaged: [0, 0], optional: [0, 0] };
let wrong = 0, wrongFlagged = 0, photosOk = 0, detMs = 0, recMs = 0, recCalls = 0;
const rows = [];

for (const key of Object.keys(gt).sort()) {
  const file = path.join(dir, `${key}.jpg`);
  const img = await loadImage(file);
  const res = await reader.readFrame(img);
  detMs += res.detMs; recMs += res.recMs; recCalls += res.recCalls;
  const cands = res.readings.map((r) => ({ r, c: toCandidate(r, DEFAULT_CONFIG) }));
  // "Offered" = what staff could confirm: the raw reading when it is valid, or the suggestion.
  // What the card would put in front of staff: the suggestion when there is one, else the reading.
  const offered = cands.filter(({ c }) => c.status !== 'INVALID').map(({ c }) => ({
    id: c.assess.suggestion ? c.assess.suggestion.suggestion : c.raw,
    viaSuggestion: !!c.assess.suggestion, status: c.assess.suggestion ? 'SUGGESTED' : c.status,
    conf: Math.round(c.conf), review: [...c.assess.best.reasons, ...c.reviewReasons, ...(c.conf < DEFAULT_CONFIG.thresholds.high ? ['Check the reading'] : [])],
  }));
  for (const o of offered) o.flagged = o.viaSuggestion || o.review.length > 0;
  const expected = gt[key];
  let ok = true;
  const notes = [];
  for (const g of expected) {
    const hit = offered.find((o) => o.id === g.id);
    tally[g.level][1]++;
    if (hit) { tally[g.level][0]++; notes.push(`✓ ${g.id}${hit.viaSuggestion ? ' (as suggestion)' : ''}${hit.review.length ? ` [review: ${hit.review.join('; ')}]` : ''} ${hit.conf}%`); }
    else { notes.push(`✗ ${g.id} (${g.level}) not read`); if (g.level !== 'optional' && g.level !== 'damaged') ok = false; }
  }
  for (const o of offered) {
    if (expected.some((g) => g.id === o.id)) continue;
    if (o.flagged) { wrongFlagged++; notes.push(`!  wrong ${o.id} shown for review [${o.review.join('; ') || 'suggestion'}]`); }
    else { wrong++; ok = false; notes.push(`!! WRONG ${o.id} shown as a confident result (${o.conf}%)`); }
  }
  for (const { r, c } of cands) if (c.status === 'INVALID') notes.push(`· unreadable, shown for manual entry: "${r.text}"`);
  if (ok) photosOk++;
  rows.push({ key, ok, notes });
  if (!quiet) console.log(`${ok ? 'PASS' : 'FAIL'} ${key}  det ${res.detMs.toFixed(0)}ms rec ${res.recMs.toFixed(0)}ms/${res.recCalls}\n     ${notes.join('\n     ')}`);

  if (outDir) {
    const col = { VALID: '#2FBF71', NEEDS_REVIEW: '#F0A91E', INVALID: '#FF6B5E' };
    const shapes = cands.map(({ r, c }) => {
      const pts = r.quad.map(([x, y]) => `${(x * img.width).toFixed(0)},${(y * img.height).toFixed(0)}`).join(' ');
      const [x, y] = [Math.min(...r.quad.map((q) => q[0])) * img.width, Math.min(...r.quad.map((q) => q[1])) * img.height];
      const label = c.status === 'INVALID' ? 'unreadable' : (c.assess.suggestion ? `${c.raw} -> ${c.assess.suggestion.suggestion}?` : c.raw);
      // Same three colours as the app: confident, shown for review, shown for typing.
      const flagged = c.status === 'NEEDS_REVIEW' || !!c.assess.suggestion || c.conf < DEFAULT_CONFIG.thresholds.high;
      const cc = col[c.status === 'INVALID' ? 'INVALID' : flagged ? 'NEEDS_REVIEW' : 'VALID'];
      return `<polygon points="${pts}" fill="none" stroke="${cc}" stroke-width="6"/>
        <rect x="${x}" y="${Math.max(0, y - 46)}" width="${label.length * 23 + 16}" height="42" fill="#111C26"/>
        <text x="${x + 8}" y="${Math.max(0, y - 46) + 31}" font-family="DejaVu Sans Mono, monospace" font-weight="bold" font-size="36" fill="${cc}">${label.replace(/>/g, '&gt;')}</text>`;
    }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${img.width}" height="${img.height}">${shapes}</svg>`;
    await sharp(file).rotate().composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 85 }).toFile(path.join(outDir, `${key}.jpg`));
  }
}

const n = Object.keys(gt).length;
const pct = ([a, b]) => `${a}/${b}`;
console.log(`\nModels: ${files.det} + ${files.rec}, detector input ${limit}px`);
console.log(`Clear plates read:        ${pct(tally.clear)}`);
console.log(`Hard plates read:         ${pct(tally.hard)}   (embossed, engraved, upside down, tilted)`);
console.log(`Damaged plate read:       ${pct(tally.damaged)}`);
console.log(`Optional (blurred) read:  ${pct(tally.optional)}`);
console.log(`Wrong number shown as a confident result: ${wrong}`);
console.log(`Wrong number shown for review:            ${wrongFlagged}`);
console.log(`Photos passed:            ${photosOk}/${n}`);
console.log(`Time per photo (1 thread, native): detect ${(detMs / n).toFixed(0)}ms + read ${(recMs / n).toFixed(0)}ms (${(recCalls / n).toFixed(1)} lines)`);
if (process.env.JSON_OUT) fs.writeFileSync(process.env.JSON_OUT, JSON.stringify({ tally, wrong, wrongFlagged, photosOk, n, rows }, null, 1));
process.exitCode = wrong ? 1 : 0;
