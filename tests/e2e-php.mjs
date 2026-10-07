// Browser end-to-end against the real PHP + MySQL backend (cross-origin, like
// GitHub Pages -> your host): real app, real OCR, fake camera, real database.
//   VIDEOS=/tmp/videos API=http://localhost:8770/index.php DB="mariadb ... dbname" node tests/e2e-php.mjs
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = await import('playwright').catch(() => createRequire(process.env.PLAYWRIGHT_DIR || '/opt/npm-tools/node_modules/')('playwright'));
const BASE = process.env.BASE || 'http://localhost:8766', API = process.env.API || 'http://localhost:8770/index.php';
const sql = (q) => execSync(`${process.env.DB} -N -B -e ${JSON.stringify(q)}`).toString().trim();
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-video-capture=${process.env.VIDEOS}/loop.mjpeg`] });
const open = async () => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, permissions: ['camera'], hasTouch: true });
  await ctx.addInitScript((api) => localStorage.setItem('uld_api_base', api), API);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { console.log('pageerror:', e.message); process.exitCode = 1; });
  await p.goto(BASE + '/'); return { ctx, p };
};
const waitTop = (p, v) => p.waitForFunction((v) => document.querySelector('.queue .card .uld.big')?.getAttribute('aria-label') === v, v, { timeout: 60000 });
const waitSync = (p, s) => p.waitForFunction((s) => document.querySelector('.sync')?.dataset.s === s, s, { timeout: 60000 });
const containers = (p, n) => p.waitForFunction((n) => document.querySelector('.counts b')?.textContent === String(n), n, { timeout: 30000 });

console.log('App + PHP + MySQL');
const { ctx, p } = await open();
await p.fill('#email', 'stranger@company.test'); await p.click('text=Sign in');
await p.waitForSelector('text=Access denied');
await p.fill('#email', 'admin@company.test'); await p.click('text=Sign in');
await p.waitForSelector('text=Start a session');
ok('e-mail sign-in checked by the server whitelist');

await p.selectOption('#station', 'stn-kul');
await p.click('text=Start scanning');
await waitTop(p, 'AKE79210R7'); await p.click('.queue .card >> text=Confirm'); await containers(p, 1);
await waitTop(p, 'AKE1234AI'); await p.click('.queue .card >> text=Confirm'); await containers(p, 2);
await waitTop(p, 'AKE5678A1'); await p.click('text=Accept suggestion'); await waitTop(p, 'AKE5678AI'); await p.click('.queue .card .btn.ok'); await containers(p, 3);
await waitTop(p, 'AAY22222XX'); await p.click('text=Confirm anyway'); await containers(p, 4);
await waitTop(p, 'AKE30303MH'); await p.click('.queue .card >> text=Reject');
await p.waitForFunction(() => document.querySelectorAll('.counts b')[3].textContent === '1');
await waitSync(p, 'SYNCED');
assert.equal(sql("SELECT GROUP_CONCAT(CONCAT(value,':',state) ORDER BY value) FROM scan_records"),
  'AAY22222XX:CONFIRMED,AKE1234AI:CONFIRMED,AKE30303MH:REJECTED,AKE5678AI:CONFIRMED,AKE79210R7:CONFIRMED,PMC12345MH:AUTO_SAVED');
assert.equal(sql("SELECT CONCAT_WS('|',raw_ocr,suggested_correction,correction_accepted,validation_status) FROM scan_records WHERE value='AKE5678AI'"), 'AKE5678A1|AKE5678AI|1|VALID');
assert.equal(sql("SELECT CONCAT_WS('|',review_acknowledged,validation_status) FROM scan_records WHERE value='AAY22222XX'"), '1|NEEDS_REVIEW');
assert.equal(sql("SELECT CONCAT(category,'|',operational,'|',state) FROM scan_records WHERE value='PMC12345MH'"), 'PALLET|1|AUTO_SAVED');   // a countable type, but nobody confirmed it
assert.equal(sql('SELECT COUNT(*) FROM sync_conflicts'), '0');
assert.equal(sql('SELECT COUNT(*) FROM images'), sql('SELECT COUNT(*) FROM scan_records WHERE image_reference IS NOT NULL'));
assert.equal(sql("SELECT image_reference IS NULL FROM scan_records WHERE value='AKE79210R7'"), '1');
assert.ok(Number(sql('SELECT COUNT(*) FROM images')) >= 2 && Number(sql('SELECT MAX(bytes) FROM images')) < 60000);
assert.equal(sql("SELECT status FROM scan_sessions"), 'IN_PROGRESS');
assert.ok(Number(sql('SELECT COUNT(*) FROM device_analytics WHERE camera_resolution IS NOT NULL')) === 1);
ok('camera scans recorded in MySQL as they happen: states, corrections, review flags, crops only for problem scans');

await ctx.setOffline(true);
await p.click('text=Add manually'); await p.fill('.uldinput', 'AKH9999SV'); await p.click('.sheet .btn.ok'); await containers(p, 5);
await waitSync(p, 'PENDING');
await p.click('text=Complete session'); await p.click('.sheet >> text=Complete'); await p.waitForSelector('text=/Session .* completed/');
const local = (await p.evaluate(() => window.__uld.db.all('sessions')))[0];
assert.equal(sql("SELECT status FROM scan_sessions"), 'IN_PROGRESS', 'server has not heard yet');
await ctx.setOffline(false);
await waitSync(p, 'SYNCED');
assert.equal(sql("SELECT CONCAT(status,'|',DATE_FORMAT(completed_at,'%Y-%m-%dT%H:%i:%s.%f')) FROM scan_sessions"), `COMPLETED|${local.completed_at.replace('Z', '000')}`);
assert.equal(sql("SELECT CONCAT(manually_added,'|',source) FROM scan_records WHERE value='AKH9999SV'"), '1|MANUAL');
assert.equal(sql('SELECT COUNT(*) FROM sync_conflicts'), '0');
ok('offline scan + completion reach the database on reconnect with the original completion time');

await p.selectOption('#station', 'stn-kul'); await p.selectOption('#zone', { label: 'Zone B' }); await p.click('text=Start scanning'); await p.waitForSelector('.counts');
await p.click('text=Add manually'); await p.fill('.uldinput', 'AKE40404MH'); await p.click('.sheet .btn.ok'); await waitSync(p, 'SYNCED');
const b = await open();
await b.p.fill('#email', 'admin@company.test'); await b.p.click('text=Sign in');
await b.p.selectOption('#station', 'stn-kul'); await b.p.waitForSelector('text=Open sessions today'); await b.p.click('text=Resume'); await b.p.waitForSelector('.counts');
await b.p.waitForFunction(() => Number(document.querySelector('.counts b')?.textContent) >= 1);
await b.p.waitForFunction(() => document.querySelector('.sync')?.dataset.s === 'SYNCED', null, { timeout: 60000 });
assert.equal(sql("SELECT COUNT(*) FROM session_events WHERE type='SESSION_RESUMED'"), '1');
ok('a second device resumes the open session from the database');

assert.equal(sql("SELECT CONCAT(SUM(state='CONFIRMED' AND operational=1 AND category='CONTAINER'),'|',SUM(state='CONFIRMED' AND operational=1 AND category='PALLET'),'|',SUM(state='AUTO_SAVED')) FROM scan_sessions s JOIN scan_records r USING (session_id) WHERE s.zone_name='Zone A'"), '5|0|1');
ok('daily-activity query on the database matches the app (5 containers, 0 pallets, 1 other in Zone A)');
// From the second start on, the service worker makes the page "cross-origin
// isolated" (so the pallet reader may use threads). The API lives on another
// origin, so make sure it is still reachable from an isolated page.
await p.evaluate(() => navigator.serviceWorker.ready);
await p.reload(); await p.waitForSelector('text=Open sessions today');
assert.equal(await p.evaluate(() => self.crossOriginIsolated), true);
await p.click('text=Resume'); await p.waitForSelector('.counts');
await p.click('text=Add manually'); await p.fill('.uldinput', 'PMC82529R7'); await p.click('.sheet .btn.ok');
await p.waitForFunction(() => document.querySelectorAll('.counts b')[1].textContent === '1');
await waitSync(p, 'SYNCED');
assert.equal(sql("SELECT CONCAT(category,'|',operational,'|',state,'|',manually_added) FROM scan_records WHERE value='PMC82529R7'"), 'PALLET|1|CONFIRMED|1');
ok('API on another origin still works from the cross-origin isolated page; a pallet is stored as a pallet');

await browser.close();
console.log(`\n${passed} checks passed`);
