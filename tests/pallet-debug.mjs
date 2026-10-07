// Shows every reading attempt for chosen photos:  node tests/pallet-debug.mjs p-000 p-006 [--limit 736]
// (any image path works too). Same requirements as tests/pallet-eval.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DEFAULT_CONFIG } from '../js/core/defaults.js';
import { PaddleEngine } from '../js/paddle/engine.js';
import { PalletReader } from '../js/pallet/reader.js';
import { toCandidate } from '../js/pallet/candidate.js';
const require = createRequire(process.env.NODE_MODULES_DIR ? path.join(process.env.NODE_MODULES_DIR, 'x.js') : import.meta.url);
const sharp = require('sharp'); const ort = require('onnxruntime-node');
const args = process.argv.slice(2);
const li = args.indexOf('--limit'); const limit = li >= 0 ? Number(args.splice(li, 2)[1]) : 736;
const root = path.dirname(new URL(import.meta.url).pathname);
const M = process.env.MODELS || path.join(root, '..', 'vendor', 'paddle');
const engine = await PaddleEngine.create({ ort, det: path.join(M, process.env.DET || 'det.onnx'), rec: path.join(M, process.env.REC || 'rec.onnx'),
  dict: fs.readFileSync(path.join(M, process.env.DICT || 'dict.txt'), 'utf8'), sessionOptions: { intraOpNumThreads: 1 } });
const reader = new PalletReader(engine, () => DEFAULT_CONFIG, { detLimit: limit, debug: true, ...(process.env.READER_OPTS ? JSON.parse(process.env.READER_OPTS) : {}) });
const show = (c) => `${c.ch === ' ' ? '_' : c.ch === '\u0001' ? '·' : c.ch}${Math.round(c.conf * 100)}${c.alts?.length && c.alts[0][1] >= 0.03 ? `(${c.alts.filter((a) => a[1] >= 0.03).map((a) => a[0] + Math.round(a[1] * 100)).join(',')})` : ''}`;
for (const key of args) {
  const file = fs.existsSync(key) ? key : path.join(root, 'pallet-photos', `${key}.jpg`);
  const { data, info } = await sharp(file).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
  reader.trace = [];
  const res = await reader.readFrame(img);
  console.log(`\n${key}: ${res.lines.length} lines, det ${res.detMs.toFixed(0)}ms, rec ${res.recMs.toFixed(0)}ms / ${res.recCalls} calls`);
  for (const { line, tries } of reader.trace) {
    console.log(`  line ${line.w.toFixed(0)}x${line.h.toFixed(0)} @${(line.angle * 57.3).toFixed(0)}° parts=${line.parts}`);
    for (const t of tries) {
      console.log(`    ${t.how.padEnd(8)} "${t.text}" conf=${t.conf.toFixed(2)} hint=${t.hint || '-'} partial=${t.partial?.raw || '-'}`);
      console.log('             ' + t.chars.map(show).join(' '));
      for (const p of t.parses.slice(0, 3)) console.log(`             -> ${p.raw}${p.fixed !== p.raw ? ' => ' + p.fixed : ''} score=${p.score.toFixed(1)} skips=${p.skips} knownOwner=${p.knownOwner} unknownPrefix=${p.unknownPrefix} conf=${p.conf.toFixed(2)}/${p.minConf.toFixed(2)}`);
    }
  }
  for (const r of res.readings) {
    const c = toCandidate(r, DEFAULT_CONFIG);
    console.log(`  => ${c.raw}${c.assess.suggestion ? ' (suggest ' + c.assess.suggestion.suggestion + ')' : ''}  ${c.status}${c.partial ? ' partial' : ''}  conf ${c.conf.toFixed(0)} (mean ${c.meanConf.toFixed(0)}, weakest ${c.minConf.toFixed(0)})  ${[...c.assess.best.reasons, ...c.reviewReasons].join('; ')}`);
  }
}
