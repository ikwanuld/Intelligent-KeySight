// Pallet ID parsing: turns the characters read from one text line into ULD
// candidates.
//
// A pallet plate is three groups, "PAG 70229 R7": type code, serial number,
// owner code. What the recogniser hands us is messier than that:
//   - spaces between the groups are sometimes there and sometimes not
//   - rivets through the plate read as "O" or "0"
//   - scratches read as punctuation (arrives here as a junk marker)
//   - a faint group may be missing, or extra text may follow
// So instead of pattern-matching the string, every way of laying the three
// groups over the characters is tried against the configured validation
// rules, and the layouts are ranked. Nothing is corrected silently: a layout
// that needs a character changed is returned with `raw` (as read) and `fixed`
// (the suggestion) kept apart.

import { activeRules } from '../validation/validator.js';
import { JUNK } from '../paddle/ctc.js';

// What a rivet can look like to the recogniser.
export const RIVET_LIKE = new Set(['O', '0', 'Q', 'D']);
// At the two ENDS of the plate a rivet has no neighbours to be compared with
// and comes out as any round shape. (Not used between the groups: there a
// stray 6, 8 or 9 is more likely a real digit.)
const END_RIVET = new Set([...RIVET_LIKE, 'C', 'G', 'U', '6', '8', '9']);

// A type or owner code is only "corrected" towards a known one when the
// recogniser itself hesitated between the two characters at least this much.
const ALT_MIN = 0.08;

const isDigit = (c) => c >= '0' && c <= '9';

/** Everything the parser needs from the admin-configurable rules. */
export function buildGrammar(config, at = Date.now()) {
  const shapes = activeRules(config, at).map((r) => ({
    rule_id: r.rule_id,
    serial: r.serial_length, serialType: r.serial_type || 'N',
    owner: r.code_length, ownerType: r.code_type || 'AN',
    only: r.prefixes && r.prefixes !== '*' ? new Set(r.prefixes) : null,
    allowed: r.allowed_codes && r.allowed_codes.length ? new Set(r.allowed_codes) : null,
    excluded: new Set(r.excluded_codes || []),
  }));
  const numFix = new Map(), alphaFix = new Map();
  for (const c of config.correctionRules || []) {
    if (!c.active) continue;
    (c.context === 'N' ? numFix : alphaFix).set(c.source_character, c.suggested_character);
  }
  return {
    prefixes: new Map((config.prefixes || []).filter((p) => p.active).map((p) => [p.prefix, p])),
    shapes, numFix, alphaFix,
    known: new Set(config.operatorCodes || []),
    serialLengths: [...new Set(shapes.map((s) => s.serial))].sort((a, b) => a - b),
  };
}

function hamming(a, b) { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; }

/** Alphanumeric characters of the line, each flagged if a separator precedes it. */
function sequence(chars) {
  const seq = [];
  let sep = true;                          // start of line counts as a separator
  for (const c of chars) {
    if (c.ch === ' ' || c.ch === JUNK) { sep = true; continue; }
    seq.push({ ch: c.ch, conf: c.conf, x: c.x, alts: c.alts || [], sep });
    sep = false;
  }
  return seq;
}

/**
 * A code that is not in the known list but one character away from codes
 * that are. Returns the known code to suggest (`pick`), or null.
 *  - exactly one neighbour and `lone` allowed: that one
 *  - otherwise: the neighbour whose differing character the recogniser also
 *    considered, when one clearly stands out
 */
function nearestKnown(read, cells, vocabulary, lone) {
  const near = [...vocabulary].filter((k) => k.length === read.length && hamming(k, read) === 1);
  if (!near.length) return { near, pick: null };
  const scored = near.map((k) => {
    const at = [...k].findIndex((c, i) => c !== read[i]);
    const alt = cells[at].alts.find((a) => a[0] === k[at]);
    return { code: k, at, p: alt ? alt[1] : 0 };
  }).sort((a, b) => b.p - a.p);
  if (near.length === 1 && lone) return { near, pick: scored[0] };
  const [first, second] = scored;
  if (first.p >= ALT_MIN && (!second || first.p >= 3 * second.p)) return { near, pick: first };
  return { near, pick: null };
}

/**
 * @param chars [{ch, conf, x, alts}] from the recogniser, in reading order
 * @returns ranked layouts: [{raw, fixed, exact, fixes, skips, knownOwner,
 *   unknownPrefix, nearPrefixes, conf, minConf, charConf, x0, x1, score, rule_id}]
 */
export function parseLine(chars, g) {
  const seq = sequence(chars);
  const n = seq.length;
  const found = new Map();

  for (let i = 0; i + 3 <= n; i++) {
    if (seq[i + 1].sep || seq[i + 2].sep) continue;           // separator inside the type code
    const rawPrefix = seq[i].ch + seq[i + 1].ch + seq[i + 2].ch;

    // Characters stuck to the front of the type code must be rivets.
    let headSkips = 0, headOk = true;
    for (let k = i; k > 0 && !seq[k].sep; k--) {
      if (END_RIVET.has(seq[k - 1].ch) && headSkips < 2) headSkips++; else { headOk = false; break; }
    }
    if (!headOk) continue;

    const options = [];
    if (g.prefixes.has(rawPrefix)) {
      options.push({ prefix: rawPrefix, fixes: [] });
    } else {
      // One character away from a known type code -> suggest it.
      const { near, pick } = nearestKnown(rawPrefix, seq.slice(i, i + 3), g.prefixes.keys(), true);
      if (pick) options.push({ prefix: pick.code, fixes: [{ at: pick.at, from: rawPrefix[pick.at], to: pick.code[pick.at], kind: 'prefix' }] });
      if (/^[A-Z]{3}$/.test(rawPrefix)) options.push({ prefix: rawPrefix, fixes: [], unknownPrefix: true, near });
    }

    for (const opt of options) {
      for (const shape of g.shapes) {
        if (shape.only && !shape.only.has(opt.prefix)) continue;
        for (const skipA of [0, 1]) {                           // rivet between type code and serial
          let j = i + 3;
          if (skipA) { if (j >= n || !RIVET_LIKE.has(seq[j].ch)) continue; j++; }
          if (j + shape.serial > n) continue;
          let ok = true, serialRaw = '', serialFixed = '';
          const serialFixes = [];
          for (let k = 0; k < shape.serial && ok; k++) {
            const c = seq[j + k];
            if (k > 0 && c.sep) { ok = false; break; }
            serialRaw += c.ch;
            if (shape.serialType !== 'N' || isDigit(c.ch)) { serialFixed += c.ch; continue; }
            // Rivets sit in the gaps on either side of the serial. A round
            // shape there is far more likely a rivet than a misread zero, so
            // it is never turned into a digit: on a damaged plate that would
            // offer a wrong number that happens to have the right length.
            if (RIVET_LIKE.has(c.ch) && (k === 0 || k === shape.serial - 1)) { ok = false; break; }
            const f = g.numFix.get(c.ch);
            if (!f) { ok = false; break; }
            serialFixed += f; serialFixes.push({ at: 3 + k, from: c.ch, to: f, kind: 'serial' });
          }
          if (!ok) continue;

          for (const skipB of [0, 1]) {                         // rivet between serial and owner
            let m = j + shape.serial;
            if (skipB) { if (m >= n || !RIVET_LIKE.has(seq[m].ch)) continue; m++; }
            if (m + shape.owner > n) continue;
            let ownerRaw = '', ok2 = true;
            for (let k = 0; k < shape.owner; k++) {
              const c = seq[m + k];
              if (k > 0 && c.sep) { ok2 = false; break; }
              ownerRaw += c.ch;
            }
            if (!ok2) continue;

            // Characters stuck to the end of the owner code must be rivets too.
            let t = m + shape.owner, tailSkips = 0, tailOk = true;
            while (t < n && !seq[t].sep) {
              if (END_RIVET.has(seq[t].ch) && tailSkips < 2) { tailSkips++; t++; } else { tailOk = false; break; }
            }
            if (!tailOk) continue;

            // The owner code as read, plus (when it is not a known code) the
            // known code the recogniser nearly read instead.
            const owners = [{ owner: ownerRaw, fixes: [] }];
            const listed = shape.allowed || (g.known.size ? g.known : null);
            if (listed && !listed.has(ownerRaw)) {
              const { pick } = nearestKnown(ownerRaw, seq.slice(m, m + shape.owner), listed, false);
              if (pick) owners.push({ owner: pick.code, fixes: [{ at: 3 + shape.serial + pick.at, from: ownerRaw[pick.at], to: pick.code[pick.at], kind: 'owner' }] });
            }

            for (const ow of owners) {
              const owner = ow.owner;
              if (shape.ownerType === 'A' && !/^[A-Z]+$/.test(owner)) continue;
              if (shape.ownerType === 'N' && !/^[0-9]+$/.test(owner)) continue;
              if (shape.ownerType === 'AN' && !/[A-Z]/.test(owner)) continue;   // owner codes always carry a letter
              if (shape.allowed && !shape.allowed.has(owner)) continue;
              if (shape.excluded.has(owner)) continue;

              const fixes = [...opt.fixes, ...serialFixes, ...ow.fixes];
              const knownOwner = shape.allowed ? true : (g.known.size ? g.known.has(owner) : true);
              // Each of these is a reason to doubt the layout; two together is
              // guesswork, and guesses are not offered.
              const doubt = fixes.length + (opt.unknownPrefix ? 1 : 0) + (knownOwner ? 0 : 1);
              if (doubt > 1) continue;

              const used = [seq[i], seq[i + 1], seq[i + 2],
                ...seq.slice(j, j + shape.serial), ...seq.slice(m, m + shape.owner)];
              const confs = used.map((c) => c.conf);
              const conf = confs.reduce((a, b) => a + b, 0) / confs.length;
              const skips = skipA + skipB + headSkips + tailSkips;
              const seps = (skipA || seq[j].sep ? 1 : 0) + (skipB || seq[m].sep ? 1 : 0);
              // An unknown code costs more than a suggested change towards a
              // known one: when both layouts exist, the suggestion is shown.
              const score = 100 - 30 * fixes.length - 12 * skips - (knownOwner ? 0 : 35) - (opt.unknownPrefix ? 40 : 0)
                + 4 * seps + 10 * conf + 0.1 * used.length;
              const p = {
                raw: rawPrefix + serialRaw + ownerRaw, fixed: opt.prefix + serialFixed + owner,
                exact: fixes.length === 0, fixes, skips, knownOwner, unknownPrefix: !!opt.unknownPrefix,
                nearPrefixes: opt.unknownPrefix ? opt.near : [],
                conf, minConf: Math.min(...confs), charConf: confs.map((c) => Math.round(c * 100)),
                // How strongly the recogniser also considered ANOTHER character
                // somewhere in the number (0 = never hesitated between two).
                rival: Math.max(0, ...used.map((c) => (c.alts[0] ? c.alts[0][1] : 0))),
                x0: seq[i].x, x1: seq[m + shape.owner - 1].x, score, rule_id: shape.rule_id,
              };
              const key = `${p.raw}>${p.fixed}`;
              if (!found.has(key) || found.get(key).score < score) found.set(key, p);
            }
          }
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => b.score - a.score);
}

/**
 * Parse a line and, when no complete ID is found, say what is missing so the
 * reader can look again in the right place.
 * @returns {{parses:object[], hint:null|'extend-right'|'extend-left'|'extend-both', partial:null|{raw,conf}}}
 */
export function analyseLine(chars, g) {
  const parses = parseLine(chars, g);
  if (parses.length && parses[0].exact) return { parses, hint: null, partial: null };

  const seq = sequence(chars);
  const s = seq.map((c) => c.ch).join('');
  const minS = g.serialLengths[0] ?? 4, maxS = g.serialLengths[g.serialLengths.length - 1] ?? 5;
  let hint = null, partial = null;

  // Known type code, then (most of) a serial, then the line ends: owner code is missing.
  for (let i = 0; i + 3 <= s.length; i++) {
    if (!g.prefixes.has(s.substr(i, 3))) continue;
    const rest = s.slice(i + 3).replace(/^[OQD]/, '');
    const digits = (rest.match(/^[0-9OISBGZ]*/) || [''])[0].length;
    if (digits >= minS - 1 && rest.length - digits <= 1) hint = 'extend-right';
    const run = seq.slice(i, i + 3 + maxS + 3);
    if (run.length >= 3 + minS - 1) {
      partial = { raw: run.map((c) => c.ch).join(''), conf: run.reduce((a, c) => a + c.conf, 0) / run.length };
    }
    break;
  }
  // Serial + known owner code at the end with no type code before them.
  if (!hint && !partial) {
    const m = s.match(new RegExp(`^[OQD0]?([0-9]{${minS},${maxS}})([A-Z0-9]{2,3})[O0]?$`));
    if (m && (g.known.has(m[2]) || g.shapes.some((sh) => sh.allowed && sh.allowed.has(m[2])))) hint = 'extend-left';
  }
  // Nothing but a serial: the groups on both sides may be too faint to detect.
  if (!hint && !partial && new RegExp(`^[OQD]?[0-9]{${minS},${maxS}}[OQD]?$`).test(s)) hint = 'extend-both';
  return { parses, hint, partial };
}
