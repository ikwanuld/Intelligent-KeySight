// Duplicate detection: normalised matching that treats common OCR confusions
// (O/0, I/1, …) as the same character, so "AKE1234AI" and "AKE1234A1" are
// recognised as one physical ULD.

import { normalize } from '../validation/validator.js';

const cache = new WeakMap();

/** Map every character to a representative of its confusion class. */
function classMap(config) {
  if (cache.has(config)) return cache.get(config);
  const parent = new Map();
  const find = (c) => { while (parent.has(c) && parent.get(c) !== c) c = parent.get(c); return c; };
  for (const r of config.correctionRules || []) {
    if (!r.active) continue;
    const a = find(r.source_character), b = find(r.suggested_character);
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    if (a !== b) { const [lo, hi] = a < b ? [a, b] : [b, a]; parent.set(hi, lo); }
  }
  const map = { find };
  cache.set(config, map);
  return map;
}

/** Canonical key used for duplicate matching and track association. */
export function canonical(text, config) {
  const m = classMap(config);
  return [...normalize(text)].map((c) => m.find(c)).join('');
}

/**
 * Is `value` the same ULD as an existing record?
 * Exact matches always are. Canonical-only matches are treated as OCR
 * variations unless BOTH readings are independently valid ULD numbers, in
 * which case they are kept apart (e.g. operator codes "B8" vs "88").
 * @param {{value:string, valid:boolean}} incoming
 * @param {{value:string, valid:boolean}[]} existing
 */
export function findDuplicate(incoming, existing, config) {
  const v = normalize(incoming.value);
  const key = canonical(v, config);
  for (const e of existing) {
    const ev = normalize(e.value);
    if (ev === v) return e;
    if (canonical(ev, config) === key && !(incoming.valid && e.valid)) return e;
  }
  return null;
}

export function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
