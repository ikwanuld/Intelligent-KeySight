// Turns raw OCR lines into ULD candidates. OCR text is never trusted as-is:
// every window of characters is run through the validation engine, and only
// ULD-shaped text leaves this module.

import { assess } from '../correction/corrector.js';
import { activeRules, ruleLength, lookupPrefix, STATUS_RANK } from '../validation/validator.js';

const isAlnum = (c) => /^[A-Z0-9]$/.test(c);

function union(boxes) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const k of boxes) {
    if (!k) continue;
    b.x0 = Math.min(b.x0, k.x0); b.y0 = Math.min(b.y0, k.y0);
    b.x1 = Math.max(b.x1, k.x1); b.y1 = Math.max(b.y1, k.y1);
  }
  return Number.isFinite(b.x0) ? b : null;
}

function build(chars, a) {
  const confs = chars.map((c) => c.conf ?? 0);
  const mean = confs.reduce((s, v) => s + v, 0) / (confs.length || 1);
  return {
    raw: a.raw.value,
    assess: a,
    status: a.best.status,                 // strongest reading (raw or suggested)
    conf: mean,
    minConf: confs.length ? Math.min(...confs) : 0,
    charConf: confs.map((v) => Math.round(v)),
    bbox: union(chars.map((c) => c.bbox)),
    charBoxes: chars.map((c) => c.bbox),
  };
}

/**
 * @param {{chars:{ch:string,conf:number,bbox:object}[]}[]} lines
 * @returns candidates, at most one per physical text run
 */
export function extractCandidates(lines, config, at = Date.now()) {
  const lengths = [...new Set(activeRules(config, at).map(ruleLength))].sort((a, b) => b - a);
  if (!lengths.length) return [];
  const minLen = lengths[lengths.length - 1], maxLen = lengths[0];
  const out = [];

  for (const line of lines) {
    const chars = (line.chars || [])
      .map((c) => ({ ...c, ch: String(c.ch || '').toUpperCase() }))
      .filter((c) => isAlnum(c.ch));
    const s = chars.map((c) => c.ch).join('');
    let found = false;

    for (let i = 0; i + minLen <= s.length;) {
      let hit = null, hitRank = -1;
      for (const L of lengths) {
        if (i + L > s.length) continue;
        const a = assess(s.substr(i, L), config, at);
        if (a.best.status === 'INVALID') continue;
        const known = !!lookupPrefix(config, a.best.parts.prefix);
        const wholeLine = i === 0 && L === s.length;
        // Unknown prefixes are only accepted when the text is exactly one
        // clean ULD-shaped token; this keeps random signage out of the queue.
        if (!known && !(wholeLine && !a.suggestion)) continue;
        const rank = STATUS_RANK[a.best.status] * 10 + (a.suggestion ? 0 : 1) + L / 100;
        if (rank > hitRank) { hitRank = rank; hit = build(chars.slice(i, i + L), a); }
      }
      if (hit) { out.push(hit); found = true; i += hit.raw.length; } else { i++; }
    }

    // ULD-like but unreadable: starts with a known prefix yet fits no rule.
    // Reported as INVALID so the tracker can surface it for manual editing
    // if it stays unreadable for several frames.
    if (!found && s.length >= minLen - 2) {
      for (let j = 0; j + 3 <= s.length; j++) {
        if (!lookupPrefix(config, s.substr(j, 3))) continue;
        const rest = s.length - j;
        if (rest < minLen - 2) break;
        const slice = chars.slice(j, j + maxLen);
        const cand = build(slice, assess(slice.map((c) => c.ch).join(''), config, at));
        cand.partial = true;
        out.push(cand);
        break;
      }
    }
  }
  return out;
}
