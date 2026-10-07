// "My history": each day is one Daily Activity (all of that day's sessions
// together), with the zone breakdown and the individual sessions underneath.

import { h, clear, fmtDay, fmtTime } from './dom.js';
import { db } from '../offline/db.js';
import { auth } from '../auth/auth.js';
import { sessionView } from './sessionview.js';

// "8" when only containers were counted, "8 + 3 pallets" when both were.
function tally(c, words = false) {
  const cont = words ? `${c.containers} ${c.containers === 1 ? 'container' : 'containers'}` : String(c.containers);
  if (!c.pallets) return cont;
  const pal = `${c.pallets} ${c.pallets === 1 ? 'pallet' : 'pallets'}`;
  return c.containers ? `${cont} + ${pal}` : pal;
}

const STATUS = { DRAFT: 'Not started', IN_PROGRESS: 'In progress', COMPLETED: 'Completed', AUTO_COMPLETED: 'Closed automatically at day end' };

export async function historyScreen(root, ctx) {
  const page = h('div', { class: 'page' },
    h('div', { class: 'topline' }, h('h1', null, 'My history'), h('button', { class: 'btn slim plain', onclick: () => ctx.go('home') }, 'Back')));
  clear(root).append(page);
  const days = await ctx.store.sessionsByDay(auth.user.user_id);
  if (!days.length) { page.append(h('p', { class: 'muted' }, 'No sessions yet. Start one to see your daily totals here.')); return; }

  for (const d of days) {
    page.append(h('div', { class: 'plate' },
      h('h2', null, fmtDay(d.day)),
      h('div', { class: 'summary', style: 'margin:.6rem 0' },
        h('span', { class: 'lead' }, 'Total containers'), h('b', null, d.containers),
        h('span', { class: 'lead' }, 'Total pallets'), h('b', null, d.pallets),
        [...d.zones.entries()].flatMap(([z, c]) => [h('span', null, z), h('b', { style: 'font-size:1.1rem' }, tally(c))]),
        h('span', null, 'Other ULDs'), h('b', { style: 'font-size:1.1rem' }, d.other)),
      h('ul', { class: 'rows' }, d.sessions.map(({ session: s, counts: c }) => h('li', null,
        h('div', { class: 'grow' },
          h('div', null, h('b', null, s.session_reference)),
          h('div', { class: 'small muted' }, `${s.zone_name}, ${fmtTime(s.started_at)}. ${STATUS[s.status]}`)),
        h('span', { class: 'small' }, tally(c, true)),
        h('button', { class: 'btn slim plain', onclick: async () => {
          const scans = (await db.byIndex('scans', 'session_id', s.session_id)).sort((a, b) => a.created_at.localeCompare(b.created_at));
          sessionView(ctx, { session: s, scans: () => scans, readOnly: true, title: 'Session details' });
        } }, 'View'))))));
  }
}
