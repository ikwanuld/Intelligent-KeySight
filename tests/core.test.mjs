// Run with:  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG as C, withDefaults, scanModes } from '../js/core/defaults.js';
import { validate, activeRules, displayParts } from '../js/validation/validator.js';
import { suggest, assess } from '../js/correction/corrector.js';
import { canonical, findDuplicate } from '../js/duplicate/duplicate.js';
import { extractCandidates } from '../js/ocr/candidates.js';
import { Tracker } from '../js/tracking/tracker.js';

const NOW = Date.parse('2026-10-04T02:00:00Z');
const v = (t, cfg = C) => validate(t, cfg, NOW);

test('AI/SV rule: 3 letters + 4 digits + AI/SV', () => {
  assert.equal(v('AKE1234AI').status, 'VALID');
  assert.equal(v('AKH2468SV').status, 'VALID');
  assert.deepEqual(v('AKE1234AI').parts, { prefix: 'AKE', serial: '1234', code: 'AI' });
  assert.equal(v('AKE1234MH').status, 'INVALID', '4-digit serial with another operator');
  assert.equal(v('AKE12345AI').status, 'INVALID', 'AI must not use the 5-digit rule');
});

test('standard rule: 3 letters + 5 digits + 2 alphanumeric', () => {
  assert.equal(v('AKE12345MH').status, 'VALID');
  assert.equal(v('AKE79210R7').status, 'VALID', 'digit in operator code is legitimate');
  assert.equal(v('ake 12345 mh').value, 'AKE12345MH');
});

test('needs review: unknown operator code or prefix', () => {
  const r = v('AKE12345XX');
  assert.equal(r.status, 'NEEDS_REVIEW');
  assert.deepEqual(r.reasons, ['Unknown airline/operator code']);
  assert.equal(v('XYZ12345MH').status, 'NEEDS_REVIEW');
  assert.equal(v('XYZ12345MH').reasons[0], 'Unknown ULD prefix');
});

test('invalid formats', () => {
  for (const t of ['AKE123AI', 'AKE1234A1', 'AK112345MH', 'AKE1234567MH', '', 'AKE12E45MH']) {
    assert.equal(v(t).status, 'INVALID', t);
  }
});

test('categories: containers and pallets are told apart (each is counted in its own scan mode)', () => {
  const c = v('AAY56789MH');
  assert.equal(c.category, 'CONTAINER'); assert.equal(c.operational, true);
  const p = v('PAG12345MH');
  assert.equal(p.status, 'VALID');
  assert.equal(p.category, 'PALLET');
  assert.equal(p.operational, true);
});

test('pallets: three-letter owner codes with 4- or 5-digit serials, pallet prefixes only', () => {
  assert.equal(v('PAJ0606TRA').status, 'VALID');
  assert.deepEqual(v('PAJ0606TRA').parts, { prefix: 'PAJ', serial: '0606', code: 'TRA' });
  assert.equal(v('PMC12345TRA').status, 'VALID');
  assert.equal(v('PAJ0606XYZ').status, 'NEEDS_REVIEW', 'unknown owner code');
  assert.equal(v('AKE0606TRA').status, 'INVALID', 'containers do not use the pallet rule');
  assert.deepEqual(displayParts('PAJ0606TRA'), ['PAJ', '0606', 'TRA']);
  assert.deepEqual(displayParts('PMC82529R7'), ['PMC', '82529', 'R7']);
  assert.deepEqual(displayParts('AKE1234AI'), ['AKE', '1234', 'AI']);
});

test('a configuration from before pallet mode is brought up to date without touching the rules', () => {
  const old = structuredClone(C);
  delete old.scanModes;
  old.prefixes.forEach((x) => { if (x.category === 'PALLET') x.operational = false; });
  const cfg = withDefaults(old);
  assert.equal(validate('PMC12345MH', cfg, NOW).operational, true);
  assert.deepEqual(scanModes(cfg).map((m) => m.mode), ['CONTAINER', 'PALLET']);
  assert.equal(cfg.validationRules, old.validationRules);
  assert.equal(withDefaults(C), C, 'a current configuration is returned as it is');
});

test('rule versioning: scan time selects the version, history is not recalculated', () => {
  const cfg = structuredClone(C);
  cfg.validationRules.push({ ...cfg.validationRules[1], rule_version: 2, serial_length: 6,
    effective_from: '2026-10-10T00:00:00Z' });
  cfg.validationRules[1].effective_until = '2026-10-10T00:00:00Z';
  const before = Date.parse('2026-10-05T00:00:00Z'), after = Date.parse('2026-10-12T00:00:00Z');
  assert.equal(validate('AKE12345MH', cfg, before).rule.rule_version, 1);
  assert.equal(validate('AKE12345MH', cfg, after).status, 'INVALID');
  assert.equal(validate('AKE123456MH', cfg, after).rule.rule_version, 2);
  assert.equal(activeRules(cfg, after).length, C.validationRules.length, 'one version per rule');
  assert.deepEqual(activeRules(cfg, after).filter((r) => r.rule_id === 'rule-standard').map((r) => r.rule_version), [2]);
});

test('inactive rules and prefixes are ignored', () => {
  const cfg = structuredClone(C);
  cfg.validationRules[0].active = false;
  assert.equal(validate('AKE1234AI', cfg, NOW).status, 'INVALID');
  cfg.prefixes[0].active = false;
  assert.equal(validate('AKE12345MH', cfg, NOW).status, 'NEEDS_REVIEW');
});

test('correction is context-aware and suggestion-only', () => {
  const s = suggest('AKE1234A1', C, NOW);
  assert.equal(s.suggestion, 'AKE1234AI');
  assert.deepEqual(s.changes, [{ pos: 8, from: '1', to: 'I' }]);
  assert.equal(suggest('AKEI2345MH', C, NOW).suggestion, 'AKE12345MH', 'I in numeric position');
  assert.equal(suggest('AKEO2S4BMH', C, NOW).suggestion, 'AKE02548MH');
  assert.equal(suggest('AKE1234AI', C, NOW), null, 'I in an alphabetic position is left alone');
  assert.equal(suggest('AKE12345O7', C, NOW), null, 'alphanumeric positions are never touched');
  assert.equal(suggest('4KE12345MH', C, NOW), null, 'no rule, no suggestion');
  const a = assess('AKE1234A1', C, NOW);
  assert.equal(a.raw.value, 'AKE1234A1', 'raw value is preserved');
  assert.equal(a.raw.status, 'INVALID');
});

test('correction rules are configurable', () => {
  const cfg = structuredClone(C);
  cfg.correctionRules = cfg.correctionRules.filter((r) => r.source_character !== '1');
  assert.equal(suggest('AKE1234A1', cfg, NOW), null);
  cfg.correctionRules.push({ source_character: 'Z', suggested_character: '2', context: 'N', active: true });
  assert.equal(suggest('AKE1Z345MH', cfg, NOW).suggestion, 'AKE12345MH');
});

test('duplicates: OCR variations are the same ULD, distinct valid ULDs are not', () => {
  assert.equal(canonical('AKE1234AI', C), canonical('AKE1234A1', C));
  const existing = [{ value: 'AKE1234AI', valid: true }, { value: 'AKE1234588', valid: true }];
  assert.ok(findDuplicate({ value: 'AKE1234A1', valid: false }, existing, C));
  assert.ok(findDuplicate({ value: 'AKE1234AI', valid: true }, existing, C));
  assert.equal(findDuplicate({ value: 'AKE12345B8', valid: true }, existing, C), null);
  assert.equal(findDuplicate({ value: 'AKE1235AI', valid: true }, existing, C), null);
});

const line = (text, conf = 95) => ({
  chars: [...text].map((ch, i) => ({ ch, conf, bbox: { x0: i * 10, y0: 0, x1: i * 10 + 8, y1: 12 } })),
});

test('candidate extraction: spaced stencil text, noise and several ULDs', () => {
  const c = extractCandidates([line('A K E 7 9 2 1 0 R 7')], C, NOW);
  assert.equal(c.length, 1);
  assert.equal(c[0].raw, 'AKE79210R7');
  assert.equal(extractCandidates([line('1AKE12345MH'), line('MAX GROSS 1588 KG')], C, NOW).map((x) => x.raw).join(), 'AKE12345MH');
  assert.equal(extractCandidates([line('AKE1234AI2')], C, NOW)[0].raw, 'AKE1234AI');
  const two = extractCandidates([line('AKE1234AI'), line('AAY56789MH')], C, NOW);
  assert.deepEqual(two.map((x) => x.raw), ['AKE1234AI', 'AAY56789MH']);
  assert.equal(extractCandidates([line('TELEPORT CARGO'), line('NET 1500KG')], C, NOW).length, 0);
  const s = extractCandidates([line('AKE1234A1')], C, NOW)[0];
  assert.equal(s.raw, 'AKE1234A1');
  assert.equal(s.assess.suggestion.suggestion, 'AKE1234AI');
  const partial = extractCandidates([line('AKE12X4')], C, NOW)[0];
  assert.equal(partial.status, 'INVALID');
  assert.ok(partial.partial);
});

const obs = (raw, conf = 80, x = 0) => {
  const c = extractCandidates([line(raw, conf)], C, NOW)[0];
  c.bbox = { x0: x, y0: 0, x1: x + 100, y1: 20 };
  return c;
};

test('tracker: OCR variations of one ULD form a single track and emit once', () => {
  const t = new Tracker(() => C);
  let out = t.update([obs('AKE1234AI')], 0);
  assert.equal(out.results.length, 0, 'one medium-confidence frame is not enough');
  out = t.update([obs('AKE1234A1')], 200);
  assert.equal(out.results.length, 1, 'second consistent frame triggers the result');
  assert.equal(out.results[0].obs.raw, 'AKE1234AI', 'the valid reading wins over the variant');
  assert.equal(out.results[0].disagreement, true);
  out = t.update([obs('AKE1234AI')], 400);
  out = t.update([obs('AKE1234AI')], 600);
  assert.equal(out.results.length, 0, 'no second emission for the same physical ULD');
  assert.equal(t.tracks.length, 1);
});

test('tracker: high-confidence valid read emits on the first frame', () => {
  const t = new Tracker(() => C);
  assert.equal(t.update([obs('AKE12345MH', 96)], 0).results.length, 1);
});

test('tracker: a different ULD starts a new track; expired tracks are dropped', () => {
  const t = new Tracker(() => C);
  t.update([obs('AKE12345MH', 96)], 0);
  const out = t.update([obs('AAY56789MH', 96)], 300);
  assert.equal(out.results.length, 1);
  assert.equal(t.tracks.length, 2);
  t.update([], 5000);
  assert.equal(t.tracks.length, 0);
});

test('tracker: unreadable text only surfaces after persisting, never over a readable one', () => {
  const t = new Tracker(() => C);
  assert.equal(t.update([obs('AKE12X4')], 0).results.length, 0);
  assert.equal(t.update([obs('AKE12X4')], 200).results.length, 0);
  const out = t.update([obs('AKE12X4')], 400);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].status, 'INVALID');
});
