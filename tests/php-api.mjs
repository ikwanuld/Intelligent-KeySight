// Tests the PHP + MySQL backend directly over HTTP and checks what landed in
// the database.
//   API=http://localhost:8770/index.php  DB="mariadb -uuld -puldpass -h127.0.0.1 uld_test"  node tests/php-api.mjs
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { validate } from '../js/validation/validator.js';
import { suggest } from '../js/correction/corrector.js';

const API = process.env.API || 'http://localhost:8770/index.php';
const DB = process.env.DB;
const sql = (q) => execSync(`${DB} -N -B -e ${JSON.stringify(q)}`).toString().trim();
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
const call = async (method, path, { token, body, form, headers = {} } = {}) => {
  const h = { ...headers }; if (token) h.Authorization = `Bearer ${token}`; if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(API + path, { method, headers: h, body: form || (body ? JSON.stringify(body) : undefined) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, headers: res.headers };
};
const iso = (d) => new Date(d).toISOString();

console.log('PHP API');
assert.equal((await call('GET', '/health')).json.database, 'connected'); ok('health: database connected');
assert.equal((await call('GET', '/config')).status, 401); ok('no token is refused');

// ---- sign-in ----
let r = await call('POST', '/auth/email', { body: { email: 'someone@gmail.com' } });
assert.equal(r.json.error.code, 'DOMAIN_NOT_ALLOWED');
r = await call('POST', '/auth/email', { body: { email: 'stranger@company.test' } });
assert.equal(r.status, 403); assert.equal(r.json.error.code, 'NOT_WHITELISTED');
r = await call('POST', '/auth/email', { body: { email: 'Admin@Company.test', device_id: 'dev-a' } });
assert.equal(r.status, 200); const admin = r.json; assert.equal(admin.user.role, 'ADMIN'); assert.equal(admin.user.authorized_station_ids.length, 3);
sql("INSERT INTO users (user_id,email,name,default_station_id) VALUES ('u-pen','pen@company.test','Pen Staff','stn-pen'),('u-none','none@company.test','No Station',NULL); INSERT INTO user_stations VALUES ('u-pen','stn-pen');");
assert.equal((await call('POST', '/auth/email', { body: { email: 'none@company.test' } })).json.error.code, 'NO_STATION');
const pen = (await call('POST', '/auth/email', { body: { email: 'pen@company.test' } })).json;
assert.deepEqual(pen.user.authorized_station_ids, ['stn-pen']);
assert.equal(sql('SELECT COUNT(*) FROM auth_tokens WHERE LENGTH(token_hash)=64'), '2');
ok('sign-in: domain, whitelist, station checks; bootstrap admin; tokens stored hashed');

// ---- config ----
const cfg = (await call('GET', '/config', { token: admin.token })).json;
assert.equal(validate('AKE1234AI', cfg).status, 'VALID'); assert.equal(validate('AKE79210R7', cfg).status, 'VALID');
assert.equal(validate('AKE12345AI', cfg).status, 'INVALID'); assert.equal(validate('AKE12345XX', cfg).status, 'NEEDS_REVIEW');
assert.equal(validate('PMC12345MH', cfg).category, 'PALLET'); assert.equal(validate('PMC12345MH', cfg).operational, true, 'counted in Pallets mode');
assert.equal(validate('PAJ0606TRA', cfg).status, 'VALID', 'pallet with a 3-letter owner code');
assert.equal(validate('AKE0606TRA', cfg).status, 'INVALID', 'the 3-letter-owner rules are for pallet types only');
assert.deepEqual(cfg.scanModes.map((m) => `${m.mode}:${m.pipeline}`), ['CONTAINER:container', 'PALLET:pallet']);
assert.equal(suggest('AKE1234A1', cfg).suggestion, 'AKE1234AI');
assert.equal(cfg.stations.length, 3);
assert.deepEqual((await call('GET', '/config', { token: pen.token })).json.stations.map((s) => s.station_code), ['PEN']);
ok('config from the database drives the app\'s own validation engine; stations limited per user');

// ---- sync ----
const sid = randomUUID(), scanId = randomUUID(), evId = randomUUID();
const started = '2026-10-04T01:02:03.456Z';
const session = { session_id: sid, session_reference: 'KUL-20261004-T01', created_by: admin.user.user_id, station_id: 'stn-kul', station_code: 'KUL',
  zone_id: 'kul-a', zone_name: 'Zone A', day: '2026-10-04', started_at: started, completed_at: null, last_activity_at: started, status: 'IN_PROGRESS',
  device_id: 'dev-a', counters: { duplicates: 2, multi_scans: 1 }, rev: 1,
  device: { device_model: 'Pixel 7', os: 'Android', os_version: '14', browser: 'Chrome', browser_version: '129', camera_resolution: '1920x1080', screen_resolution: '1080x2400', performance_class: 'STANDARD' } };
const scan = { scan_id: scanId, session_id: sid, state: 'CONFIRMED', value: 'AKE5678AI', uld_number: 'AKE5678AI', raw_ocr: 'AKE5678A1', suggested_correction: 'AKE5678AI',
  correction_accepted: true, final_value: 'AKE5678AI', category: 'CONTAINER', prefix: 'AKE', operational: true, validation_status: 'VALID', confidence_status: 'HIGH',
  rule_id: 'rule-ai-sv', rule_version: 1, confirmed: true, confirmed_by: admin.user.user_id, confirmed_at: '2026-10-04T01:02:09.000Z', source: 'SINGLE', engine: 'tesseract',
  confidence: { overall: 96, min: 91, characters: [96, 97], detection: null, image_quality: 88 }, env: { lighting: 'GOOD', luma: 150 },
  timing: { first_seen_at: '2026-10-04T01:02:05.100Z', shown_at: '2026-10-04T01:02:05.600Z', ocr_ms: 180, frames: 2 }, flags: { disagreement: false },
  ocr_observations: [{ raw_text: 'AKE5678A1', frames: 2, overall_confidence: 96, character_confidence: [96, 97] }],
  history: [{ action: 'DETECTED', at: started }, { action: 'CONFIRMED', at: started }], created_by: admin.user.user_id, created_at: '2026-10-04T01:02:05.600Z', updated_at: '2026-10-04T01:02:09.000Z', rev: 2 };
const event = { event_id: evId, session_id: sid, type: 'SESSION_STARTED', user_id: admin.user.user_id, at: started, detail: {}, rev: 1 };
const op = (entity, id, data, base_rev = null) => ({ op_id: `${entity}:${id}:${data.rev}`, entity, entity_id: id, base_rev, data });
const push = async (ops, token = admin.token) => (await call('POST', '/sync', { token, body: { device_id: 'dev-a', ops } })).json.results;

let res = await push([op('session', sid, session), op('scan', scanId, scan), op('event', evId, event)]);
assert.deepEqual(res.map((x) => [x.status, x.server_rev]), [['applied', 1], ['applied', 1], ['applied', 1]]);
assert.equal(sql(`SELECT CONCAT_WS('|', uld_number, raw_ocr, correction_accepted, overall_confidence, lighting, ocr_ms, rule_id, DATE_FORMAT(confirmed_at,'%Y-%m-%dT%H:%i:%s.%f')) FROM scan_records WHERE scan_id='${scanId}'`),
  'AKE5678AI|AKE5678A1|1|96|GOOD|180|rule-ai-sv|2026-10-04T01:02:09.000000');
assert.equal(sql(`SELECT CONCAT_WS('|', station_code, zone_name, day, duplicates_count, DATE_FORMAT(started_at,'%H:%i:%s.%f')) FROM scan_sessions WHERE session_id='${sid}'`), 'KUL|Zone A|2026-10-04|2|01:02:03.456000');
assert.equal(sql(`SELECT CONCAT(device_model,'|',camera_resolution) FROM device_analytics WHERE session_id='${sid}'`), 'Pixel 7|1920x1080');
assert.equal(sql(`SELECT raw_text FROM ocr_observations WHERE scan_id='${scanId}'`), 'AKE5678A1');
ok('session, scan, event recorded in real columns with the device\'s own timestamps');

res = await push([op('scan', scanId, scan)]);
assert.equal(res[0].status, 'duplicate'); assert.equal(sql('SELECT COUNT(*) FROM scan_records'), '1'); ok('retries are idempotent');

res = await push([op('session', sid, { ...session, rev: 2, status: 'COMPLETED', completed_at: '2026-10-04T02:00:00.000Z' }, 1)]);
assert.deepEqual([res[0].status, res[0].server_rev], ['applied', 2]);
assert.equal(sql(`SELECT status FROM scan_sessions WHERE session_id='${sid}'`), 'COMPLETED'); ok('update with the right revision is applied');

res = await push([op('session', sid, { ...session, rev: 3, zone_name: 'STALE EDIT' }, 1)]);
assert.equal(res[0].status, 'conflict'); assert.equal(res[0].server_data.status, 'COMPLETED');
assert.equal(sql(`SELECT zone_name FROM scan_sessions WHERE session_id='${sid}'`), 'Zone A');
assert.equal(sql("SELECT CONCAT(COUNT(*),'|',MAX(JSON_VALUE(incoming_data,'$.zone_name'))) FROM sync_conflicts"), '1|STALE EDIT');
assert.equal((await push([op('session', sid, { ...session, rev: 3, zone_name: 'STALE EDIT' }, 1)]))[0].status, 'conflict');
assert.equal(sql('SELECT COUNT(*) FROM sync_conflicts'), '1');
ok('stale update is a conflict: server row untouched, both versions kept, replay does not duplicate it');

const bad = { ...scan, scan_id: randomUUID(), value: 'AKE123', final_value: 'AKE123', uld_number: 'AKE123', rev: 1 };
res = await push([op('scan', bad.scan_id, bad)]);
assert.equal(res[0].status, 'rejected'); assert.match(res[0].reason, /validation rule/);
const pend = { ...scan, scan_id: randomUUID(), state: 'PENDING', value: 'AKE12X4', final_value: null, uld_number: null, confirmed: false, validation_status: 'INVALID', rev: 1 };
assert.equal((await push([op('scan', pend.scan_id, pend)]))[0].status, 'applied');
ok('an invalid ULD can never be stored as confirmed (but an unresolved pending read is kept)');

assert.equal((await push([op('scan', randomUUID(), { ...scan, scan_id: randomUUID(), rev: 1 })], pen.token))[0].reason, 'station not authorized for this user');
assert.equal((await push([op('session', randomUUID(), { ...session, session_id: randomUUID() })], pen.token))[0].status, 'rejected');
assert.equal((await push([op('scan', randomUUID(), { ...scan, session_id: randomUUID(), rev: 1 })]))[0].reason, 'unknown session');
assert.equal((await push([{ op_id: 'x', entity: 'user', entity_id: 'nope', data: {} }]))[0].status, 'rejected');
ok('station authorization enforced on every record; malformed ops refused');

// ---- images ----
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=', 'base64');
const form = (file, type) => { const f = new FormData(); const ref = randomUUID(); f.append('image_reference', ref); f.append('scan_id', scanId); f.append('session_id', sid); f.append('captured_at', started); f.append('file', new Blob([file], { type }), 'c.jpg'); return { f, ref }; };
let up = form(jpeg, 'image/jpeg');
r = await call('POST', '/images', { token: admin.token, form: up.f });
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.equal(sql(`SELECT CONCAT(storage_key,'|',DATEDIFF(expires_at,captured_at)) FROM images WHERE image_reference='${up.ref}'`), `2026-10/${up.ref}.jpg|30`);
assert.equal((await call('POST', '/images', { token: admin.token, form: form(Buffer.from('not an image'), 'image/jpeg').f })).status, 415);
assert.equal((await call('POST', '/images', { token: pen.token, form: form(jpeg, 'image/jpeg').f })).status, 403);
ok('crop stored on disk with a retention date; non-images and other stations refused');

// ---- sessions for resume ----
const s2 = randomUUID();
await push([op('session', s2, { ...session, session_id: s2, session_reference: 'KUL-20261001-T02', zone_id: 'kul-b', zone_name: 'Zone B', day: '2026-10-01' }),
  op('scan', randomUUID(), { ...scan, scan_id: randomUUID(), session_id: s2, value: 'AKE79210R7', final_value: 'AKE79210R7', uld_number: 'AKE79210R7', rule_id: 'rule-standard', rev: 1 })]);
r = await call('GET', '/sessions?station_id=stn-kul&day=2026-10-01&open=1', { token: admin.token });
assert.deepEqual(r.json.sessions.map((s) => s.session_reference), ['KUL-20261001-T02']);
r = await call('GET', `/sessions/${s2}`, { token: admin.token });
assert.equal(r.json.scans[0].value, 'AKE79210R7'); assert.equal(r.json.session.server_rev, 1);
assert.equal((await call('GET', `/sessions/${s2}`, { token: pen.token })).status, 403);
ok('open sessions listed and fetched for resume, limited to authorized stations');

// ---- CORS ----
r = await call('OPTIONS', '/sync', { headers: { Origin: 'http://localhost:8766', 'Access-Control-Request-Method': 'POST' } });
assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:8766');
r = await call('OPTIONS', '/sync', { headers: { Origin: 'https://evil.example' } });
assert.equal(r.headers.get('access-control-allow-origin'), null);
ok('only the configured scanner address may call the API from a browser');

// ---- housekeeping ----
const cron = API.replace(/index\.php$/, 'cron.php');
assert.equal((await fetch(cron + '?key=wrong')).status, 403);
sql(`UPDATE images SET expires_at='2020-01-01' WHERE image_reference='${up.ref}'`);
const out = await (await fetch(cron + '?key=test-cron-key-123')).text();
assert.match(out, /sessions auto-completed: 1\nimages purged: 1/);
assert.equal(sql(`SELECT CONCAT(status,'|',completion_type,'|',TIME(completed_at)) FROM scan_sessions WHERE session_id='${s2}'`), 'AUTO_COMPLETED|AUTO|23:59:59.999');
assert.equal(sql('SELECT COUNT(*) FROM scan_records'), '3', 'scan data untouched');
ok('daily job: stale open session auto-completed, expired crop deleted, scans kept');

await call('POST', '/auth/logout', { token: pen.token });
assert.equal((await call('GET', '/auth/me', { token: pen.token })).status, 401);
sql("UPDATE users SET active=0 WHERE user_id='" + admin.user.user_id + "'");
assert.equal((await call('GET', '/auth/me', { token: admin.token })).json.error.code, 'NOT_WHITELISTED');
ok('sign-out revokes the token; a deactivated user is locked out immediately');
console.log(`\n${passed} checks passed`);
