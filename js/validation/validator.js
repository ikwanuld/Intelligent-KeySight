// ULD validation engine. Pure functions over the configuration object, so the
// same code can be unit-tested in Node and mirrored server-side.

export const STATUS = { VALID: 'VALID', NEEDS_REVIEW: 'NEEDS_REVIEW', INVALID: 'INVALID' };
export const STATUS_RANK = { VALID: 2, NEEDS_REVIEW: 1, INVALID: 0 };

const isLetter = (c) => c >= 'A' && c <= 'Z';
const isDigit = (c) => c >= '0' && c <= '9';

export function fitsType(c, type) {
  if (type === 'A') return isLetter(c);
  if (type === 'N') return isDigit(c);
  return isLetter(c) || isDigit(c); // 'AN'
}

/** Uppercase and drop everything that is not A-Z / 0-9. */
export function normalize(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Rules in force at time `at`, one version per rule_id, by priority. */
export function activeRules(config, at = Date.now()) {
  const t = typeof at === 'number' ? at : new Date(at).getTime();
  const byId = new Map();
  for (const r of config.validationRules || []) {
    if (!r.active) continue;
    const from = r.effective_from ? new Date(r.effective_from).getTime() : -Infinity;
    const until = r.effective_until ? new Date(r.effective_until).getTime() : Infinity;
    if (t < from || t >= until) continue;
    const cur = byId.get(r.rule_id);
    // Newest effective_from wins; rule_version breaks ties.
    if (!cur || from > new Date(cur.effective_from || 0).getTime() ||
        (from === new Date(cur.effective_from || 0).getTime() && r.rule_version > cur.rule_version)) {
      byId.set(r.rule_id, r);
    }
  }
  return [...byId.values()].sort((a, b) => a.priority - b.priority);
}

export function ruleLength(rule) {
  return (rule.prefix_length || 3) + rule.serial_length + rule.code_length;
}

/** Expected character type ('A' | 'N' | 'AN') at each position for a rule. */
export function positionTypes(rule) {
  const types = [];
  const pl = rule.prefix_length || 3;
  for (let i = 0; i < pl; i++) types.push('A');
  for (let i = 0; i < rule.serial_length; i++) types.push(rule.serial_type || 'N');
  for (let i = 0; i < rule.code_length; i++) {
    const codes = rule.allowed_codes;
    if (codes && codes.length) {
      const allA = codes.every((c) => isLetter(c[i] || ''));
      const allN = codes.every((c) => isDigit(c[i] || ''));
      types.push(allA ? 'A' : allN ? 'N' : 'AN');
    } else {
      types.push(rule.code_type || 'AN');
    }
  }
  return types;
}

export function splitParts(text, rule) {
  const pl = rule.prefix_length || 3;
  return {
    prefix: text.slice(0, pl),
    serial: text.slice(pl, pl + rule.serial_length),
    code: text.slice(pl + rule.serial_length),
  };
}

function matchRule(text, rule) {
  if (text.length !== ruleLength(rule)) return false;
  const p = splitParts(text, rule);
  if (![...p.prefix].every(isLetter)) return false;
  if (rule.prefixes && rule.prefixes !== '*' && !rule.prefixes.includes(p.prefix)) return false;
  if (![...p.serial].every((c) => fitsType(c, rule.serial_type || 'N'))) return false;
  if (![...p.code].every((c) => fitsType(c, rule.code_type || 'AN'))) return false;
  if (rule.allowed_codes && rule.allowed_codes.length && !rule.allowed_codes.includes(p.code)) return false;
  if (rule.excluded_codes && rule.excluded_codes.includes(p.code)) return false;
  return true;
}

export function lookupPrefix(config, prefix) {
  return (config.prefixes || []).find((p) => p.active && p.prefix === prefix) || null;
}

function describeFailure(text, rules) {
  if (!text) return 'Nothing to validate';
  const lengths = [...new Set(rules.map(ruleLength))].sort((a, b) => a - b);
  if (!lengths.includes(text.length)) {
    return `Expected ${lengths.join(' or ')} characters, got ${text.length}`;
  }
  if (!/^[A-Z]{3}/.test(text)) return 'First 3 characters must be letters';
  const same = rules.filter((r) => ruleLength(r) === text.length);
  for (const r of same) {
    const p = splitParts(text, r);
    if (![...p.serial].every((c) => fitsType(c, r.serial_type || 'N'))) {
      return `Serial must be ${r.serial_length} digits`;
    }
    if (r.allowed_codes && r.allowed_codes.length && !r.allowed_codes.includes(p.code)) {
      return `${r.serial_length}-digit serials are only valid with ${r.allowed_codes.join(' / ')}`;
    }
    if (r.excluded_codes && r.excluded_codes.includes(p.code)) {
      return `${p.code} units use a different serial length`;
    }
  }
  return 'Does not match any ULD format';
}

/**
 * Validate one ULD number.
 * @returns {{value:string,status:string,reasons:string[],rule:object|null,
 *            parts:object|null,category:string|null,operational:boolean}}
 */
export function validate(text, config, at = Date.now()) {
  const value = normalize(text);
  const rules = activeRules(config, at);
  const rule = rules.find((r) => matchRule(value, r));
  if (!rule) {
    return { value, status: STATUS.INVALID, reasons: [describeFailure(value, rules)],
      rule: null, parts: null, category: null, operational: false };
  }
  const parts = splitParts(value, rule);
  const reasons = [];
  const pfx = lookupPrefix(config, parts.prefix);
  if (!pfx) reasons.push('Unknown ULD prefix');
  const codes = config.operatorCodes || [];
  const ruleHasCodes = rule.allowed_codes && rule.allowed_codes.length;
  if (!ruleHasCodes && codes.length && !codes.includes(parts.code)) {
    reasons.push('Unknown airline/operator code');
  }
  return {
    value,
    status: reasons.length ? STATUS.NEEDS_REVIEW : STATUS.VALID,
    reasons,
    rule: { rule_id: rule.rule_id, rule_version: rule.rule_version },
    parts,
    category: pfx ? pfx.category : 'OTHER',
    operational: !!(pfx && pfx.operational),
  };
}

/** Segment a (possibly invalid) value for display: prefix / serial / code. */
export function displayParts(text) {
  const v = normalize(text);
  if (v.length < 6) return [v];
  // Owner codes are two characters, or three letters on some pallets ("PAJ 0606 TRA").
  const m = v.match(/^([A-Z]{3})(\d{5})([A-Z])$/)          // one character short: show where it is missing
    || v.match(/^([A-Z]{3})(\d{4,5})([A-Z]{3}|[A-Z0-9]{2})$/);
  if (m) return [m[1], m[2], m[3]];
  return [v.slice(0, 3), v.slice(3, v.length - 2), v.slice(-2)];
}
