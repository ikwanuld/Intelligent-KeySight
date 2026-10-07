import { displayParts } from '../validation/validator.js';
import { db } from '../offline/db.js';

/** Tiny hyperscript helper: h('button', { class: 'btn', onclick }, 'Save') */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

/** ULD number split into prefix / serial / operator code. */
export function uld(value, size = 'mid') {
  return h('span', { class: `uld ${size}`, 'aria-label': value }, displayParts(value).map((p) => h('span', null, p)));
}

export function tag(tone, label) { return h('span', { class: `tag t-${tone}` }, label); }

const SYNC_TEXT = { SYNCED: 'Synced', PENDING: 'Sync pending', SYNCING: 'Syncing', LOCAL: 'On this device only', AUTH: 'Sign in to sync' };
export function syncChip(sync) {
  const el = h('span', { class: 'sync', role: 'status' });
  const paint = () => { el.dataset.s = sync.state; el.textContent = SYNC_TEXT[sync.state] || sync.state; };
  paint();
  el.paint = paint;
  return el;
}

/** Bottom sheet. Returns { el, close }. */
export function sheet(content, { onClose, dismissable = true } = {}) {
  const scrim = h('div', { class: 'scrim', role: 'dialog', 'aria-modal': 'true' });
  const box = h('div', { class: 'sheet' }, content);
  scrim.append(box);
  const close = () => { scrim.remove(); onClose?.(); };
  if (dismissable) scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  document.body.append(scrim);
  return { el: box, close };
}

export function fmtTime(isoStr) {
  return new Date(isoStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
export function fmtDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The picture of the number as the camera saw it (a small crop, never the
 * whole frame), for items staff have to check. Returns an element that fills
 * in once the picture is loaded from the device, or null when there is none.
 */
export function cropImage(scan) {
  const ref = scan.local_image || scan.image_reference;
  if (!ref) return null;
  const img = h('img', { class: 'crop', alt: 'Photo of the number as scanned', hidden: true });
  db.get('images', ref).then((rec) => {
    if (!rec?.blob) return;
    const url = URL.createObjectURL(rec.blob);
    img.onload = () => URL.revokeObjectURL(url);
    img.src = url; img.hidden = false;
  }).catch(() => { /* no picture, the card still works */ });
  return img;
}
