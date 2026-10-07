// Image-quality analysis and live guidance. Everything here is advisory:
// nothing in this module can stop a frame from being OCR'd.

export const LIGHTING = ['VERY_LOW_LIGHT', 'LOW_LIGHT', 'GOOD', 'BRIGHT', 'GLARE'];

export class QualityAnalyzer {
  constructor() { this.prevThumb = null; this.motionAvg = 0; this.lastMotion = 0; }

  /** @param gray Uint8Array luma, W x H  @param box optional text region (px) */
  analyze(gray, W, H, box) {
    // Brightness and saturation are measured on the text region when there is
    // one, otherwise on the central part of the frame.
    const r = box || { x0: W * 0.15 | 0, y0: H * 0.25 | 0, x1: W * 0.85 | 0, y1: H * 0.75 | 0 };
    let sum = 0, sat = 0, n = 0;
    for (let y = r.y0; y <= r.y1; y += 2) {
      for (let x = r.x0; x <= r.x1; x += 2) {
        const v = gray[y * W + x]; sum += v; if (v >= 250) sat++; n++;
      }
    }
    const luma = n ? sum / n : 0;
    const glare = n ? sat / n : 0;

    // Sharpness: variance of a Laplacian over the same region.
    let ls = 0, lss = 0, ln = 0;
    for (let y = Math.max(1, r.y0); y < Math.min(H - 1, r.y1); y += 2) {
      for (let x = Math.max(1, r.x0); x < Math.min(W - 1, r.x1); x += 2) {
        const p = y * W + x;
        const l = 4 * gray[p] - gray[p - 1] - gray[p + 1] - gray[p - W] - gray[p + W];
        ls += l; lss += l * l; ln++;
      }
    }
    const sharpness = ln ? lss / ln - (ls / ln) ** 2 : 0;

    // Motion: change of a 16x16 thumbnail between frames.
    const T = 16, thumb = new Float32Array(T * T);
    const bw = Math.floor(W / T), bh = Math.floor(H / T);
    for (let ty = 0; ty < T; ty++) for (let tx = 0; tx < T; tx++) {
      let s = 0, c = 0;
      for (let y = ty * bh; y < (ty + 1) * bh; y += 3) for (let x = tx * bw; x < (tx + 1) * bw; x += 3) { s += gray[y * W + x]; c++; }
      thumb[ty * T + tx] = c ? s / c : 0;
    }
    let motion = 0;
    if (this.prevThumb) {
      for (let i = 0; i < thumb.length; i++) motion += Math.abs(thumb[i] - this.prevThumb[i]);
      motion /= thumb.length;
    }
    this.prevThumb = thumb;
    this.lastMotion = motion;                       // unsmoothed: how much this frame differs from the last
    this.motionAvg = this.motionAvg * 0.5 + motion * 0.5;

    let lighting = 'GOOD';
    if (glare > 0.12) lighting = 'GLARE';
    else if (luma < 35) lighting = 'VERY_LOW_LIGHT';
    else if (luma < 70) lighting = 'LOW_LIGHT';
    else if (luma > 185) lighting = 'BRIGHT';

    const textHeight = box ? (box.y1 - box.y0) / H : 0;
    const textWidth = box ? (box.x1 - box.x0) / W : 0;
    const clipped = box ? (box.x0 <= 2 || box.x1 >= W - 3) : false;

    return { luma: Math.round(luma), glare: +glare.toFixed(3), sharpness: Math.round(sharpness),
      motion: +this.motionAvg.toFixed(1), lighting, textHeight: +textHeight.toFixed(3),
      textWidth: +textWidth.toFixed(3), clipped };
  }
}

/**
 * Rotation and perspective estimated from OCR character boxes.
 * @returns {{tilt:number, perspective:number}} tilt in degrees; perspective
 *   is the ratio of character heights at the two ends of the number (1 = flat).
 */
export function estimateAngle(charBoxes) {
  const b = (charBoxes || []).filter(Boolean);
  if (b.length < 5) return { tilt: 0, perspective: 1 };
  const xs = b.map((k) => (k.x0 + k.x1) / 2), ys = b.map((k) => (k.y0 + k.y1) / 2);
  const mx = xs.reduce((a, c) => a + c, 0) / xs.length, my = ys.reduce((a, c) => a + c, 0) / ys.length;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const tilt = sxx ? Math.atan(sxy / sxx) * 180 / Math.PI : 0;
  const third = Math.max(2, Math.floor(b.length / 3));
  const hAvg = (arr) => arr.reduce((a, k) => a + (k.y1 - k.y0), 0) / arr.length;
  const left = hAvg(b.slice(0, third)), right = hAvg(b.slice(-third));
  const perspective = Math.max(left, right) / Math.max(1, Math.min(left, right));
  return { tilt: +tilt.toFixed(1), perspective: +perspective.toFixed(2) };
}

/** One short instruction for the staff, most urgent first. */
export function guidance(q, state = {}) {
  if (!q) return { level: 'idle', text: 'Starting camera' };
  if (q.motion > 14) return { level: 'warn', text: 'Hold steady' };
  if (q.lighting === 'VERY_LOW_LIGHT' || q.lighting === 'LOW_LIGHT') return { level: 'warn', text: 'Low light' };
  if (q.lighting === 'GLARE') return { level: 'warn', text: 'Too much glare' };
  if (!state.hasText) return { level: 'idle', text: 'Point at the ULD number' };
  if (q.clipped) return { level: 'warn', text: 'Move back' };
  if (q.textHeight && q.textHeight < 0.035 && q.textWidth < 0.4) return { level: 'warn', text: 'Move closer' };
  if (state.angle && (Math.abs(state.angle.tilt) > 14 || state.angle.perspective > 1.45)) {
    return { level: 'warn', text: 'Reduce angle' };
  }
  if (state.partial) return { level: 'warn', text: 'Number partly hidden' };
  if (q.sharpness < 40) return { level: 'warn', text: 'Hold steady' };
  return { level: 'good', text: 'Good position' };
}
