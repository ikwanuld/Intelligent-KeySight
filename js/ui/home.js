import { h, clear, syncChip, fmtTime } from './dom.js';
import { api } from '../api/client.js';
import { auth } from '../auth/auth.js';
import { db } from '../offline/db.js';
import { localDay, isOpen } from '../session/store.js';

export function homeScreen(root, ctx, { notice } = {}) {
  const user = auth.user, cfg = ctx.config(), store = ctx.store;
  const stations = cfg.stations.filter((s) => s.active && user.authorized_station_ids.includes(s.station_id));
  const chip = syncChip(ctx.sync);
  const page = h('div', { class: 'page' },
    h('div', { class: 'topline' }, h('h1', null, 'ULD Scanner'), chip),
    h('p', { class: 'muted' }, `Signed in as ${user.name}. `,
      h('button', { class: 'link', onclick: async () => { await auth.logout(); ctx.go('login'); } }, 'Sign out')));
  if (notice) page.append(h('p', { class: 'notice', role: 'status' }, notice));
  if (!api.enabled) page.append(h('p', { class: 'small muted' }, 'Demo mode: scans stay on this device.'));
  // Whether Pallets mode will work with no signal. Quiet once everything is in place.
  const reader = h('p', { class: 'small muted', role: 'status', hidden: true });
  const paintReader = () => {
    const r = ctx.palletReader;
    const text = r.state === 'downloading' ? `Pallet reader: downloading${r.total ? ` (${Math.round((100 * r.loaded) / r.total)}%)` : ''}. Keep the app open.`
      : r.state === 'missing' ? 'Pallet reader: not on this phone yet. It downloads (about 30 MB) the next time the app is opened with a connection.'
      : r.state === 'on-demand' ? 'Pallet reader: downloads (about 30 MB) the first time Pallets is opened. Do that once where there is a connection.'
      : '';
    reader.textContent = text; reader.hidden = !text;
  };
  paintReader();
  page.append(reader);
  clear(root).append(page);

  if (!stations.length) {
    page.append(h('div', { class: 'notice bad' }, h('h2', null, 'No operational access'),
      h('p', null, 'Your account has no station assigned yet. Ask your administrator to add one.')));
    return ctx.subscribe(() => { chip.paint(); paintReader(); });
  }

  // ---- start a session ----
  const stationSel = h('select', { id: 'station' }, stations.map((s) =>
    h('option', { value: s.station_id, selected: s.station_id === user.default_station_id }, `${s.station_code}  ${s.station_name}`)));
  const zoneSel = h('select', { id: 'zone' });
  const startBtn = h('button', { class: 'btn primary block' }, 'Start scanning');
  const station = () => stations.find((s) => s.station_id === stationSel.value);
  const fillZones = () => {
    const zones = station().zones.filter((z) => z.active);
    clear(zoneSel).append(...zones.map((z) => h('option', { value: z.zone_id }, z.zone_name)));
    startBtn.disabled = !zones.length;
  };
  stationSel.onchange = () => { fillZones(); loadOpen(); };
  startBtn.onclick = async () => {
    startBtn.disabled = true;
    const st = station(), zone = st.zones.find((z) => z.zone_id === zoneSel.value);
    await store.startSession({ station: st, zone });
    ctx.go('scanner');
  };
  page.append(h('div', { class: 'plate' },
    h('h2', { style: 'margin-bottom:.8rem' }, 'Start a session'),
    h('div', { class: 'field' }, h('label', { for: 'station' }, 'Station'), stationSel),
    h('div', { class: 'field' }, h('label', { for: 'zone' }, 'Zone'), zoneSel),
    startBtn));

  // ---- sessions that can be resumed today ----
  const openBox = h('div');
  page.append(openBox, h('button', { class: 'link', onclick: () => ctx.go('history') }, 'My history'));

  let token = 0;
  async function loadOpen() {
    const mine = ++token;
    const day = localDay();
    const local = (await db.byIndex('sessions', 'day', day)).filter((s) => isOpen(s) && store.canResume(s));
    let remote = [];
    if (api.enabled && navigator.onLine) {
      try { remote = (await api.openSessions(stationSel.value, day)).sessions || []; } catch { /* offline: local only */ }
    }
    if (mine !== token) return;
    const seen = new Set(local.map((s) => s.session_id));
    const rows = [...local.map((s) => ({ s, remote: false })), ...remote.filter((s) => !seen.has(s.session_id)).map((s) => ({ s, remote: true }))]
      .sort((a, b) => b.s.started_at.localeCompare(a.s.started_at));
    clear(openBox);
    if (!rows.length) return;
    openBox.append(h('h2', { class: 'section-h' }, 'Open sessions today'),
      h('ul', { class: 'rows' }, rows.map(({ s, remote: isRemote }) => h('li', null,
        h('div', { class: 'grow' },
          h('div', null, h('b', null, `${s.station_code} ${s.zone_name}`)),
          h('div', { class: 'small muted' }, `${s.session_reference}, started ${fmtTime(s.started_at)} by ${s.created_by_name || 'another user'}`)),
        h('button', { class: 'btn slim', onclick: async (e) => {
          e.target.disabled = true;
          try {
            if (isRemote) await store.importRemote(await api.session(s.session_id));
            await store.resume(s.session_id);
            ctx.go('scanner');
          } catch (err) { e.target.disabled = false; ctx.alert(err.code === 'NETWORK' ? 'This session is on another device and needs a connection to resume.' : err.message); }
        } }, 'Resume')))));
  }

  fillZones();
  loadOpen();
  return ctx.subscribe(() => { chip.paint(); paintReader(); });
}
