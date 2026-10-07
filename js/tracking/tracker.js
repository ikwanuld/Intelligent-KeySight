// Dynamic tracking. Groups successive OCR observations that belong to the
// same physical ULD (by text similarity and by where the text sits in the
// frame) and decides when a track is reliable enough to show to staff.
//
// There is deliberately no "same ULD for N seconds" rule: a track lives for
// as long as the text keeps being seen, and repeat sightings after it has
// left the frame are handled by session-level duplicate matching.

import { canonical, editDistance } from '../duplicate/duplicate.js';
import { STATUS_RANK } from '../validation/validator.js';

function iou(a, b) {
  if (!a || !b) return 0;
  const x0 = Math.max(a.x0, b.x0), y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1), y1 = Math.min(a.y1, b.y1);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const ua = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return ua > 0 ? inter / ua : 0;
}

let nextId = 1;

export class Tracker {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.tracks = [];
  }

  reset() { this.tracks = []; }

  _match(obs, key) {
    let best = null, bestScore = Infinity;
    for (const t of this.tracks) {
      let d = Infinity;
      for (const k of t.groups.keys()) d = Math.min(d, editDistance(key, k));
      const overlap = iou(obs.bbox, t.bbox);
      const ok = d <= 2 || (overlap > 0.3 && d <= 4);
      if (!ok) continue;
      const score = d - overlap; // prefer closest text, then best overlap
      if (score < bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  /**
   * @param {object[]} observations candidates from one OCR pass
   * @returns {{results:object[], live:object[]}} `results` are tracks that
   *   became reliable on this pass; `live` is every track currently in view.
   */
  update(observations, now = Date.now()) {
    const cfg = this.getConfig();
    const tk = cfg.tracking;
    this.tracks = this.tracks.filter((t) => now - t.lastSeen <= tk.trackTtlMs);
    const results = [];

    for (const obs of observations) {
      const key = canonical(obs.raw, cfg);
      let t = this._match(obs, key);
      if (!t) {
        t = { id: nextId++, firstSeen: now, lastSeen: now, bbox: obs.bbox, groups: new Map(),
          frames: 0, emitted: null, rawSeen: new Set() };
        this.tracks.push(t);
      }
      t.lastSeen = now; t.bbox = obs.bbox || t.bbox; t.frames++; t.rawSeen.add(obs.raw);
      t.lastObs = obs;

      let g = t.groups.get(key);
      if (!g) { g = { votes: 0, members: new Map() }; t.groups.set(key, g); }
      g.votes++;
      let m = g.members.get(obs.raw);
      if (!m) { m = { votes: 0, confSum: 0, obs }; g.members.set(obs.raw, m); }
      m.votes++; m.confSum += obs.conf;
      if (obs.conf >= m.obs.conf) m.obs = obs;

      if (!t.emitted) {
        const pick = this._decide(t, cfg);
        if (pick) { t.emitted = pick; results.push({ track: t, ...pick }); }
      }
    }
    return { results, live: this.tracks.filter((t) => now - t.lastSeen < 700) };
  }

  _decide(t, cfg) {
    const tk = cfg.tracking;
    let best = null, bestRank = -1, anyReadable = false;

    for (const g of t.groups.values()) {
      // Strongest member of the group: valid beats suggested beats invalid,
      // then most votes, then confidence.
      let top = null, topRank = -1;
      for (const m of g.members.values()) {
        const o = m.obs;
        const r = STATUS_RANK[o.status] * 1000 + (o.assess.suggestion ? 0 : 500) + m.votes * 10 + m.confSum / m.votes / 100;
        if (r > topRank) { topRank = r; top = m; }
      }
      const o = top.obs;
      const avgConf = top.confSum / top.votes;
      if (o.status !== 'INVALID') anyReadable = true;

      const fast = tk.singleFrameIfHigh && o.status === 'VALID' && !o.assess.suggestion &&
        avgConf >= cfg.thresholds.high;
      const steady = g.votes >= tk.minFrames;
      const ready = o.status === 'INVALID' ? g.votes >= tk.invalidMinFrames : (fast || steady);
      if (!ready) continue;

      const rank = STATUS_RANK[o.status] * 1000 + g.votes;
      if (rank > bestRank) {
        bestRank = rank;
        best = { obs: o, conf: avgConf, frames: g.votes, status: o.status };
      }
    }
    if (!best) return null;
    // Never surface an unreadable result while a readable one is forming.
    if (best.status === 'INVALID' && anyReadable) return null;
    const variants = [];
    for (const g of t.groups.values()) {
      for (const [raw, m] of g.members) variants.push({ raw_text: raw, frames: m.votes, overall_confidence: Math.round(m.confSum / m.votes), character_confidence: m.obs.charConf });
    }
    return { ...best, disagreement: t.rawSeen.size > 1, firstSeen: t.firstSeen, variants };
  }
}
