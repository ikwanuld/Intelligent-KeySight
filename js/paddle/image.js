// Image helpers on plain RGBA buffers: { data, width, height }.
// No DOM and no canvas, so the same code runs in a Web Worker, on the main
// thread and in the Node test harness.

export function makeImage(width, height) {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

/**
 * A text box is a rotated rectangle:
 *   { cx, cy, w, h, angle }   angle (radians) = direction of the text line,
 *                             w runs along it, h across it.
 */
export function boxAxes(box) {
  const c = Math.cos(box.angle), s = Math.sin(box.angle);
  return { ux: c, uy: s, vx: -s, vy: c };
}

/** Corners in reading order: top-left, top-right, bottom-right, bottom-left. */
export function boxCorners(box) {
  const { ux, uy, vx, vy } = boxAxes(box);
  const hw = box.w / 2, hh = box.h / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([a, b]) => [box.cx + a * ux + b * vx, box.cy + a * uy + b * vy]);
}

export function boxBounds(box) {
  const c = boxCorners(box);
  const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * Cut a rotated rectangle out of an image, straightened so the text runs left
 * to right. `flip` reads it the other way round (for upside-down plates).
 * Large reductions are averaged (box filter) so thin engraved strokes survive.
 */
export function cropBox(img, box, outW, outH, flip = false) {
  const out = makeImage(outW, outH);
  const { data: src, width: W, height: H } = img;
  const dst = out.data;
  let { ux, uy, vx, vy } = boxAxes(box);
  if (flip) { ux = -ux; uy = -uy; vx = -vx; vy = -vy; }
  const stepU = box.w / outW, stepV = box.h / outH;
  const n = Math.max(1, Math.min(4, Math.round(Math.max(stepU, stepV))));
  const inv = 1 / (n * n);
  const maxX = W - 1, maxY = H - 1;
  for (let j = 0; j < outH; j++) {
    for (let i = 0; i < outW; i++) {
      let r = 0, g = 0, b = 0;
      for (let sj = 0; sj < n; sj++) {
        const lv = ((j + (sj + 0.5) / n) / outH - 0.5) * box.h;
        for (let si = 0; si < n; si++) {
          const lu = ((i + (si + 0.5) / n) / outW - 0.5) * box.w;
          let x = box.cx + lu * ux + lv * vx - 0.5, y = box.cy + lu * uy + lv * vy - 0.5;
          if (x < 0) x = 0; else if (x > maxX) x = maxX;       // clamp = replicate the border
          if (y < 0) y = 0; else if (y > maxY) y = maxY;
          const x0 = x | 0, y0 = y | 0;
          const x1 = x0 < maxX ? x0 + 1 : x0, y1 = y0 < maxY ? y0 + 1 : y0;
          const fx = x - x0, fy = y - y0;
          const p00 = (y0 * W + x0) * 4, p10 = (y0 * W + x1) * 4, p01 = (y1 * W + x0) * 4, p11 = (y1 * W + x1) * 4;
          const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
          r += src[p00] * w00 + src[p10] * w10 + src[p01] * w01 + src[p11] * w11;
          g += src[p00 + 1] * w00 + src[p10 + 1] * w10 + src[p01 + 1] * w01 + src[p11 + 1] * w11;
          b += src[p00 + 2] * w00 + src[p10 + 2] * w10 + src[p01 + 2] * w01 + src[p11 + 2] * w11;
        }
      }
      const o = (j * outW + i) * 4;
      dst[o] = r * inv; dst[o + 1] = g * inv; dst[o + 2] = b * inv; dst[o + 3] = 255;
    }
  }
  return out;
}

/** Whole-image resize (same sampling as cropBox). */
export function resize(img, outW, outH) {
  return cropBox(img, { cx: img.width / 2, cy: img.height / 2, w: img.width, h: img.height, angle: 0 }, outW, outH);
}

/**
 * RGBA -> planar float tensor data in the layout the PaddleOCR models were
 * trained with: channel order B, G, R and (x / 255 - 0.5) / 0.5.
 * `padW` right-pads with zeros (the recogniser's convention).
 */
export function toTensorData(img, padW = img.width) {
  const { data, width: w, height: h } = img;
  const plane = h * padW;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < h; y++) {
    const row = y * padW;
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4, o = row + x;
      out[o] = data[p + 2] / 127.5 - 1;
      out[plane + o] = data[p + 1] / 127.5 - 1;
      out[2 * plane + o] = data[p] / 127.5 - 1;
    }
  }
  return out;
}

/**
 * Stretch the brightness range of an image in place (same gain on every
 * channel, so colours keep their relation). Dark, hazy or washed-out plates
 * come out with the contrast the recogniser was trained on.
 * @param clip    fraction of pixels allowed to saturate at each end
 * @param maxGain upper limit, so noise in a flat image is not blown up
 */
export function autoContrast(img, clip = 0.01, maxGain = 4) {
  const d = img.data, n = d.length >> 2;
  if (!n) return img;
  const hist = new Uint32Array(256);
  const step = n > 40000 ? 4 : 1;                       // a sample is enough on large images
  let count = 0;
  for (let i = 0; i < n; i += step) { const p = i << 2; hist[(d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8]++; count++; }
  const cut = count * clip;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > cut) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > cut) { hi = v; break; } }
  const span = hi - lo;
  if (span >= 235 || span <= 0) return img;             // already full range (or perfectly flat)
  const gain = Math.min(maxGain, 255 / span);
  // Keep the middle of the range in the middle when the gain is capped.
  const offset = gain === 255 / span ? -lo * gain : 127.5 - ((lo + hi) / 2) * gain;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = v * gain + offset;
  for (let p = 0; p < d.length; p += 4) { d[p] = lut[d[p]]; d[p + 1] = lut[d[p + 1]]; d[p + 2] = lut[d[p + 2]]; }
  return img;
}
