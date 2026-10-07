// Post-processing for the DB text detector: probability map -> rotated text
// boxes. Same steps as the reference implementation (binarise, dilate,
// components, minimum-area rectangle, score, unclip) written without OpenCV.

function convexHull(points) {
  // Andrew's monotone chain. points: [[x, y], ...]
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** Smallest enclosing rotated rectangle of a convex polygon. */
export function minAreaRect(hull) {
  if (hull.length < 3) {
    const xs = hull.map((p) => p[0]), ys = hull.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, angle: 0 };
  }
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    let ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-6) continue;
    ex /= len; ey /= len;
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const p of hull) {
      const e = p[0] * ex + p[1] * ey, n = -p[0] * ey + p[1] * ex;
      if (e < minE) minE = e; if (e > maxE) maxE = e;
      if (n < minN) minN = n; if (n > maxN) maxN = n;
    }
    const area = (maxE - minE) * (maxN - minN);
    if (!best || area < best.area) {
      const ce = (minE + maxE) / 2, cn = (minN + maxN) / 2;
      best = { area, cx: ce * ex - cn * ey, cy: ce * ey + cn * ex, w: maxE - minE, h: maxN - minN, angle: Math.atan2(ey, ex) };
    }
  }
  return normalizeBox(best);
}

/** Long side = text direction; direction points right (or down when vertical). */
export function normalizeBox(b) {
  let { cx, cy, w, h, angle } = b;
  if (h > w) { [w, h] = [h, w]; angle += Math.PI / 2; }
  while (angle > Math.PI / 2) angle -= Math.PI;
  while (angle <= -Math.PI / 2) angle += Math.PI;
  return { ...b, cx, cy, w, h, angle };
}

/**
 * @param prob Float32Array, w*h probabilities
 * @returns boxes in probability-map pixels: [{cx, cy, w, h, angle, score}]
 */
export function dbBoxes(prob, w, h, opt = {}) {
  const thresh = opt.thresh ?? 0.3, boxThresh = opt.boxThresh ?? 0.3, unclip = opt.unclipRatio ?? 1.6;
  const minSide = opt.minSide ?? 3, maxBoxes = opt.maxBoxes ?? 100;
  const n = w * h;

  // Binarise, then dilate with a 2x2 kernel so nearby glyphs of a line join.
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (prob[i] > thresh) bin[i] = 1;
  const mask = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (bin[i] || (x > 0 && bin[i - 1]) || (y > 0 && bin[i - w]) || (x > 0 && y > 0 && bin[i - w - 1])) mask[i] = 1;
    }
  }

  const boxes = [];
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (mask[start] !== 1) continue;
    // 8-connected flood fill; remember every pixel of the component.
    let sp = 0, count = 0;
    stack[sp++] = start; mask[start] = 2;
    let y0 = h, y1 = 0, sum = 0;
    const pix = [];
    while (sp) {
      const p = stack[--sp];
      pix.push(p); count++; sum += prob[p];
      const px = p % w, py = (p - px) / w;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = py + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = px + dx; if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (mask[q] === 1) { mask[q] = 2; stack[sp++] = q; }
        }
      }
    }
    if (count < 6) continue;
    // Outline = left and right extent of every row (enough for a hull).
    const rows = y1 - y0 + 1;
    const minX = new Int32Array(rows).fill(w), maxX = new Int32Array(rows).fill(-1);
    for (const p of pix) {
      const px = p % w, r = (p - px) / w - y0;
      if (px < minX[r]) minX[r] = px; if (px > maxX[r]) maxX[r] = px;
    }
    const pts = [];
    for (let r = 0; r < rows; r++) {
      if (maxX[r] < 0) continue;
      const y = y0 + r;
      pts.push([minX[r], y], [maxX[r] + 1, y], [minX[r], y + 1], [maxX[r] + 1, y + 1]);
    }
    const rect = minAreaRect(convexHull(pts));
    if (Math.min(rect.w, rect.h) < minSide) continue;
    const score = sum / count;
    if (score < boxThresh) continue;
    // "Unclip": the network predicts a shrunk text kernel; grow it back.
    const d = (rect.w * rect.h * unclip) / (2 * (rect.w + rect.h));
    boxes.push({ cx: rect.cx, cy: rect.cy, w: rect.w + 2 * d, h: rect.h + 2 * d, angle: rect.angle, score });
  }
  boxes.sort((a, b) => b.w * b.h - a.w * a.h);
  return boxes.slice(0, maxBoxes);
}
