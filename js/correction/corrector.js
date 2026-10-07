// Context-aware OCR correction. Produces SUGGESTIONS only: nothing in here
// ever changes a stored value. The caller shows "Keep original / Accept
// suggestion" and records the choice.

import { validate, activeRules, ruleLength, positionTypes, fitsType, normalize, STATUS_RANK } from '../validation/validator.js';

function ruleMap(config) {
  const m = new Map(); // `${char}|${context}` -> suggested char
  for (const r of config.correctionRules || []) {
    if (r.active) m.set(`${r.source_character}|${r.context}`, r.suggested_character);
  }
  return m;
}

/**
 * @returns {null | {suggestion:string, changes:{pos:number,from:string,to:string}[], validation:object}}
 */
export function suggest(text, config, at = Date.now()) {
  const value = normalize(text);
  if (!value) return null;
  const original = validate(value, config, at);
  if (original.status === 'VALID') return null;

  const map = ruleMap(config);
  let best = null;
  for (const rule of activeRules(config, at)) {
    if (ruleLength(rule) !== value.length) continue;
    const types = positionTypes(rule);
    const chars = [...value];
    const changes = [];
    for (let i = 0; i < chars.length; i++) {
      const t = types[i];
      if (t === 'AN' || fitsType(chars[i], t)) continue; // position already plausible
      const to = map.get(`${chars[i]}|${t}`);
      if (to) { changes.push({ pos: i, from: chars[i], to }); chars[i] = to; }
    }
    if (!changes.length) continue;
    const candidate = chars.join('');
    const v = validate(candidate, config, at);
    if (STATUS_RANK[v.status] <= STATUS_RANK[original.status]) continue; // not an improvement
    if (!best || STATUS_RANK[v.status] > STATUS_RANK[best.validation.status] ||
        (STATUS_RANK[v.status] === STATUS_RANK[best.validation.status] && changes.length < best.changes.length)) {
      best = { suggestion: candidate, changes, validation: v };
    }
  }
  return best;
}

/**
 * Validate a raw string and attach a suggestion when one exists.
 * `best` is the stronger of the two readings, used for ranking and for
 * deciding whether a detection is worth showing at all. It is NOT stored as
 * the value unless staff accept it.
 */
export function assess(text, config, at = Date.now()) {
  const raw = validate(text, config, at);
  const s = suggest(text, config, at);
  return { raw, suggestion: s, best: s ? s.validation : raw };
}
