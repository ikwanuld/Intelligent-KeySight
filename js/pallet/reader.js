// Pallet ID reader: one image in, the ULD numbers visible in it out.
//
// This is the pallet OCR pipeline. It is deliberately separate from the
// container pipeline and more aggressive:
//   detect text in any orientation -> merge the pieces of each line ->
//   read it -> if that is not a clean ID, read it the other way up -> if a
//   group is missing, look further along the line -> unless the ID is rock
//   solid, read it once more with the contrast stretched -> parse every
//   reading against the validation rules -> keep the layout the readings
//   agree on, and say so when they do not agree.
// A stack of pallets shows several plates at once, so every line in the frame
// is handled independently.

import { boxBounds, boxCorners, cropBox } from '../paddle/image.js';
import { groupLines, extendBox } from './lines.js';
import { analyseLine, buildGrammar } from './parse.js';

const DEFAULTS = {
  detLimit: 736,        // longest side of the detector input
  maxLines: 8,          // lines read per frame, largest first
  minHeight: 12,        // px; smaller text is not legible enough to trust
  minAspect: 2.2,       // an ID line is much wider than tall
  cleanConf: 0.85,      // an ID read this confidently on average is not looked for the other way up
  solidConf: 0.9,       // ...and when its weakest character is at least this sure
  solidRival: 0.1,      //    and no character had a serious rival, it needs no second look
  doubtMinConf: 0.6,    // a layout with something odd about it (a character to change, an unknown
                        // type or owner code, a rivet in the way) is only offered when every
                        // character was read at least this surely
  enhanceDet: false,    // stretch contrast before detecting
  enhanceRec: false,    // stretch contrast of each line before reading
  secondLook: true,     // when a line is not a clean ID, read it once more with the contrast stretched
  evidenceWidth: 480,   // px, crop kept for review (0 = none)
};

export class PalletReader {
  constructor(engine, getConfig, options = {}) {
    this.engine = engine; this.getConfig = getConfig;
    this.opt = { ...DEFAULTS, ...options };
  }

  /**
   * @param img   {data, width, height} RGBA
   * @param skip  optional (bounds) => truthy to leave a line unread (the
   *              caller already knows what it says). bounds = {x0,y0,x1,y1}
   *              of the detected line, 0..1 of the frame.
   * @param options per-call overrides of the reader options
   * @returns readings: the ULD-like lines; other: bounds of lines that were
   *   read and are not ULD numbers; skipped: bounds of lines left unread
   */
  async readFrame(img, { skip, ...over } = {}) {
    const o = { ...this.opt, ...over }, e = this.engine;
    const grammar = buildGrammar(this.getConfig());
    e.stats.recMs = 0; e.stats.recCalls = 0;
    const { boxes, ms: detMs } = await e.detect(img, { limit: o.detLimit, enhance: o.enhanceDet });
    const lines = groupLines(boxes.filter((b) => b.h >= o.minHeight * 0.6))
      .filter((l) => l.h >= o.minHeight && l.w / l.h >= o.minAspect)
      .slice(0, o.maxLines);

    const readings = [], skipped = [], other = [];
    for (const line of lines) {
      const where = normBounds(line, img);
      if (skip?.(where, line)) { skipped.push(where); continue; }
      const r = await this.readLine(img, line, grammar, o);
      if (r) readings.push(describe(r, where, img, o));
      else other.push(where);
    }
    return { readings, lines, skipped, other, detMs, recMs: e.stats.recMs, recCalls: e.stats.recCalls };
  }

  /** Read one line; returns null when it is not a ULD number. */
  async readLine(img, line, grammar, o = this.opt) {
    const e = this.engine;
    const tries = [];
    const attempt = async (box, flip, how, enhance = o.enhanceRec) => {
      const rd = await e.read(img, box, { flip, enhance });
      const an = analyseLine(rd.chars, grammar);
      const t = { box, flip, how, text: rd.text, conf: rd.conf, ...an };
      if (o.debug) t.chars = rd.chars;
      tries.push(t);
      return t;
    };
    if (o.debug) (this.trace ||= []).push({ line, tries });
    const clean = (t) => { const p = t.parses[0]; return !!p && p.exact && !p.skips && !p.unknownPrefix && p.knownOwner && p.conf >= o.cleanConf; };
    const solid = (t) => clean(t) && t.parses[0].minConf >= o.solidConf && t.parses[0].rival < o.solidRival;
    // How ULD-like a reading is: a full ID, most of one, a fragment, nothing.
    const worth = (t) => (t.parses.length ? 3 : t.hint ? 2 : t.partial ? 1 : 0);

    // 1. As detected.
    let t = await attempt(line, false, 'direct');
    // 2. The other way up, unless the first reading is already a clean ID.
    //    Upside-down digits can read as confident nonsense, so confidence
    //    alone is no reason to skip this.
    if (!clean(t)) {
      const f = await attempt(line, true, 'flipped');
      if (worth(f) > worth(t) || (worth(f) === 3 && worth(t) === 3 && f.parses[0].score > t.parses[0].score)) t = f;
    }
    if (!worth(t)) return null;
    // 3. A group is missing: look further along the line, on the side it should be.
    if (!clean(t) && t.hint) {
      const grow = { 'extend-right': [0.3, 2.8], 'extend-left': [3.2, 0.3], 'extend-both': [3.2, 2.8] }[t.hint];
      const [l, r] = t.flip ? [grow[1], grow[0]] : grow;         // the box axis is mirrored when flipped
      const x = await attempt(extendBox(line, l, r), t.flip, 'extended');
      if (worth(x) >= worth(t)) t = x;
    }
    // 4. Anything short of a solid ID: one more look at the same place with
    //    the contrast stretched. A second reading that agrees is evidence;
    //    one that disagrees shows the number is not safe to offer as it stands.
    if (o.secondLook && !solid(t)) await attempt(t.box, t.flip, 'enhanced', !o.enhanceRec);

    // Pick the layout with the best evidence across all readings of this line.
    const byId = new Map();
    for (const tr of tries) {
      const voted = new Set();                  // one vote per reading, however many layouts spell the same number
      for (const p of tr.parses) {
        // Something odd about a shaky reading means a misread, not a find.
        if ((!p.exact || p.unknownPrefix || !p.knownOwner || p.skips) && p.minConf < o.doubtMinConf) continue;
        const cur = byId.get(p.fixed);
        if (!cur) byId.set(p.fixed, { best: p, tr, votes: 1 });
        else {
          if (!voted.has(p.fixed)) cur.votes++;
          if (p.score > cur.best.score) { cur.best = p; cur.tr = tr; }
        }
        voted.add(p.fixed);
      }
    }
    const ranked = [...byId.values()].sort((a, b) => (b.best.score + 6 * b.votes) - (a.best.score + 6 * a.votes));
    if (ranked.length) {
      const top = ranked[0], second = ranked[1];
      // Another, different number fits almost as well: say so instead of guessing.
      const ambiguous = !!second && second.best.exact === top.best.exact && top.best.score - second.best.score < 8;
      return { ...top.best, text: top.tr.text, box: top.tr.box, flip: top.tr.flip, how: top.tr.how, attempts: tries.length, ambiguous };
    }
    // ULD-like but unreadable: report it so staff can type the number.
    const withPartial = tries.filter((x) => x.partial).sort((a, b) => b.partial.conf - a.partial.conf)[0];
    if (withPartial) {
      return { partial: true, raw: withPartial.partial.raw, conf: withPartial.partial.conf, text: withPartial.text,
        box: withPartial.box, flip: withPartial.flip, how: withPartial.how, attempts: tries.length };
    }
    // Only a rejected guess: show what was actually read.
    const guess = tries.filter((x) => x.parses.length).sort((a, b) => b.parses[0].score - a.parses[0].score)[0];
    if (guess) {
      const p = guess.parses[0];
      return { partial: true, raw: p.raw, conf: p.conf, text: guess.text, box: guess.box, flip: guess.flip, how: guess.how, attempts: tries.length };
    }
    return null;
  }
}

function normBounds(box, img) {
  const b = boxBounds(box);
  return { x0: clamp01(b.x0 / img.width), y0: clamp01(b.y0 / img.height), x1: clamp01(b.x1 / img.width), y1: clamp01(b.y1 / img.height) };
}

/** Add geometry in normalised frame coordinates (for the overlay and the tracker) and the evidence crop. */
function describe(r, where, img, o) {
  const box = r.box;
  const b = boxBounds(box);
  const W = img.width, H = img.height;
  // A plate cut by the picture edge may be missing characters.
  const edge = b.x0 <= 1 || b.y0 <= 1 || b.x1 >= W - 2 || b.y1 >= H - 2;
  const out = {
    ...r, edge,
    bbox: normBounds(box, img),                     // what was read (may be longer than the detected line)
    lineBounds: where,                              // where the line was detected
    quad: boxCorners(box).map(([x, y]) => [x / W, y / H]),
  };
  if (o.evidenceWidth) {
    // The number the right way up with a little of the plate around it. Never the whole frame.
    const ev = { ...box, w: box.w + 1.2 * box.h, h: box.h * 2 };
    const w = Math.round(Math.min(o.evidenceWidth, Math.max(120, ev.w)));
    out.crop = cropBox(img, ev, w, Math.max(24, Math.round((w * ev.h) / ev.w)), !!r.flip);
  }
  return out;
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));
