// Confirmation card: Confirm / Reject / Edit, by button or by swipe.
// Swipe right = confirm, swipe left = reject. Buttons are always present so
// the gestures are never the only way.

import { h, uld, tag, cropImage } from './dom.js';
import { evaluate } from '../session/status.js';

const SWIPE = 84; // px

export function scanCard(scan, ctx, { onEdit, onConfirmed } = {}) {
  const ev = evaluate(scan, ctx.config());
  const act = (fn) => async () => { try { await fn(); } catch (e) { ctx.alert(e.message); } };
  const confirm = act(async () => { await ctx.store.confirm(scan.scan_id); onConfirmed?.(scan); });
  const reject = act(() => ctx.store.reject(scan.scan_id));

  // Anything staff are asked to check comes with the picture it was read from.
  const needsLook = ev.status !== 'VALID' || ev.suggestionOpen;
  const el = h('div', { class: `card ${ev.tone}`, dataset: { id: scan.scan_id } },
    h('div', { class: 'head' }, uld(scan.value, 'big'), tag(ev.tone, ev.label)),
    ev.reasons.length && !ev.suggestionOpen ? h('p', { class: 'why' }, ev.reasons.join('. ')) : null,
    needsLook ? cropImage(scan) : null,
  );

  if (ev.suggestionOpen) {
    el.append(h('div', { class: 'sugg' },
      h('span', { class: 'small' }, 'Did you mean'),
      uld(scan.suggested_correction, 'mid'),
      h('div', { class: 'acts two', style: 'margin-top:0' },
        h('button', { class: 'btn plain slim', onclick: act(() => ctx.store.resolveSuggestion(scan.scan_id, false)) }, 'Keep original'),
        h('button', { class: 'btn primary slim', onclick: act(() => ctx.store.resolveSuggestion(scan.scan_id, true)) }, 'Accept suggestion'))));
  }

  el.append(h('div', { class: ev.confirmable ? 'acts' : 'acts two' },
    h('button', { class: 'btn bad', onclick: reject }, 'Reject'),
    h('button', { class: 'btn plain', onclick: () => onEdit?.(scan) }, 'Edit'),
    ev.confirmable ? h('button', { class: 'btn ok', onclick: confirm }, ev.status === 'NEEDS_REVIEW' ? 'Confirm anyway' : 'Confirm') : null));

  // ---- swipe ----
  let startX = 0, startY = 0, dx = 0, active = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    active = true; startX = e.clientX; startY = e.clientY; dx = 0;
    el.setPointerCapture(e.pointerId); el.classList.add('swiping');
  });
  el.addEventListener('pointermove', (e) => {
    if (!active) return;
    dx = e.clientX - startX;
    if (Math.abs(e.clientY - startY) > Math.abs(dx) * 1.5 && Math.abs(dx) < 12) return;
    el.style.transform = `translateX(${dx}px) rotate(${dx / 60}deg)`;
    el.dataset.dir = dx > SWIPE / 2 ? 'right' : dx < -SWIPE / 2 ? 'left' : '';
  });
  const end = () => {
    if (!active) return;
    active = false; el.classList.remove('swiping'); el.style.transform = ''; el.dataset.dir = '';
    if (dx > SWIPE) { if (ev.confirmable) confirm(); }
    else if (dx < -SWIPE) reject();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => { dx = 0; end(); });
  return el;
}
