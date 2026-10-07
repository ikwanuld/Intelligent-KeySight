// Session screen: counts, pending, rejected / review, and recent scans.
// Read-only when opened from history for a finished session.

import { h, clear, uld, tag, fmtTime } from './dom.js';
import { scanCard } from './card.js';
import { editSheet, summaryPlate } from './sheets.js';
import { evaluate } from '../session/status.js';
import { confirmedList, copyText, downloadCsv } from './export.js';

export function sessionView(ctx, { session, scans, readOnly = false, onClose, onComplete, onEdit, forced = false, title }) {
  const edit = onEdit || ((x) => editSheet(ctx, { scan: x }));
  const body = h('div', { class: 'body' });
  const closeBtn = h('button', { class: 'iconbtn', onclick: () => api.close() }, 'Close');
  const el = h('div', { class: 'full' },
    h('header', null, h('div', null, h('h2', null, title || 'Scan session'),
      h('span', { class: 'small' }, `${session.station_code} ${session.zone_name}, ${session.session_reference}`)), closeBtn),
    body);

  const render = () => {
    const list = scans();
    const c = ctx.store.counts(list);
    clear(body);
    closeBtn.hidden = api.forced;
    if (api.forced) body.append(h('p', { class: 'notice review' }, 'Scanning paused. Review the pending scans to continue.'));
    body.append(summaryPlate(c));

    const pending = list.filter((s) => s.state === 'PENDING');
    if (pending.length) {
      body.append(h('h3', { class: 'section-h' }, 'Pending', h('span', { class: 'small muted' }, pending.length)));
      for (const s of pending) {
        body.append(readOnly ? row(s) : scanCard(s, ctx, { onEdit: edit }));
      }
    }

    const rejected = list.filter((s) => s.state === 'REJECTED');
    if (rejected.length) {
      body.append(h('h3', { class: 'section-h' }, 'Rejected / Review', h('span', { class: 'small muted' }, rejected.length)));
      body.append(h('ul', { class: 'rows' }, rejected.map((s) => {
        const ev = evaluate(s, ctx.config());
        return h('li', null,
          h('div', { class: 'grow' }, uld(s.value), h('div', { class: 'small muted' }, `Reason: ${ev.reasons[0] || 'Rejected by staff'}`)),
          readOnly ? null : h('button', { class: 'btn plain slim', onclick: () => edit(s) }, 'Edit'));
      })));
    }

    // Take the list out: copy the confirmed container and pallet numbers, or download everything as CSV.
    if (!api.forced && list.length) {
      const nums = confirmedList(list);
      const copyBtn = h('button', { class: 'btn plain slim', disabled: !nums.length, onclick: async () => {
        const ok = await copyText(nums.join('\n'));
        copyBtn.textContent = ok ? `Copied ${nums.length}` : 'Copy failed';
        setTimeout(() => { copyBtn.textContent = 'Copy ULD list'; }, 1800);
      } }, 'Copy ULD list');
      body.append(h('div', { class: 'acts two', style: 'display:grid;grid-template-columns:1fr 1fr;gap:.5rem' }, copyBtn,
        h('button', { class: 'btn plain slim', onclick: () => downloadCsv(session, list) }, 'Download CSV')));
    }

    const done = list.filter((s) => s.state === 'CONFIRMED' || s.state === 'AUTO_SAVED').reverse();
    body.append(h('h3', { class: 'section-h' }, 'Recent scans', h('span', { class: 'small muted' }, done.length)));
    body.append(done.length ? h('ul', { class: 'rows' }, done.map(row)) : h('p', { class: 'muted' }, 'No confirmed scans yet.'));

    if (!readOnly && onComplete && !api.forced) {
      body.append(h('button', { class: 'btn primary block', style: 'margin-top:1.4rem', onclick: onComplete }, 'Complete session'));
    }
  };

  const row = (s) => {
    const ev = evaluate(s, ctx.config());
    const note = s.manually_added ? 'Added manually' : s.manually_corrected ? 'Corrected' : s.review_acknowledged ? 'Confirmed with review' : null;
    return h('li', null,
      h('div', { class: 'grow' }, uld(s.value), note ? h('div', { class: 'small muted' }, note) : null),
      h('span', { class: 'small muted' }, fmtTime(s.confirmed_at || s.created_at)), tag(ev.tone, s.state === 'CONFIRMED' ? 'Confirmed' : ev.label));
  };

  const api = { el, render, forced, close: () => { el.remove(); onClose?.(); } };
  document.body.append(el);
  render();
  return api;
}
