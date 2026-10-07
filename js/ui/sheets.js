// Bottom sheets: edit / add manually, and the completion summary.

import { h, clear, sheet, uld, cropImage } from './dom.js';
import { confirmedList, copyText, downloadCsv } from './export.js';

/**
 * Edit an existing item or add a ULD by hand.
 * Typing is uppercased and validated live. A correction is only ever offered;
 * the typed text is never changed unless staff tap "Accept suggestion".
 */
export function editSheet(ctx, { scan = null, onDone } = {}) {
  const adding = !scan;
  let suggestionMeta = { suggestion: null, accepted: null };
  let typed = null;

  const input = h('input', { type: 'text', class: 'uldinput', value: scan ? scan.value : '', maxLength: 14,
    autocomplete: 'off', autocapitalize: 'characters', spellcheck: false, 'aria-label': 'ULD number', enterKeyHint: 'done' });
  const msg = h('p', { class: 'small', role: 'status' });
  const sugg = h('div', { class: 'notice review', hidden: true });
  const save = h('button', { class: 'btn ok' }, 'Confirm');
  const cancel = h('button', { class: 'btn plain' }, 'Cancel');

  const check = () => {
    const pos = input.selectionStart;
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    try { input.setSelectionRange(pos, pos); } catch { /* not focused */ }
    const c = ctx.store.check(input.value, scan?.scan_id);
    const v = c.validation;
    clear(sugg); sugg.hidden = true;
    if (!input.value) { msg.textContent = 'Type the number as printed on the unit.'; msg.className = 'small muted'; save.disabled = true; return; }
    if (c.duplicate) { msg.textContent = 'Already scanned in this session.'; msg.className = 'small t-bad'; save.disabled = true; return; }
    if (c.suggestion && suggestionMeta.accepted !== false) {
      sugg.hidden = false;
      sugg.append(h('span', { class: 'small' }, 'Did you mean'), h('div', null, uld(c.suggestion, 'mid')),
        h('div', { class: 'acts', style: 'margin-top:.5rem' },
          h('button', { class: 'btn plain slim', onclick: () => { suggestionMeta = { suggestion: c.suggestion, accepted: false }; check(); } }, 'Keep original'),
          h('button', { class: 'btn primary slim', onclick: () => {
            typed = typed || input.value;
            suggestionMeta = { suggestion: c.suggestion, accepted: true }; input.value = c.suggestion; check();
          } }, 'Accept suggestion')));
    }
    if (v.status === 'INVALID') { msg.textContent = v.reasons[0]; msg.className = 'small t-bad'; save.disabled = true; save.textContent = 'Confirm'; return; }
    msg.textContent = v.status === 'NEEDS_REVIEW' ? `Needs review: ${v.reasons.join('. ')}` : 'Valid ULD number';
    msg.className = `small ${v.status === 'NEEDS_REVIEW' ? 't-review' : 't-ok'}`;
    save.disabled = false;
    save.textContent = v.status === 'NEEDS_REVIEW' ? 'Confirm anyway' : 'Confirm';
  };
  input.addEventListener('input', () => { if (suggestionMeta.accepted === false) suggestionMeta = { suggestion: null, accepted: null }; check(); });

  const s = sheet([
    h('h2', null, adding ? 'Add a ULD manually' : scan.state === 'REJECTED' ? 'Fix rejected ULD' : 'Edit ULD number'),
    scan ? cropImage(scan) : null,
    h('div', null, input, msg), sugg,
    h('div', { class: 'acts' }, cancel, save),
  ], { onClose: () => onDone?.() });

  cancel.onclick = s.close;
  save.onclick = async () => {
    save.disabled = true;
    try {
      if (adding) await ctx.store.addManual(input.value, { ...suggestionMeta, typed: typed || input.value });
      else await ctx.store.editAndConfirm(scan.scan_id, input.value, suggestionMeta);
      s.close();
    } catch (e) { msg.textContent = e.message; msg.className = 'small t-bad'; save.disabled = false; }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !save.disabled) save.click(); });
  check();
  setTimeout(() => input.focus(), 50);
  return s;
}

/** Summary shown before a session is finalised. Nothing is final until Complete is tapped. */
export function completeSheet(ctx, { onComplete, onClose }) {
  const c = ctx.store.counts();
  const done = h('button', { class: 'btn primary' }, 'Complete');
  const back = h('button', { class: 'btn plain' }, 'Back');
  // Last chance to take the list out before the session closes (also available later under My history).
  const nums = confirmedList(ctx.store.scans), sess = ctx.store.session, all = [...ctx.store.scans];
  const copyBtn = h('button', { class: 'btn plain slim', disabled: !nums.length, onclick: async () => {
    copyBtn.textContent = (await copyText(nums.join('\n'))) ? `Copied ${nums.length}` : 'Copy failed';
    setTimeout(() => { copyBtn.textContent = 'Copy ULD list'; }, 1800);
  } }, 'Copy ULD list');
  const exportRow = all.length ? h('div', { class: 'acts', style: 'grid-template-columns:1fr 1fr' }, copyBtn,
    h('button', { class: 'btn plain slim', onclick: () => downloadCsv(sess, all) }, 'Download CSV')) : null;
  const s = sheet([
    h('h2', null, 'Session summary'),
    summaryPlate(c),
    c.pending ? h('p', { class: 'notice review' }, `${c.pending} pending ${c.pending === 1 ? 'scan is' : 'scans are'} not confirmed and will not be counted. Go back to review ${c.pending === 1 ? 'it' : 'them'}.`) : null,
    exportRow,
    h('div', { class: 'acts' }, back, done),
  ], { onClose });
  back.onclick = s.close;
  done.onclick = async () => { done.disabled = true; await onComplete(); s.close(); };
  return s;
}

/** The counts of a session: what was confirmed, and what was not. */
export function summaryPlate(c) {
  return h('div', { class: 'plate summary' },
    h('span', { class: 'lead' }, 'Containers'), h('b', null, c.containers),
    h('span', { class: 'lead' }, 'Pallets'), h('b', null, c.pallets),
    h('span', null, 'Other ULDs'), h('b', null, c.other),
    h('span', null, 'Pending'), h('b', null, c.pending),
    h('span', null, 'Rejected'), h('b', null, c.rejected));
}
