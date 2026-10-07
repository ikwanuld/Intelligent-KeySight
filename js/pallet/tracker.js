// Tracking for pallet plates.
//
// The container tracker follows ONE number and groups readings by how alike
// their text is. That does not work for pallets: a stack shows several plates
// at once, and neighbouring serials are often one or two digits apart
// ("PMC 26596 R9" above "PMC 29725 R9"), so "similar text" would merge two
// different pallets into one and silently lose the second.
//
// Here a plate is followed by WHERE it is instead:
//   - two readings in the same frame are always two different plates
//   - a reading belongs to an existing plate if it says exactly the same
//     thing, or if it sits in the same place
//   - a different, valid number turning up where a plate was already
//     reported is treated as a new plate (the camera moved up the stack), but
//     it has to be read twice before it is believed
// Results have the same shape as the container tracker's, so everything
// after this point (duplicates, queue, storage) is shared.

import { canonical } from '../duplicate/duplicate.js';
import { STATUS_RANK } from '../validation/validator.js';

function iou(a, b) {
  if (!a || !b) return 0;
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter);
}

const SAME_PLACE = 0.3;
let nextId = 1;

export class PlateTracker {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.tracks = [];
    // A plate must survive from one pass to the next to be read twice. On a
    // slow phone a pass can take longer than the configured track lifetime,
    // so the pipeline raises the lifetime to a few passes here.
    this.minTtlMs = 0;
    // When the camera last moved. Where a plate WAS says nothing about what
    // is there now once the picture has shifted, so positions older than
    // this are not used to match readings to plates.
    this.movedAt = -1;
  }

  reset() { this.tracks = []; }

  /** A plate was seen (its text line was detected) without being read again. */
  touch(id, bounds, now = Date.now()) {
    const t = this.tracks.find((x) => x.id === id);
    if (!t) return;
    t.lastSeen = now;
    if (bounds) { t.bbox = bounds; t.quad = null; }
  }

  /**
   * @param {object[]} observations candidates from ONE frame
   * @returns {{results:object[], live:object[]}} `results` are plates that
   *   became reliable on this frame; `live` is every plate currently in view.
   */
  update(observations, now = Date.now()) {
    const cfg = this.getConfig();
    const tk = cfg.tracking;
    const ttl = Math.max(tk.trackTtlMs, this.minTtlMs);
    this.tracks = this.tracks.filter((t) => now - t.lastSeen <= ttl);
    const results = [];

    // Pair readings with known plates, best matches first; each plate takes
    // at most one reading per frame and each reading at most one plate.
    // A reading that comes with a suggestion ("PMS…, did you mean PMC…?")
    // is a reading of the suggested number, so it is filed under that.
    const keys = observations.map((o) => canonical(o.assess.suggestion ? o.assess.suggestion.suggestion : o.raw, cfg));
    const pairs = [];
    observations.forEach((obs, i) => {
      const readable = obs.status !== 'INVALID';
      for (const t of this.tracks) {
        const same = t.groups.has(keys[i]);
        const place = t.lastSeen > this.movedAt ? iou(obs.bbox, t.bbox) : 0;
        if (same) pairs.push({ i, t, cost: -1 - place });
        // Same place, different text: another reading of the same plate,
        // unless that plate has already been reported and this is a proper
        // number of its own.
        else if (place >= SAME_PLACE && !(t.emitted && readable)) pairs.push({ i, t, cost: 1 - place });
      }
    });
    pairs.sort((a, b) => a.cost - b.cost);
    const trackOf = new Map(), taken = new Set();
    for (const p of pairs) {
      if (trackOf.has(p.i) || taken.has(p.t)) continue;
      trackOf.set(p.i, p.t); taken.add(p.t);
    }

    observations.forEach((obs, i) => {
      const key = keys[i];
      let t = trackOf.get(i);
      if (!t) {
        // New plate. If it sits where a settled plate was, it must prove
        // itself: it could also be that plate misread for one frame.
        const suspect = this.tracks.some((x) => x.emitted && x.lastSeen > this.movedAt && iou(obs.bbox, x.bbox) >= SAME_PLACE);
        t = { id: nextId++, firstSeen: now, lastSeen: now, bbox: obs.bbox, groups: new Map(), frames: 0, emitted: null, rawSeen: new Set(), suspect };
        this.tracks.push(t);
      }
      t.lastSeen = now; t.lastRead = now; t.bbox = obs.bbox || t.bbox; t.quad = obs.quad || null;
      t.lineBounds = obs.lineBounds || obs.bbox;
      t.frames++; t.rawSeen.add(obs.raw); t.lastObs = obs;

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
    });
    return { results, live: this.tracks.filter((t) => now - t.lastSeen < 700) };
  }

  /** Strongest reading of each group, and whether any of them may be shown yet. */
  _decide(t, cfg) {
    const tk = cfg.tracking;
    const tops = [];
    for (const g of t.groups.values()) {
      // Valid beats suggested beats invalid, then most votes, then confidence.
      let top = null, topRank = -1;
      for (const m of g.members.values()) {
        const o = m.obs;
        const r = STATUS_RANK[o.status] * 1000 + (o.assess.suggestion ? 0 : 500) + m.votes * 10 + m.confSum / m.votes / 100;
        if (r > topRank) { topRank = r; top = m; }
      }
      tops.push({ g, top, o: top.obs });
    }
    const readable = tops.filter((x) => x.o.status !== 'INVALID');

    let best = null, bestRank = -1;
    for (const x of readable) {
      // One frame is enough only for a reading with no weak character at all.
      const fast = tk.singleFrameIfHigh && x.o.solid && !t.suspect;
      if (!fast && x.g.votes < Math.max(2, tk.minFrames)) continue;
      const rank = STATUS_RANK[x.o.status] * 1000 + x.g.votes;
      if (rank > bestRank) { bestRank = rank; best = x; }
    }
    // Unreadable: only when the plate stayed unreadable frame after frame.
    // (The text of a bad reading changes every time, so frames are counted
    // per plate, not per text. One frame fewer than for containers: every
    // pass here has already tried the line both ways up and twice over.)
    if (!best && !readable.length && t.frames >= Math.max(2, tk.invalidMinFrames - 1)) {
      best = tops.sort((a, b) => b.g.votes - a.g.votes || b.o.conf - a.o.conf)[0];
    }
    if (!best) return null;

    const variants = [];
    for (const g of t.groups.values()) {
      for (const [raw, m] of g.members) variants.push({ raw_text: raw, frames: m.votes, overall_confidence: Math.round(m.confSum / m.votes), character_confidence: m.obs.charConf });
    }
    return {
      obs: best.o, conf: best.top.confSum / best.top.votes, frames: best.g.votes, status: best.o.status,
      disagreement: t.rawSeen.size > 1,
      // The same plate was also read as another proper number: staff must look.
      conflict: readable.length > 1,
      firstSeen: t.firstSeen, variants,
    };
  }
}
