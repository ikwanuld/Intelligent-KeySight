// Browser end-to-end against sheets/Code.gs running in the local imitation of
// Apps Script (tests/gas-harness.mjs): real app, real OCR, fake camera.
//   node tests/gas-harness.mjs 8771 &   VIDEOS=/tmp/videos node tests/e2e-sheets.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = await import('playwright').catch(() => createRequire(process.env.PLAYWRIGHT_DIR || '/opt/npm-tools/node_modules/')('playwright'));
const BASE = process.env.BASE || 'http://localhost:8766', GAS = process.env.GAS || 'http://localhost:8771';
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
const state = async () => (await fetch(GAS + '/_sheets')).json();
const table = async (name) => { const s = (await state()).sheets[name]; const h = s[0]; return s.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]]))); };

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-video-capture=${process.env.VIDEOS}/loop.mjpeg`] });
const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, permissions: ['camera'], hasTouch: true });
await ctx.addInitScript((g) => { localStorage.setItem('uld_api_base', g + '/exec'); localStorage.setItem('uld_api_kind', 'gas'); }, GAS);
const p = await ctx.newPage();
p.on('pageerror', (e) => { console.log('pageerror:', e.message); process.exitCode = 1; });
const waitTop = (v) => p.waitForFunction((v) => document.querySelector('.queue .card .uld.big')?.getAttribute('aria-label') === v, v, { timeout: 60000 });
const waitSync = (s) => p.waitForFunction((s) => document.querySelector('.sync')?.dataset.s === s, s, { timeout: 60000 });
const containers = (n) => p.waitForFunction((n) => document.querySelector('.counts b')?.textContent === String(n), n, { timeout: 30000 });

console.log('App + Google Sheets backend (imitated Apps Script)');
await p.goto(BASE + '/');
await p.fill('#email', 'stranger@company.test'); await p.click('text=Sign in'); await p.waitForSelector('text=Access denied');
await p.fill('#email', 'admin@company.test'); await p.click('text=Sign in'); await p.waitForSelector('text=Start a session');
ok('sign-in checked against the USERS sheet');

await p.selectOption('#station', 'stn-kul'); await p.click('text=Start scanning');
await waitTop('AKE79210R7'); await p.click('.queue .card >> text=Confirm'); await containers(1);
await waitTop('AKE1234AI'); await p.click('.queue .card >> text=Confirm'); await containers(2);
await waitTop('AKE5678A1'); await p.click('text=Accept suggestion'); await waitTop('AKE5678AI'); await p.click('.queue .card .btn.ok'); await containers(3);
await waitTop('AAY22222XX'); await p.click('text=Confirm anyway'); await containers(4);
await waitTop('AKE30303MH'); await p.click('.queue .card >> text=Reject');
await waitSync('SYNCED');
let scans = await table('SCANS');
assert.deepEqual(scans.map((s) => `${s.value}:${s.state}`).sort(), ['AAY22222XX:CONFIRMED', 'AKE1234AI:CONFIRMED', 'AKE30303MH:REJECTED', 'AKE5678AI:CONFIRMED', 'AKE79210R7:CONFIRMED', 'PMC12345MH:AUTO_SAVED']);
assert.equal(new Set(scans.map((s) => s.scan_id)).size, scans.length, 'one row per ULD, no duplicates after many updates');
const fixed = scans.find((s) => s.value === 'AKE5678AI');
assert.equal(fixed.raw_ocr, 'AKE5678A1'); assert.equal(fixed.station_code, 'KUL'); assert.equal(fixed.zone_name, 'Zone A');
assert.equal(scans.filter((s) => s.counted_as_container === 'TRUE').length, 4);
assert.equal((await table('CONFLICTS')).length, 0);
const st = await state();
assert.equal(st.files, (await table('IMAGES')).length); assert.ok(st.files >= 2);
assert.equal(scans.find((s) => s.value === 'AKE79210R7').image_reference, '');
ok('camera scans appear as rows in the SCANS sheet; crops only for problem scans, stored in Drive');

await ctx.setOffline(true);
await p.click('text=Add manually'); await p.fill('.uldinput', 'AKH9999SV'); await p.click('.sheet .btn.ok'); await containers(5);
await p.click('text=Complete session'); await p.click('.sheet >> text=Complete'); await p.waitForSelector('text=/Session .* completed/');
const local = (await p.evaluate(() => window.__uld.db.all('sessions')))[0];
assert.equal((await table('SESSIONS'))[0].status, 'IN_PROGRESS');
await ctx.setOffline(false); await waitSync('SYNCED');
const sess = await table('SESSIONS');
assert.equal(sess.length, 1); assert.equal(sess[0].status, 'COMPLETED'); assert.equal(sess[0].completed_at, local.completed_at);
assert.equal((await table('SCANS')).find((s) => s.value === 'AKH9999SV').manually_added, 'TRUE');
assert.equal((await table('CONFLICTS')).length, 0);
ok('offline scan + completion reach the sheet on reconnect with the original time');
await browser.close();
console.log(`\n${passed} checks passed`);
