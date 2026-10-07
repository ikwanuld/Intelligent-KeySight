// Pallet reader logic that needs no model and no browser:
//   node --test tests/pallet.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG as C } from '../js/core/defaults.js';
import { buildCharset, ctcDecode, JUNK } from '../js/paddle/ctc.js';
import { dbBoxes } from '../js/paddle/db.js';
import { cropBox, makeImage, autoContrast } from '../js/paddle/image.js';
import { groupLines, extendBox } from '../js/pallet/lines.js';
import { buildGrammar, parseLine, analyseLine } from '../js/pallet/parse.js';
import { toCandidate } from '../js/pallet/candidate.js';
import { PlateTracker } from '../js/pallet/tracker.js';
import { PalletReader } from '../js/pallet/reader.js';

const NOW = Date.parse('2026-10-07T02:00:00Z');
const G = buildGrammar(C, NOW);

/** "PMC 82529 R7" -> recogniser output. '·' = scratch/punctuation; {alts} per character by index. */
const line = (text, conf = 0.98, alts = {}) => [...text].map((ch, i) => ({
  ch: ch === '·' ? JUNK : ch, conf: typeof conf === 'function' ? conf(i, ch) : conf, x: (i + 0.5) / text.length, alts: alts[i] || [],
}));
const top = (text, conf, alts) => parseLine(line(text, conf, alts), G)[0];

// ------------------------------------------------------------------ parser --

test('parser: plain plates, with and without spaces', () => {
  for (const t of ['PMC 82529 R7', 'PMC82529R7', 'PMC·82529·R7', ' PMC  82529 R7 ']) {
    const p = top(t);
    assert.equal(p.fixed, 'PMC82529R7', t);
    assert.ok(p.exact && !p.skips && p.knownOwner && !p.unknownPrefix, t);
  }
  assert.equal(top('PAJ 0606 TRA').fixed, 'PAJ0606TRA', '4-digit serial with a 3-letter owner');
  assert.equal(top('AKE 1234 AI').fixed, 'AKE1234AI');
  assert.equal(parseLine(line('AKE 1234 MH'), G).length, 0, '4-digit serial is only valid with AI / SV');
  assert.equal(parseLine(line('TELEPORT CARGO'), G).length, 0);
  assert.equal(parseLine(line('MAX GROSS 6804 KG'), G).length, 0);
});

test('parser: rivets between the groups are skipped, and the result says so', () => {
  const p = top('OPAG O 21824 O R7O');
  assert.equal(p.fixed, 'PAG21824R7');
  assert.equal(p.raw, 'PAG21824R7', 'rivets are not part of what was read');
  assert.ok(p.exact);
  assert.ok(p.skips >= 3);
  assert.equal(top('PAG021824 0R7').fixed, 'PAG21824R7', 'a rivet that reads as the digit 0 sits outside the 5-digit serial');
  // At the very ends of the plate a rivet can come out as any round shape.
  const e = top('PAGO21824R79');
  assert.equal(e.fixed, 'PAG21824R7'); assert.ok(e.skips >= 2);
  assert.equal(top('8PMC 82529 R7').fixed, 'PMC82529R7');
});

test('parser: a rivet is never turned into a zero', () => {
  // Damaged plate: one digit gone, the rivet reads as "O". "PAG02229R7" would
  // have the right shape and be wrong.
  assert.equal(parseLine(line('OPAGO2229R70'), G).length, 0);
  const a = analyseLine(line('OPAGO2229R70'), G);
  assert.equal(a.parses.length, 0);
  assert.ok(a.partial, 'reported as unreadable so staff can type it');
  assert.equal(parseLine(line('PAG2229OR7'), G).length, 0, 'same at the end of the serial');
  // An O in the MIDDLE of the serial is the usual O/0 confusion: suggested, not applied.
  const p = top('PAG 7O229 R7');
  assert.equal(p.raw, 'PAG7O229R7'); assert.equal(p.fixed, 'PAG70229R7');
  assert.equal(p.exact, false);
  assert.deepEqual(p.fixes.map((f) => [f.at, f.from, f.to, f.kind]), [[4, 'O', '0', 'serial']]);
});

test('parser: type code one letter off a known one is suggested; ambiguous ones are only flagged', () => {
  const p = top('PMS 82529 R7');
  assert.equal(p.raw, 'PMS82529R7'); assert.equal(p.fixed, 'PMC82529R7');
  assert.equal(p.fixes[0].kind, 'prefix');
  // PNC is one letter from both PMC and PKC: no guess without evidence...
  const q = top('PNC 82399 R7');
  assert.equal(q.fixed, 'PNC82399R7'); assert.ok(q.unknownPrefix);
  assert.deepEqual([...q.nearPrefixes].sort(), ['PKC', 'PMC']);
  // ...but if the recogniser itself hesitated between N and M, that settles it.
  const r = top('PNC 82399 R7', 0.98, { 1: [['M', 0.3], ['K', 0.02]] });
  assert.equal(r.fixed, 'PMC82399R7');
  // A type code that is nothing like a known one is kept as read.
  const u = top('RKN 12345 R7');
  assert.ok(u.unknownPrefix); assert.equal(u.fixed, 'RKN12345R7'); assert.deepEqual(u.nearPrefixes, []);
});

test('parser: unknown owner code is kept unless the recogniser nearly read a known one', () => {
  const p = top('PMC 12345 XY');
  assert.equal(p.fixed, 'PMC12345XY'); assert.equal(p.knownOwner, false); assert.ok(p.exact);
  assert.equal(top('PAG 63631 RZ').fixed, 'PAG63631RZ', 'R7 and R9 are both one character away: no guess');
  const q = top('PAG 63631 RZ', 0.9, { 11: [['7', 0.4], ['2', 0.05]] });
  assert.equal(q.raw, 'PAG63631RZ'); assert.equal(q.fixed, 'PAG63631R7');
  assert.equal(q.fixes[0].kind, 'owner');
});

test('parser: two doubts together are not offered at all', () => {
  assert.equal(parseLine(line('PMS 12345 XY'), G).length, 0, 'type code to change + unknown owner');
  assert.equal(parseLine(line('PMC 1S3B5 R7'), G).length, 0, 'two characters to change');
  assert.equal(parseLine(line('RKN 12345 XY'), G).length, 0, 'unknown type + unknown owner');
});

test('parser: text stuck to the number is not ignored', () => {
  assert.equal(parseLine(line('PMC82529R7X'), G).length, 0);
  assert.equal(parseLine(line('XPMC82529R7'), G).length, 0);
  assert.equal(parseLine(line('PMC82529R712'), G).length, 0, 'more digits after the owner code are not rivets');
  assert.equal(top('NO PMC 82529 R7 KG').fixed, 'PMC82529R7', 'separate words around it are fine');
});

test('parser: says which part is missing', () => {
  assert.equal(analyseLine(line('PMC 82529'), G).hint, 'extend-right');
  assert.equal(analyseLine(line('PAG 6363'), G).hint, 'extend-right');
  assert.equal(analyseLine(line('82529 R7'), G).hint, 'extend-left');
  assert.equal(analyseLine(line('82399'), G).hint, 'extend-both');
  assert.equal(analyseLine(line('PMC 82529 R7'), G).hint, null);
  assert.equal(analyseLine(line('HELLO'), G).hint, null);
  assert.equal(analyseLine(line('PMC 82529'), G).partial.raw, 'PMC82529');
});

test('parser: follows the configured rules', () => {
  const cfg = structuredClone(C);
  cfg.prefixes.push({ prefix: 'PGA', category: 'PALLET', operational: true, active: true });
  cfg.operatorCodes.push('XY');
  const g = buildGrammar(cfg, NOW);
  const p = parseLine(line('PGA 12345 XY'), g)[0];
  assert.ok(p.exact && p.knownOwner && !p.unknownPrefix);
  cfg.validationRules = cfg.validationRules.filter((r) => !r.rule_id.startsWith('rule-pallet'));
  assert.equal(parseLine(line('PAJ 0606 TRA'), buildGrammar(cfg, NOW)).length, 0, 'no 3-letter-owner rule, no such number');
});

// --------------------------------------------------------------- candidate --

const reading = (text, extra = {}, conf, alts) => ({ ...top(text, conf, alts), text, how: 'direct', attempts: 1, bbox: { x0: 0.1, y0: 0.4, x1: 0.9, y1: 0.5 }, ...extra });

test('candidate: clean plate is VALID and solid; anything odd asks for a look', () => {
  const c = toCandidate(reading('PMC 82529 R7'), C, NOW);
  assert.equal(c.raw, 'PMC82529R7'); assert.equal(c.status, 'VALID'); assert.ok(c.solid);
  assert.equal(c.assess.suggestion, null); assert.equal(c.pipeline, 'pallet');

  const rivet = toCandidate(reading('OPAG O 21824 O R7O'), C, NOW);
  assert.equal(rivet.status, 'NEEDS_REVIEW'); assert.ok(!rivet.solid);
  assert.deepEqual(rivet.reviewReasons, ['Rivet or mark next to the number']);

  const edge = toCandidate(reading('PMC 82529 R7', { edge: true }), C, NOW);
  assert.deepEqual(edge.reviewReasons, ['Number at the edge of the picture']);
  const two = toCandidate(reading('PMC 82529 R7', { ambiguous: true }), C, NOW);
  assert.deepEqual(two.reviewReasons, ['Two possible readings']);
  const near = toCandidate(reading('PNC 82399 R7'), C, NOW);
  assert.equal(near.status, 'NEEDS_REVIEW');
  assert.match(near.reviewReasons[0], /Type code may be misread \((PKC or PMC|PMC or PKC)\?\)/);
});

test('candidate: one weak character caps the confidence of the whole number', () => {
  const weak = (at, v) => (i) => (i === at ? v : 0.99);
  const a = toCandidate(reading('PMC 82529 R7', {}, weak(5, 0.82)), C, NOW);
  assert.ok(a.meanConf > 95);
  assert.equal(Math.round(a.conf), 87, 'weakest 82 + margin 5');
  assert.ok(a.conf < C.thresholds.high, 'so it is shown as "check the reading", not high confidence');
  assert.ok(!a.solid);
  const b = toCandidate(reading('PMC 82529 R7', {}, weak(5, 0.93)), C, NOW);
  assert.ok(b.conf >= C.thresholds.high); assert.ok(!b.solid, 'but one frame is not enough for it');
});

test('candidate: a character the recogniser nearly read as something else is never high confidence', () => {
  // The embossed plate on the reference photos: "3" read as "2" at 82 %, with 15 % on the 3.
  const torn = toCandidate(reading('PAG 63621 R7', {}, (i) => (i === 7 ? 0.84 : 0.99), { 7: [['3', 0.15]] }), C, NOW);
  assert.equal(torn.status, 'VALID');
  assert.ok(torn.conf < C.thresholds.high, `conf ${torn.conf}`);
  assert.ok(!torn.solid);
  const veryTorn = toCandidate(reading('PAG 63621 R7', {}, 0.99, { 7: [['3', 0.35]] }), C, NOW);
  assert.ok(veryTorn.conf < C.thresholds.review, 'a 35 % rival is an uncertain reading');
  const sure = toCandidate(reading('PAG 63631 R7', {}, 0.99, { 7: [['2', 0.02]] }), C, NOW);
  assert.ok(sure.conf >= C.thresholds.high); assert.ok(sure.solid);
});

test('candidate: suggestions come from the pallet parser only', () => {
  const s = toCandidate(reading('PMS 82529 R7'), C, NOW);
  assert.equal(s.raw, 'PMS82529R7'); assert.equal(s.assess.suggestion.suggestion, 'PMC82529R7');
  assert.equal(s.status, 'VALID'); assert.ok(!s.solid, 'a suggestion is never accepted on one frame');
  // A fragment the general corrector could "fix" into a ULD (rivet O -> 0) must stay unreadable.
  const part = toCandidate({ partial: true, raw: 'PAGO2229R7', conf: 0.9, text: 'PAGO2229R7', bbox: null }, C, NOW);
  assert.equal(part.status, 'INVALID'); assert.equal(part.assess.suggestion, null); assert.ok(part.partial);
  // ...and so must a fragment that happens to spell a valid number.
  const guess = toCandidate({ partial: true, raw: 'PAG63824R7', conf: 0.5, text: 'PAG 63824 R7', bbox: null }, C, NOW);
  assert.equal(guess.status, 'INVALID');
});

// ----------------------------------------------------------------- tracker --

const obs = (text, y, o = {}) => {
  const c = toCandidate(reading(text, { bbox: { x0: 0.1, y0: y, x1: 0.9, y1: y + 0.08 }, ...o.extra }, o.conf, o.alts), C, NOW);
  return c;
};
const shaky = (i) => (i === 5 ? 0.9 : 0.99);          // fine, but not "solid"

test('tracker: two plates in one frame are two plates, however alike their numbers', () => {
  const t = new PlateTracker(() => C);
  const out = t.update([obs('PMC 26596 R9', 0.2), obs('PMC 26597 R9', 0.4)], 0);
  assert.deepEqual(out.results.map((r) => r.obs.raw), ['PMC26596R9', 'PMC26597R9']);
  assert.equal(t.tracks.length, 2);
  assert.equal(t.update([obs('PMC 26597 R9', 0.4), obs('PMC 26596 R9', 0.2)], 500).results.length, 0, 'seen again: nothing new');
  assert.equal(t.tracks.length, 2);
});

test('tracker: a solid reading shows after one frame, a merely good one needs two', () => {
  const t = new PlateTracker(() => C);
  assert.equal(t.update([obs('PMC 82529 R7', 0.3)], 0).results.length, 1);
  const u = new PlateTracker(() => C);
  assert.equal(u.update([obs('PMC 82529 R7', 0.3, { conf: shaky })], 0).results.length, 0);
  const r = u.update([obs('PMC 82529 R7', 0.31, { conf: shaky })], 600).results;
  assert.equal(r.length, 1); assert.equal(r[0].frames, 2); assert.equal(r[0].conflict, false);
});

test('tracker: the next plate up the stack is not swallowed by the one just reported', () => {
  const t = new PlateTracker(() => C);
  t.update([obs('PMC 82529 R7', 0.3)], 0);
  // Camera moved: a different valid number now sits in the same place.
  assert.equal(t.update([obs('PMC 82399 R7', 0.3)], 700).results.length, 0, 'not believed on one frame (could be a misread)');
  const r = t.update([obs('PMC 82399 R7', 0.3)], 1400).results;
  assert.deepEqual(r.map((x) => x.obs.raw), ['PMC82399R7']);
});

test('tracker: after the camera moved, a new number in the old place needs no second frame', () => {
  const t = new PlateTracker(() => C);
  t.update([obs('PMC 82529 R7', 0.3)], 0);
  t.movedAt = 400;                                   // the pipeline saw the picture shift
  assert.deepEqual(t.update([obs('PMC 82399 R7', 0.3)], 700).results.map((x) => x.obs.raw), ['PMC82399R7']);
  // ...while the plate reported before is still recognised by its text, wherever it now is.
  assert.equal(t.update([obs('PMC 82529 R7', 0.6)], 1400).results.length, 0);
});

test('tracker: the same plate read as two different numbers is flagged', () => {
  const t = new PlateTracker(() => C);
  t.update([obs('PAG 63631 R7', 0.3, { conf: shaky })], 0);
  t.update([obs('PAG 63621 R7', 0.3, { conf: shaky })], 600);
  const r = t.update([obs('PAG 63631 R7', 0.3, { conf: shaky })], 1200).results;
  assert.equal(r.length, 1);
  assert.equal(r[0].obs.raw, 'PAG63631R7'); assert.equal(r[0].conflict, true);
});

test('tracker: a reading with a suggestion counts as a reading of the suggested number', () => {
  const t = new PlateTracker(() => C);
  t.update([obs('PMS 82529 R7', 0.3)], 0);
  const r = t.update([obs('PMC 82529 R7', 0.3, { conf: shaky })], 600).results;
  assert.equal(r.length, 1);
  assert.equal(r[0].obs.raw, 'PMC82529R7', 'the clean reading wins over the one that needs a correction');
  assert.equal(r[0].conflict, false);
});

test('tracker: an unreadable plate surfaces only after staying unreadable, even if its text keeps changing', () => {
  const part = (raw, y) => toCandidate({ partial: true, raw, conf: 0.6, text: raw, bbox: { x0: 0.1, y0: y, x1: 0.9, y1: y + 0.08 } }, C, NOW);
  const t = new PlateTracker(() => C);
  assert.equal(t.update([part('PAG6363', 0.3)], 0).results.length, 0);
  const r = t.update([part('PAG63B31', 0.3)], 600).results;
  assert.equal(r.length, 1); assert.equal(r[0].status, 'INVALID');
  assert.equal(t.update([part('PAG6363IR', 0.3)], 1200).results.length, 0, 'reported once');
  // ...and never while a readable version is forming.
  const u = new PlateTracker(() => C);
  u.update([obs('PAG 63631 R7', 0.3, { conf: shaky })], 0);
  assert.equal(u.update([part('PAG6363', 0.3)], 600).results.length, 0);
  assert.equal(u.update([part('PAG6363', 0.3)], 1200).results.length, 0);
  assert.equal(u.update([obs('PAG 63631 R7', 0.3, { conf: shaky })], 1800).results[0].obs.raw, 'PAG63631R7');
});

test('tracker: a plate that is seen but not re-read stays alive', () => {
  const t = new PlateTracker(() => C);
  const id = t.update([obs('PMC 82529 R7', 0.3)], 0).results[0].track.id;
  t.touch(id, { x0: 0.1, y0: 0.32, x1: 0.9, y1: 0.4 }, 1400);
  t.update([], 2500);
  assert.equal(t.tracks.length, 1);
  t.update([], 5000);
  assert.equal(t.tracks.length, 0);
});

// ------------------------------------------------------------ CTC decoding --

test('decoder: "C", "c" and full-width "Ｃ" are one character; runner-up characters are reported', () => {
  const dict = ['', 'C', 'c', 'G', '7', 'Z', '。', 'Ｃ', ' '];           // index-aligned: 0 = blank
  const cs = buildCharset(dict.join('\n'), dict.length);
  assert.deepEqual([...cs], ['', 'C', 'C', 'G', '7', 'Z', JUNK, 'C', ' ']);
  const T = 6, K = dict.length, p = new Float32Array(T * K);
  const set = (t, o) => Object.entries(o).forEach(([k, v]) => { p[t * K + dict.indexOf(k)] = v; });
  set(0, { G: 0.4, C: 0.35, c: 0.25 });        // argmax says G, but C + c = 0.6
  set(1, { c: 0.5, 'Ｃ': 0.45 });               // same character continues: no second C, and its best moment counts
  p[2 * K] = 1;                                 // blank
  set(3, { Z: 0.55, 7: 0.4 });
  set(4, { '。': 0.9 });                         // punctuation = separator
  set(5, { 7: 1 });
  const out = ctcDecode(p, T, K, cs, 1);
  assert.deepEqual(out.map((c) => c.ch), ['C', 'Z', JUNK, '7']);
  assert.ok(Math.abs(out[0].conf - 0.95) < 1e-6);
  assert.equal(out[1].alts[0][0], '7'); assert.ok(Math.abs(out[1].alts[0][1] - 0.4) < 1e-6);
  assert.ok(out[0].x < out[1].x && out[1].x < out[3].x);
});

// ---------------------------------------------------------------- geometry --

test('detector post-processing: a tilted text blob becomes a tilted box', () => {
  const W = 200, H = 120, prob = new Float32Array(W * H);
  const ang = (20 * Math.PI) / 180, c = Math.cos(ang), s = Math.sin(ang);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - 100, dy = y - 60, u = dx * c + dy * s, v = -dx * s + dy * c;
    if (Math.abs(u) < 60 && Math.abs(v) < 8) prob[y * W + x] = 0.9;
  }
  const [b] = dbBoxes(prob, W, H);
  assert.ok(Math.abs(b.cx - 100) < 2 && Math.abs(b.cy - 60) < 2);
  assert.ok(Math.abs(b.angle - ang) < 0.05, `angle ${b.angle}`);
  assert.ok(b.w > 130 && b.w < 160 && b.h > 30 && b.h < 50, `${b.w} x ${b.h} (grown back from the shrunk kernel)`);
  assert.equal(dbBoxes(new Float32Array(W * H), W, H).length, 0);
});

test('lines: pieces of one plate are joined, plates above each other are not', () => {
  const box = (cx, cy, w, h = 30, angle = 0) => ({ cx, cy, w, h, angle, score: 0.9 });
  const one = groupLines([box(100, 100, 90), box(260, 102, 150), box(400, 101, 60)]);
  assert.equal(one.length, 1);
  assert.equal(one[0].parts, 3);
  assert.ok(Math.abs(one[0].w - 375) < 6, `spans all three: ${one[0].w}`);
  const stack = groupLines([box(250, 100, 380), box(250, 150, 380), box(250, 200, 380)]);
  assert.equal(stack.length, 3);
  assert.equal(groupLines([box(100, 100, 90), box(700, 100, 90)]).length, 2, 'too far apart');
  assert.equal(groupLines([box(100, 100, 90), box(220, 100, 90, 30, 0.6)]).length, 2, 'different direction');
  const e = extendBox(box(200, 100, 100), 1, 2);
  assert.equal(e.w, 190); assert.equal(e.cx, 215);
});

test('image helpers: rotated crop reads along the text, flipped crop is the same thing upside down', () => {
  const img = makeImage(100, 60);
  for (let y = 0; y < 60; y++) for (let x = 0; x < 100; x++) { const o = (y * 100 + x) * 4; img.data[o] = x * 2; img.data[o + 1] = y * 4; img.data[o + 3] = 255; }
  const b = { cx: 50, cy: 30, w: 40, h: 20, angle: 0 };
  const a = cropBox(img, b, 40, 20), f = cropBox(img, b, 40, 20, true);
  assert.ok(a.data[0] < a.data[(39) * 4], 'red grows to the right');
  for (const [x, y] of [[0, 0], [10, 5], [39, 19]]) {
    const i = (y * 40 + x) * 4, j = ((19 - y) * 40 + (39 - x)) * 4;
    assert.ok(Math.abs(a.data[i] - f.data[j]) <= 1 && Math.abs(a.data[i + 1] - f.data[j + 1]) <= 1);
  }
  const v = cropBox(img, { ...b, angle: Math.PI / 2 }, 40, 20);
  assert.ok(v.data[1] < v.data[39 * 4 + 1], 'text running down the picture: green (y) grows along the crop');
});

test('image helpers: contrast stretch lifts a dull crop and leaves a full-range one alone', () => {
  const dull = makeImage(64, 16);
  for (let i = 0; i < 64 * 16; i++) { const v = 100 + (i % 2) * 60; dull.data.set([v, v, v, 255], i * 4); }
  autoContrast(dull);
  assert.ok(dull.data[0] < 20 && dull.data[4] > 235, `${dull.data[0]} / ${dull.data[4]}`);
  const flat = makeImage(64, 16);                       // nearly featureless: noise must not be blown up to full range
  for (let i = 0; i < 64 * 16; i++) { const v = 120 + (i % 2) * 10; flat.data.set([v, v, v, 255], i * 4); }
  autoContrast(flat);
  assert.ok(flat.data[4] - flat.data[0] <= 40, `${flat.data[0]} / ${flat.data[4]}`);
  const full = makeImage(64, 16);
  for (let i = 0; i < 64 * 16; i++) { const v = (i % 2) * 255; full.data.set([v, v, v, 255], i * 4); }
  const before = full.data.slice();
  autoContrast(full);
  assert.deepEqual(full.data, before);
});

// ------------------------------------------------------------------ reader --
// The reader with a scripted engine: what it tries, in which order, and what it makes of it.

function fakeEngine(script) {
  const calls = [];
  return {
    calls, stats: { recMs: 0, recCalls: 0 },
    async detect() { return { boxes: [{ cx: 320, cy: 240, w: 400, h: 40, angle: 0, score: 0.9 }], ms: 1 }; },
    async read(img, box, { flip = false, enhance = false } = {}) {
      const key = `${flip ? 'flipped' : 'direct'}${box.w > 400 ? '+long' : ''}${enhance ? '+contrast' : ''}`;
      calls.push(key); this.stats.recCalls++;
      const text = script[key] ?? '';
      const chars = Array.isArray(text) ? text : line(text);
      return { chars, text: chars.map((c) => c.ch).join(''), conf: chars.length ? chars.reduce((s, c) => s + c.conf, 0) / chars.length : 0, ms: 1 };
    },
  };
}
const frame = makeImage(640, 480);
const readOne = async (script, options = {}) => {
  const engine = fakeEngine(script);
  const res = await new PalletReader(engine, () => C, { evidenceWidth: 0, ...options }).readFrame(frame);
  return { engine, res, r: res.readings[0] };
};

test('reader: a clean plate takes one reading', async () => {
  const { engine, r } = await readOne({ direct: 'PMC 82529 R7' });
  assert.deepEqual(engine.calls, ['direct']);
  assert.equal(r.fixed, 'PMC82529R7'); assert.equal(r.flip, false);
});

test('reader: an upside-down plate is found even when the first reading looks confident', async () => {
  const { engine, r } = await readOne({ direct: 'LY 62528 OWd', flipped: 'PMC 82529 R7' });
  assert.deepEqual(engine.calls, ['direct', 'flipped']);
  assert.equal(r.fixed, 'PMC82529R7'); assert.equal(r.flip, true);
});

test('reader: a missing group is looked for further along the line', async () => {
  const { engine, r } = await readOne({ direct: 'PMC 82529', 'direct+long': 'PMC 82529 R7' });
  assert.deepEqual(engine.calls, ['direct', 'flipped', 'direct+long']);
  assert.equal(r.fixed, 'PMC82529R7'); assert.equal(r.how, 'extended');
});

test('reader: text that is not a ULD number gives nothing', async () => {
  const { res } = await readOne({ direct: 'TELEPORT', flipped: 'LHOdƎ73L' });
  assert.equal(res.readings.length, 0);
  assert.equal(res.other.length, 1, 'but its place is reported, so it need not be read again');
});

test('reader: a second look that disagrees is reported as two possible readings', async () => {
  const dull = (i) => (i === 7 ? 0.8 : 0.99);
  const { engine, r } = await readOne({ direct: line('PAG 63631 R7', dull), 'direct+contrast': line('PAG 63621 R7', dull) });
  assert.deepEqual(engine.calls, ['direct', 'direct+contrast']);
  assert.ok(r.ambiguous);
  assert.equal(toCandidate(r, C, NOW).status, 'NEEDS_REVIEW');
});

test('reader: a shaky reading with something odd about it is shown as unreadable, not offered', async () => {
  const shakyOwner = (i) => (i === 10 ? 0.4 : 0.99);
  const { r } = await readOne({ direct: line('PMC 12345 XY', shakyOwner), flipped: '', 'direct+contrast': '' });
  assert.ok(r.partial);
  assert.equal(r.raw, 'PMC12345XY');
  assert.equal(toCandidate(r, C, NOW).status, 'INVALID', 'even though it has the shape of a ULD number');
});

test('reader: places the caller already knows are not read again', async () => {
  const engine = fakeEngine({ direct: 'PMC 82529 R7' });
  const res = await new PalletReader(engine, () => C, { evidenceWidth: 0 }).readFrame(frame, { skip: () => true });
  assert.equal(engine.calls.length, 0);
  assert.equal(res.skipped.length, 1);
});
