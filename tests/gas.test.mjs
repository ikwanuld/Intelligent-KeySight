// Logic tests for the Google Sheets backend (sheets/Code.gs), run with:  npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadGas } from './gas-harness.mjs';
import { validate } from '../js/validation/validator.js';

const gas = loadGas(); gas.ctx.setup();
const sheet = (n) => gas.dump()[n].slice(1);
const col = (n, name) => gas.dump()[n][0].indexOf(name);
const call = (method, path, extra = {}) => gas.call({ method, path, ...extra });
const login = (email) => call('POST', '/auth/email', { body: { email } });
gas.dump().USERS.push(['pen@company.test', 'Pen Staff', 'STAFF', 'PEN', 'PEN', 'TRUE'], ['off@company.test', 'Off', 'STAFF', 'KUL', 'KUL', 'FALSE'], ['lost@company.test', 'Lost', 'STAFF', 'XXX', 'XXX', 'TRUE']);
const admin = login('Admin@Company.test').body, pen = login('pen@company.test').body;

const sid = randomUUID(), scanId = randomUUID();
const session = { session_id: sid, session_reference: 'KUL-20261004-T01', created_by: 'admin@company.test', station_id: 'stn-kul', station_code: 'KUL',
  zone_id: 'kul-zone-a', zone_name: 'Zone A', day: '2026-10-04', started_at: '2026-10-04T01:02:03.456Z', status: 'IN_PROGRESS', device_id: 'dev-a',
  counters: { duplicates: 2 }, device: { device_model: 'Pixel 7' }, rev: 1 };
const scan = { scan_id: scanId, session_id: sid, state: 'CONFIRMED', value: 'AKE5678AI', uld_number: 'AKE5678AI', raw_ocr: 'AKE5678A1', suggested_correction: 'AKE5678AI',
  correction_accepted: true, final_value: 'AKE5678AI', category: 'CONTAINER', operational: true, validation_status: 'VALID', confidence_status: 'HIGH',
  rule_id: 'rule-ai-sv', rule_version: 1, confirmed_at: '2026-10-04T01:02:09.000Z', source: 'SINGLE', confidence: { overall: 96 }, env: { lighting: 'GOOD' },
  created_at: '2026-10-04T01:02:05.600Z', rev: 2 };
const op = (entity, id, data, base_rev = null) => ({ op_id: `${entity}:${id}:${data.rev}`, entity, entity_id: id, base_rev, data });
const push = (ops, token = admin.token) => call('POST', '/sync', { token, body: { device_id: 'dev-a', ops } }).body.results;

test('setup creates every sheet and makes the person who ran it admin', () => {
  assert.deepEqual(Object.keys(gas.dump()).sort(), ['CONFIG', 'CONFLICTS', 'EVENTS', 'IMAGES', 'SCANS', 'SESSIONS', 'STATIONS', 'USERS', 'ZONES']);
  assert.equal(admin.user.role, 'ADMIN'); assert.equal(admin.user.authorized_station_ids.length, 3);
  gas.ctx.setup(); assert.equal(sheet('STATIONS').length, 3, 'running setup again does not duplicate');
});

test('sign-in: whitelist, inactive, no station, bad token', () => {
  assert.equal(login('stranger@company.test').body.error.code, 'NOT_WHITELISTED');
  assert.equal(login('off@company.test').body.error.code, 'NOT_WHITELISTED');
  assert.equal(login('lost@company.test').body.error.code, 'NO_STATION');
  assert.deepEqual(pen.user.authorized_station_ids, ['stn-pen']);
  assert.equal(call('GET', '/config').status, 401);
  assert.equal(call('GET', '/config', { token: admin.token.slice(0, -2) + 'xx' }).status, 401, 'tampered token');
  assert.equal(call('GET', '/auth/me', { token: admin.token }).body.user.email, 'admin@company.test');
});

test('config from the sheet drives the app validation engine; stations per user', () => {
  const cfg = call('GET', '/config', { token: admin.token }).body;
  assert.equal(validate('AKE1234AI', cfg).status, 'VALID'); assert.equal(validate('AKE79210R7', cfg).status, 'VALID');
  assert.equal(validate('AKE12345AI', cfg).status, 'INVALID');
  assert.equal(validate('PMC12345MH', cfg).category, 'PALLET'); assert.equal(validate('PMC12345MH', cfg).operational, true, 'counted in Pallets mode');
  assert.equal(validate('PAJ0606TRA', cfg).status, 'VALID', 'pallet with a 3-letter owner code');
  assert.deepEqual(cfg.scanModes.map((m) => m.mode), ['CONTAINER', 'PALLET']);
  assert.equal(cfg.stations.find((s) => s.station_code === 'KUL').zones.length, 3);
  assert.deepEqual(call('GET', '/config', { token: pen.token }).body.stations.map((s) => s.station_code), ['PEN']);
});

test('sync writes readable rows, keeps device timestamps, and is safe to retry', () => {
  const ev = { event_id: randomUUID(), session_id: sid, type: 'SESSION_STARTED', user_id: 'admin@company.test', at: session.started_at, rev: 1 };
  let r = push([op('session', sid, session), op('scan', scanId, scan), op('event', ev.event_id, ev), op('event', ev.event_id, ev)]);
  assert.deepEqual(r.map((x) => x.status), ['applied', 'applied', 'applied', 'duplicate']);
  const row = sheet('SCANS')[0];
  assert.equal(row[col('SCANS', 'uld_number')], 'AKE5678AI'); assert.equal(row[col('SCANS', 'station_code')], 'KUL');
  assert.equal(row[col('SCANS', 'zone_name')], 'Zone A'); assert.equal(row[col('SCANS', 'counted_as_container')], 'TRUE');
  assert.equal(row[col('SCANS', 'confirmed_at')], '2026-10-04T01:02:09.000Z'); assert.equal(row[col('SCANS', 'raw_ocr')], 'AKE5678A1');
  assert.equal(sheet('SESSIONS')[0][col('SESSIONS', 'started_at')], '2026-10-04T01:02:03.456Z');
  assert.equal(push([op('scan', scanId, scan)])[0].status, 'duplicate');
  assert.equal(sheet('SCANS').length, 1); assert.equal(sheet('EVENTS').length, 1);
});

test('update, then conflict: nothing overwritten, both versions logged', () => {
  let r = push([op('session', sid, { ...session, rev: 2, status: 'COMPLETED', completed_at: '2026-10-04T02:00:00.000Z' }, 1)]);
  assert.deepEqual([r[0].status, r[0].server_rev], ['applied', 2]);
  assert.equal(sheet('SESSIONS').length, 1); assert.equal(sheet('SESSIONS')[0][col('SESSIONS', 'status')], 'COMPLETED');
  r = push([op('session', sid, { ...session, rev: 3, zone_name: 'STALE EDIT' }, 1)]);
  assert.equal(r[0].status, 'conflict'); assert.equal(r[0].server_data.status, 'COMPLETED');
  assert.equal(sheet('SESSIONS')[0][col('SESSIONS', 'zone_name')], 'Zone A');
  assert.equal(sheet('CONFLICTS').length, 1); assert.match(sheet('CONFLICTS')[0][6], /STALE EDIT/);
});

test('invalid or unauthorized records are refused', () => {
  const bad = { ...scan, scan_id: randomUUID(), value: 'AKE123', final_value: 'AKE123', rev: 1 };
  assert.match(push([op('scan', bad.scan_id, bad)])[0].reason, /validation rule/);
  const pend = { ...scan, scan_id: randomUUID(), state: 'PENDING', value: 'AKE12X4', final_value: null, rev: 1 };
  assert.equal(push([op('scan', pend.scan_id, pend)])[0].status, 'applied');
  assert.equal(sheet('SCANS')[1][col('SCANS', 'counted_as_container')], 'FALSE');
  assert.equal(push([op('scan', randomUUID(), { ...scan, scan_id: randomUUID(), rev: 1 })], pen.token)[0].reason, 'station not authorized for this user');
  assert.equal(push([op('session', randomUUID(), { ...session, session_id: randomUUID() })], pen.token)[0].status, 'rejected');
  assert.equal(push([op('scan', randomUUID(), { ...scan, session_id: randomUUID(), rev: 1 })])[0].reason, 'unknown session');
});

test('a mixed batch of new and changed rows lands in the right rows', () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const mk = (id, v, rev = 1, extra = {}) => ({ ...scan, scan_id: id, value: v, final_value: v, uld_number: v, rule_id: 'rule-standard', rev, ...extra });
  push([op('scan', ids[0], mk(ids[0], 'AKE00001MH')), op('scan', ids[1], mk(ids[1], 'AKE00002MH'))]);
  const r = push([op('scan', ids[2], mk(ids[2], 'AKE00003MH')), op('scan', ids[0], mk(ids[0], 'AKE00001MH', 2, { state: 'REJECTED' }), 1),
    op('scan', ids[2], mk(ids[2], 'AKE00003MH', 2, { manually_corrected: true }), 1)]);
  assert.deepEqual(r.map((x) => [x.status, x.server_rev]), [['applied', 1], ['applied', 2], ['applied', 2]]);
  const by = Object.fromEntries(sheet('SCANS').map((x) => [x[0], x]));
  assert.equal(Object.keys(by).length, sheet('SCANS').length, 'no duplicated rows');
  assert.equal(by[ids[0]][col('SCANS', 'state')], 'REJECTED'); assert.equal(by[ids[1]][col('SCANS', 'value')], 'AKE00002MH');
  assert.equal(by[ids[2]][col('SCANS', 'manually_corrected')], 'TRUE'); assert.equal(by[ids[2]][1], '2');
});

test('resume: open sessions and one session with its scans', () => {
  const s2 = randomUUID();
  push([op('session', s2, { ...session, session_id: s2, session_reference: 'KUL-T02', zone_name: 'Zone B' }),
    op('scan', randomUUID(), { ...scan, scan_id: randomUUID(), session_id: s2, value: 'AKE79210R7', final_value: 'AKE79210R7', rule_id: 'rule-standard', rev: 1 })]);
  const list = call('GET', '/sessions', { token: admin.token, query: { station_id: 'stn-kul', day: '2026-10-04' } }).body.sessions;
  assert.deepEqual(list.map((s) => s.session_reference), ['KUL-T02']);
  const one = call('GET', `/sessions/${s2}`, { token: admin.token }).body;
  assert.equal(one.scans[0].value, 'AKE79210R7'); assert.equal(one.session.server_rev, 1);
  assert.equal(call('GET', `/sessions/${s2}`, { token: pen.token }).status, 403);
});

test('crop goes to Drive, only its file id to the sheet', () => {
  const ref = randomUUID();
  const r = call('POST', '/images', { token: admin.token, body: { image_reference: ref, scan_id: scanId, session_id: sid, captured_at: 'x', data_base64: Buffer.from('jpegbytes').toString('base64') } });
  assert.equal(r.body.image_reference, ref); assert.equal(gas.files.length, 1);
  assert.equal(sheet('IMAGES')[0][col('IMAGES', 'drive_file_id')], 'file-1');
  call('POST', '/images', { token: admin.token, body: { image_reference: ref, data_base64: 'eA==' } });
  assert.equal(gas.files.length, 1, 'same crop is not stored twice');
});

test('removing someone from USERS locks them out at once', () => {
  gas.dump().USERS.find((u) => u[0] === 'pen@company.test')[5] = 'FALSE';
  assert.equal(call('GET', '/auth/me', { token: pen.token }).body.error.code, 'NOT_WHITELISTED');
});

test('upgradePallets brings a CONFIG tab from before Pallets mode up to date without losing anything', () => {
  const g = loadGas(); g.ctx.setup();
  const cfgRows = g.dump().CONFIG;
  const row = (k) => cfgRows.find((r) => r[0] === k);
  const get = (k) => JSON.parse(row(k)[1]);
  // Make it look like an old Sheet, with one thing the admin added by hand.
  row('prefixes')[1] = JSON.stringify(get('prefixes').map((p) => (p.category === 'PALLET' ? { ...p, operational: false } : p)));
  row('operatorCodes')[1] = JSON.stringify(['AK', 'D7', 'R7', 'MYOWN']);
  row('validationRules')[1] = JSON.stringify(get('validationRules').filter((r) => !r.rule_id.startsWith('rule-pallet')));
  row('correctionRules')[1] = JSON.stringify(get('correctionRules').filter((r) => r.source_character !== 'Z' && r.source_character !== '2'));
  const before = { rules: get('validationRules').length };

  g.ctx.upgradePallets(); g.ctx.upgradePallets();          // twice: must not duplicate
  assert.ok(get('prefixes').filter((p) => p.category === 'PALLET').every((p) => p.operational));
  assert.ok(['MYOWN', 'R9', 'C6', 'TG', 'EK', 'TRA'].every((c) => get('operatorCodes').includes(c)));
  assert.equal(get('operatorCodes').filter((c) => c === 'R7').length, 1);
  assert.equal(get('validationRules').length, before.rules + 2);
  assert.equal(get('correctionRules').filter((r) => r.source_character === 'Z').length, 1);

  // The scanner now gets a configuration under which a 3-letter-owner pallet is valid and countable.
  const token = g.call({ method: 'POST', path: '/auth/email', body: { email: 'admin@company.test' } }).body.token;
  const cfg = g.call({ method: 'GET', path: '/config', token }).body;
  assert.deepEqual(cfg.scanModes.map((m) => m.mode), ['CONTAINER', 'PALLET']);
  const v = validate('PAJ0606TRA', cfg, Date.parse('2026-10-07T00:00:00Z'));
  assert.equal(v.status, 'VALID'); assert.equal(v.operational, true);
});

test('SCANS sheet: a confirmed pallet is not counted as a container', () => {
  const g = loadGas(); g.ctx.setup();
  const token = g.call({ method: 'POST', path: '/auth/email', body: { email: 'admin@company.test' } }).body.token;
  const id = randomUUID(), a = randomUUID(), b = randomUUID();
  const s = { ...session, session_id: id, rev: 1 };
  const mk = (scan_id, value, category) => ({ ...scan, scan_id, session_id: id, value, uld_number: value, final_value: value, raw_ocr: value, suggested_correction: null,
    category, operational: true, rule_id: 'rule-standard', rev: 1 });
  const res = g.call({ method: 'POST', path: '/sync', token, body: { device_id: 'dev-a', ops: [op('session', id, s), op('scan', a, mk(a, 'PMC82529R7', 'PALLET')), op('scan', b, mk(b, 'AKE12345MH', 'CONTAINER'))] } }).body.results;
  assert.deepEqual(res.map((r) => r.status), ['applied', 'applied', 'applied']);
  const head = g.dump().SCANS[0], rows = g.dump().SCANS.slice(1);
  const cell = (value, name) => rows.find((r) => r[head.indexOf('value')] === value)[head.indexOf(name)];
  assert.equal(cell('PMC82529R7', 'counted_as_container'), 'FALSE'); assert.equal(cell('PMC82529R7', 'category'), 'PALLET');
  assert.equal(cell('AKE12345MH', 'counted_as_container'), 'TRUE');
});
