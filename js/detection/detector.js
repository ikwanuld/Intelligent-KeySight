// Text-region detector. Finds where ULD-number-like text sits in the frame so
// only that crop is sent to OCR (and, if ever needed, to the cloud).
//
// This is a classical detector (stroke-edge density + smearing + connected
// components), chosen because it runs in a few milliseconds on any phone and
// needs no model download. It is deliberately behind a one-function interface
// so a trained detector can replace it later without touching the pipeline.
//
//   detectTextRegions(gray, W, H) -> [{x0,y0,x1,y1,score}]   (pixel coords)

export function toGray(imageData) {
  const { data, width, height } = imageData;
  const g = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    g[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return g;
}

export function detectTextRegions(gray, W, H, opts = {}) {
  const maxRegions = opts.maxRegions ?? 4;
  const N = W * H;

  // 1. Horizontal gradient: character strokes produce dense vertical edges.
  const grad = new Uint8Array(N);
  let sum = 0, sumSq = 0;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 1; x < W - 1; x++) {
      const d = Math.abs(gray[row + x + 1] - gray[row + x - 1]);
      grad[row + x] = d; sum += d; sumSq += d * d;
    }
  }
  const mean = sum / N, std = Math.sqrt(Math.max(0, sumSq / N - mean * mean));
  const thr = Math.max(28, mean + 1.6 * std);

  // 2. Integral image of the edge map.
  const IW = W + 1;
  const integ = new Int32Array(IW * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      if (grad[y * W + x] > thr) rowSum++;
      integ[(y + 1) * IW + x + 1] = integ[y * IW + x + 1] + rowSum;
    }
  }
  const boxSum = (x0, y0, x1, y1) =>
    integ[y1 * IW + x1] - integ[y0 * IW + x1] - integ[y1 * IW + x0] + integ[y0 * IW + x0];

  // 3. Smear: a pixel is "text" when a wide, short window around it is rich
  //    in stroke edges. The window is wide so spaced stencil characters merge
  //    into one line, and short so separate lines stay apart.
  const kw = Math.max(6, Math.round(W * 0.045)), kh = Math.max(2, Math.round(W * 0.008));
  const mask = new Uint8Array(N);
  const minDensity = 0.1;
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - kh), y1 = Math.min(H, y + kh + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - kw), x1 = Math.min(W, x + kw + 1);
      if (boxSum(x0, y0, x1, y1) > minDensity * (x1 - x0) * (y1 - y0)) mask[y * W + x] = 1;
    }
  }

  // 4. Connected components (4-neighbour flood fill).
  const comps = [];
  const stack = new Int32Array(N);
  for (let start = 0; start < N; start++) {
    if (mask[start] !== 1) continue;
    let sp = 0, area = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
    stack[sp++] = start; mask[start] = 2;
    while (sp) {
      const p = stack[--sp];
      const px = p % W, py = (p - px) / W;
      area++;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
      if (px > 0 && mask[p - 1] === 1) { mask[p - 1] = 2; stack[sp++] = p - 1; }
      if (px < W - 1 && mask[p + 1] === 1) { mask[p + 1] = 2; stack[sp++] = p + 1; }
      if (py > 0 && mask[p - W] === 1) { mask[p - W] = 2; stack[sp++] = p - W; }
      if (py < H - 1 && mask[p + W] === 1) { mask[p + W] = 2; stack[sp++] = p + W; }
    }
    const h = y1 - y0 + 1;
    if (h < 8 || h > H * 0.5 || area < 40) continue;
    comps.push({ x0, y0, x1, y1, area });
    if (comps.length > 200) break;
  }

  // 5. Merge fragments that sit on the same line. Widely spaced stencil
  //    lettering often breaks into several blobs (even one per character).
  comps.sort((a, b) => a.x0 - b.x0);
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < comps.length && !merged; i++) {
      for (let j = i + 1; j < comps.length; j++) {
        const a = comps[i], b = comps[j];
        const ha = a.y1 - a.y0 + 1, hb = b.y1 - b.y0 + 1;
        const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
        const gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
        if (overlap < 0.6 * Math.min(ha, hb) || Math.max(ha, hb) > 1.7 * Math.min(ha, hb)) continue;
        if (gap > 1.8 * Math.max(ha, hb)) continue;
        comps[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1),
          y1: Math.max(a.y1, b.y1), area: a.area + b.area };
        comps.splice(j, 1); merged = true; break;
      }
    }
  }

  // 6. Keep line-shaped, text-textured regions; prefer large central ones.
  const regions = [];
  for (const { x0, y0, x1, y1, area } of comps) {
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w < W * 0.14 || w / h < 2) continue;                   // text lines are wide
    if (area / (w * h) < 0.3) continue;                        // ragged blobs
    const edges = boxSum(x0, y0, x1 + 1, y1 + 1) / (w * h);
    if (edges < 0.05 || edges > 0.6) continue;                 // texture, not text
    const bx0 = Math.max(0, x0 + Math.round(kw * 0.6)), bx1 = Math.min(W - 1, x1 - Math.round(kw * 0.6));
    const cx = (x0 + x1) / 2 / W - 0.5, cy = (y0 + y1) / 2 / H - 0.5;
    const centrality = 1 - Math.min(1, Math.hypot(cx, cy) * 1.4);
    regions.push({ x0: bx0, y0, x1: bx1, y1, score: w * h * (0.4 + 0.6 * centrality) });
  }
  regions.sort((a, b) => b.score - a.score);
  return regions.slice(0, maxRegions);
}
