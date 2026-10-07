// Bridges the pallet reader to the rest of the app: turns one reading into
// the same candidate shape the container pipeline produces, so tracking,
// duplicate detection, the confirmation queue and storage are shared.

import { validate, normalize, STATUS_RANK } from '../validation/validator.js';

// One doubtful character makes the whole number doubtful, and an average over
// ten characters hides it. So the figure the confidence thresholds are applied
// to is capped twice:
//   - by the weakest character plus a margin: with the default "high"
//     threshold of 90, a number whose weakest character is below 85 is never
//     shown as high confidence;
//   - by how seriously the recogniser considered a DIFFERENT character
//     anywhere in the number ("3, but 15 % says 2"): from 10 % on it is not
//     high confidence, from 30 % on it is an uncertain reading.
// Both come from the reference photos: every wrong number that was otherwise
// flawless (all of them on the embossed, same-colour plate) had a weakest
// character below 85 and a rival of 15 % or more.
const WEAKEST_MARGIN = 5;
const RIVAL_CEILING = 99;
// A reading this sure of every single character may be shown after one frame.
// Anything less has to be read the same way twice.
const SOLID_WEAKEST = 95, SOLID_RIVAL = 5;

/**
 * @param r reading from PalletReader
 * @returns candidate for the tracker / Store.addDetection
 */
export function toCandidate(r, config, at = Date.now()) {
  const raw = normalize(r.raw);
  const rawV = validate(raw, config, at);
  // Suggestions come from the pallet parser only. The general-purpose
  // corrector is deliberately not used here: it would happily turn a rivet
  // that reads as "O" into a zero.
  let suggestion = null;
  if (!r.partial && r.fixed && r.fixed !== raw) {
    const v = validate(r.fixed, config, at);
    if (STATUS_RANK[v.status] > STATUS_RANK[rawV.status] || (v.status !== 'INVALID' && r.fixes.some((f) => f.kind !== 'serial'))) {
      suggestion = { suggestion: v.value, changes: r.fixes.map((f) => ({ pos: f.at, from: f.from, to: f.to })), validation: v };
    }
  }
  const a = { raw: rawV, suggestion, best: suggestion ? suggestion.validation : rawV };

  // Reasons for a second look that come from how the number was read, not
  // from the number itself.
  const reviewReasons = [];
  if (!r.partial) {
    if (r.unknownPrefix && r.nearPrefixes?.length) reviewReasons.push(`Type code may be misread (${r.nearPrefixes.join(' or ')}?)`);
    if (r.skips) reviewReasons.push('Rivet or mark next to the number');
    if (r.ambiguous) reviewReasons.push('Two possible readings');
    if (r.edge) reviewReasons.push('Number at the edge of the picture');
  }
  // A fragment is never confirmable as it stands, whatever it happens to spell.
  let status = r.partial ? 'INVALID' : a.best.status;
  if (status === 'VALID' && reviewReasons.length) status = 'NEEDS_REVIEW';

  const mean = (r.conf || 0) * 100, minConf = (r.minConf ?? r.conf ?? 0) * 100, rival = (r.rival || 0) * 100;
  const conf = Math.max(0, Math.min(100, mean, minConf + WEAKEST_MARGIN, RIVAL_CEILING - rival));
  return {
    raw, assess: a, status, reviewReasons,
    conf, meanConf: mean, minConf, rival, charConf: r.charConf || [],
    solid: status === 'VALID' && !suggestion && minConf >= SOLID_WEAKEST && rival < SOLID_RIVAL,
    bbox: r.bbox, lineBounds: r.lineBounds, quad: r.quad, partial: !!r.partial,
    text: r.text, engine: 'paddle', pipeline: 'pallet',
    readInfo: { how: r.how, flipped: !!r.flip, attempts: r.attempts, skips: r.skips || 0 },
    evidenceImage: r.crop || null,
  };
}
