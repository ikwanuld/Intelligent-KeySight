// Crop + enhance helpers shared by every OCR engine.

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}

/** Copy a source rectangle (video or canvas pixels) into a new canvas. */
export function cropCanvas(source, rect, tw, th) {
  const c = makeCanvas(tw, th);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, c.width, c.height);
  return c;
}

/**
 * Grayscale, contrast-stretch and normalise polarity (dark text on light
 * background) in place. Returns what was done so it can be logged.
 */
export function enhance(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data, n = d.length / 4;
  const hist = new Uint32Array(256);
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const v = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    g[j] = v; hist[v]++;
  }
  // 2nd / 98th percentile stretch.
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.02) { hi = v; break; } }
  if (hi - lo < 24) { lo = Math.max(0, lo - 12); hi = Math.min(255, hi + 12); }
  // Otsu threshold, to decide which side is the background.
  let sumAll = 0; for (let v = 0; v < 256; v++) sumAll += v * hist[v];
  let wB = 0, sumB = 0, best = -1, otsu = 127;
  for (let v = 0; v < 256; v++) {
    wB += hist[v]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; otsu = v; }
  }
  let dark = 0; for (let v = 0; v <= otsu; v++) dark += hist[v];
  const inverted = dark > n * 0.55; // mostly dark => light text on dark panel
  const span = Math.max(1, hi - lo);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    let v = ((g[j] - lo) * 255) / span;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    if (inverted) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { inverted, lo, hi };
}

export function canvasToBlob(canvas, quality = 0.8) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}
