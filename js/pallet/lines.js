// Groups detector boxes that sit on the same text line.
//
// A pallet ID is printed as three groups ("PAG 70229 R7"), often with a rivet
// or a wide gap between them, and a faint group may be detected separately
// from the rest. The recogniser reads far better when it sees the whole line,
// so collinear neighbours are merged into one rotated box first.

import { boxAxes, boxCorners } from '../paddle/image.js';

const angleDiff = (a, b) => { let d = Math.abs(a - b) % Math.PI; if (d > Math.PI / 2) d = Math.PI - d; return d; };

function sameLine(a, b, opt) {
  if (angleDiff(a.angle, b.angle) > opt.maxAngle) return false;
  const hMax = Math.max(a.h, b.h), hMin = Math.min(a.h, b.h);
  if (hMin / hMax < opt.minHeightRatio) return false;
  // Measure B in the frame of the longer box (its angle is more reliable).
  const ref = a.w >= b.w ? a : b, other = ref === a ? b : a;
  const { ux, uy, vx, vy } = boxAxes(ref);
  const dx = other.cx - ref.cx, dy = other.cy - ref.cy;
  const along = Math.abs(dx * ux + dy * uy), across = Math.abs(dx * vx + dy * vy);
  if (across > opt.maxOffset * hMax) return false;
  const gap = along - (a.w + b.w) / 2;
  return gap < opt.maxGap * hMax;
}

function merge(members) {
  const ref = members.reduce((m, b) => (b.w > m.w ? b : m), members[0]);
  const { ux, uy, vx, vy } = boxAxes(ref);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const b of members) {
    for (const [x, y] of boxCorners(b)) {
      const u = x * ux + y * uy, v = x * vx + y * vy;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
  }
  const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
  return {
    cx: cu * ux + cv * vx, cy: cu * uy + cv * vy, w: maxU - minU, h: maxV - minV, angle: ref.angle,
    score: Math.max(...members.map((b) => b.score ?? 0)), parts: members.length,
  };
}

/** @returns merged line boxes, largest first */
export function groupLines(boxes, options = {}) {
  const opt = { maxAngle: (14 * Math.PI) / 180, minHeightRatio: 0.45, maxOffset: 0.55, maxGap: 2.6, ...options };
  const parent = boxes.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (sameLine(boxes[i], boxes[j], opt)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  boxes.forEach((b, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(b); });
  return [...groups.values()].map(merge).sort((a, b) => b.w * b.h - a.w * a.h);
}

/** Lengthen a line box along its text direction (to pick up a faint first or last group). */
export function extendBox(box, leftH, rightH) {
  const { ux, uy } = boxAxes(box);
  const l = leftH * box.h, r = rightH * box.h;
  return { ...box, cx: box.cx + ((r - l) / 2) * ux, cy: box.cy + ((r - l) / 2) * uy, w: box.w + l + r };
}
