// CTC decoding for the text recogniser, restricted to what can appear on a
// ULD plate. The model knows thousands of characters; anything that is not
// A-Z / 0-9 is kept only as a "junk" marker, which downstream code treats as
// a separator (scratches and rivets often come out as punctuation).

export const JUNK = '\u0001';

// Lower-case letters whose shape matches the capital are folded; the others
// do not look like anything stamped on a plate and are treated as junk.
const FOLD = new Set('cosuvwxzkp');

/**
 * @param dictText  model dictionary, one character per line
 * @param classes   number of output classes of the model
 * @returns {string[]} class index -> 'A'..'Z' | '0'..'9' | ' ' | JUNK | '' (blank).
 *   The array also carries `.alnum`: the indices of every class that maps to
 *   a letter or digit (used to look up second-best readings quickly).
 */
export function buildCharset(dictText, classes) {
  let parts = dictText.split('\n').map((l) => l.replace(/\r$/, ''));
  let chars;
  if (parts.length === classes) {                 // file already index-aligned (line 0 = blank)
    chars = parts.slice(); chars[0] = ''; if (chars[classes - 1] === '') chars[classes - 1] = ' ';
  } else if (parts.length - 1 === classes && parts[parts.length - 1] === '') {
    chars = parts.slice(0, -1); chars[0] = '';
  } else {                                        // PaddleOCR convention: blank + dict + space
    if (parts[parts.length - 1] === '') parts = parts.slice(0, -1);
    chars = ['', ...parts, ' '];
  }
  if (chars.length !== classes) throw new Error(`Dictionary has ${chars.length} entries, model has ${classes} classes`);
  const map = chars.map((c, i) => {
    if (i === 0) return '';
    if (c === ' ' || c === '　') return ' ';
    if (/^[A-Z0-9]$/.test(c)) return c;
    if (/^[a-z]$/.test(c)) return FOLD.has(c) ? c.toUpperCase() : JUNK;
    // Full-width forms of the same characters (the dictionary has both).
    if (/^[Ａ-Ｚ０-９]$/.test(c)) return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    return JUNK;
  });
  map.alnum = Int32Array.from(map.map((c, i) => (c.length === 1 && c !== ' ' && c !== JUNK ? i : -1)).filter((i) => i >= 0));
  return map;
}

/**
 * Greedy CTC decode.
 *
 * Several model classes mean the same thing here ("C", "c" and full-width
 * "Ｃ" are all a C on a plate). Their probabilities are added before
 * deciding, so the model hesitating between "C" and "c" is not mistaken for
 * the model being unsure what the character is.
 *
 * @param probs    Float32Array, T*C class probabilities
 * @param usedFrac fraction of the timeline that is real image (rest is padding)
 * @returns [{ch, conf, x, alts}]  x = position along the crop, 0..1;
 *   alts = other letters/digits the model considered at that spot: [[ch, p], ...]
 */
export function ctcDecode(probs, T, C, charset, usedFrac = 1) {
  const out = [];
  const alnum = charset.alnum || [];
  let prev = '', cur = null;                         // what the previous time step said ('' = blank)
  for (let t = 0; t < T; t++) {
    const o = t * C;
    let best = 0, bp = probs[o];
    for (let k = 1; k < C; k++) { const p = probs[o + k]; if (p > bp) { bp = p; best = k; } }
    let ch = charset[best], conf = bp, alts = [];
    if (best !== 0 && ch !== '' && ch !== ' ' && ch !== JUNK) {
      const sum = new Map();
      for (let i = 0; i < alnum.length; i++) {
        const p = probs[o + alnum[i]];
        if (p < 0.01) continue;
        const a = charset[alnum[i]];
        sum.set(a, (sum.get(a) || 0) + p);
      }
      const ranked = [...sum.entries()].sort((a, b) => b[1] - a[1]);
      if (ranked.length) {
        ch = ranked[0][0]; conf = Math.min(1, ranked[0][1]);
        alts = ranked.slice(1, 4);
      }
    }
    if (best === 0 || ch === '') { prev = ''; cur = null; continue; }
    if (ch !== prev) {
      cur = { ch, conf, x: Math.min(1, (t + 0.5) / (T * usedFrac)), alts };
      out.push(cur);
    } else if (cur && conf > cur.conf) {
      // Same character over several time steps: its clearest moment counts.
      cur.conf = conf; cur.alts = alts;
    }
    prev = ch;
  }
  return out;
}
