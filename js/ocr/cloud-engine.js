// Cloud OCR fallback. Optional path, never a prerequisite for scanning:
//  - off unless the admin enables it (config.cloudOcr.enabled)
//  - skipped when offline or when no backend is configured
//  - sends only the cropped ULD-number image, never a camera frame
//  - asked at most once per unreadable detection
//
// The backend proxies to whichever provider is chosen after the benchmark, so
// the provider can change without an app release (POST /ocr in docs/API.md).

import { api } from '../api/client.js';
import { groupLines } from './engine.js';
import { extractCandidates } from './candidates.js';
import { canvasToBlob } from './preprocess.js';

const TIMEOUT_MS = 4000;

/**
 * @param r an unreadable tracker result
 * @returns a replacement result read by the cloud, or null to keep the local one
 */
export async function cloudRead(r, config) {
  if (!config.cloudOcr?.enabled || !api.enabled || !navigator.onLine || !r.obs.evidence) return null;
  try {
    const blob = await canvasToBlob(r.obs.evidence, 0.9);
    const t0 = performance.now();
    const res = await Promise.race([
      api.cloudOcr(blob),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)),
    ]);
    const cands = extractCandidates(groupLines(res.symbols || []), config).filter((c) => c.status !== 'INVALID');
    if (!cands.length) return null;
    const best = cands.sort((a, b) => b.conf - a.conf)[0];
    return {
      ...r, status: best.status, conf: best.conf, cloud: true, disagreement: true, localRaw: r.obs.raw,
      obs: { ...best, bbox: r.obs.bbox, evidence: r.obs.evidence, env: r.obs.env, engine: res.engine || 'cloud',
        ocrMs: Math.round(performance.now() - t0) },
      variants: [...(r.variants || []), { raw_text: best.raw, frames: 1, overall_confidence: Math.round(best.conf), character_confidence: best.charConf, source: 'cloud' }],
    };
  } catch {
    return null; // cloud failure never blocks the scanner
  }
}
