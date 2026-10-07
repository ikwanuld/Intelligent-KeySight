// End-to-end test: real app, real OCR, fake camera, mock backend.
//   node tests/serve.mjs 8766 &
//   sh tests/make_videos.sh /tmp/videos
//   VIDEOS=/tmp/videos node tests/e2e.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
// `npm i -D playwright` in this folder, or point PLAYWRIGHT_DIR at an existing install.
const { chromium } = await import('playwright').catch(() => createRequire(process.env.PLAYWRIGHT_DIR || '/opt/npm-tools/node_modules/')('playwright'));

const BASE = process.env.BASE || 'http://localhost:8766';
const V = process.env.VIDEOS || '.';
const SHOTS = process.env.SHOTS;
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };
// Offline for real: the browser context AND the test server (see tests/serve.mjs).
const offline = async (ctx, on) => { if (on) await ctx.setOffline(true); await fetch(`${BASE}/__net?down=${on ? 1 : 0}`); if (!on) await ctx.setOffline(false); };
const api = async (path, body) => (await fetch(`${BASE}/api${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined)).json();

async function open(video, { apiMode = true, browser = null } = {}) {
  browser = browser || await chromium.launch({ executablePath: process.env.CHROME || undefined, args: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${V}/${video}.mjpeg`] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, permissions: ['camera'], hasTouch: true });
  if (apiMode) await ctx.addInitScript(() => { localStorage.setItem('uld_api_base', '/api'); localStorage.setItem('uld_auth_mode', 'oauth'); });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { console.log('pageerror:', e.message); process.exitCode = 1; });
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) console.log('console:', m.text()); });
  await p.goto(BASE + '/');
  return { browser, ctx, p };
}
const login = async (p) => { await p.click('text=Sign in with Google'); await p.waitForSelector('text=Start a session'); };
const top = (p) => p.getAttribute('.queue .card .uld.big', 'aria-label').catch(() => null);
const waitTop = (p, v, timeout = 60000) => p.waitForFunction((v) => document.querySelector('.queue .card .uld.big')?.getAttribute('aria-label') === v, v, { timeout });
// Tiles on the scanner: [containers, pallets, pending, rejected]. "Other ULDs" is in the session view.
const counts = (p) => p.$$eval('.counts b', (els) => els.map((e) => Number(e.textContent)));
const otherCount = (p) => p.evaluate(() => window.__uld.ctx.store.counts().other);
const scans = (p) => p.evaluate(() => window.__uld.db.all('scans'));
const waitSync = (p, state, timeout = 30000) => p.waitForFunction((s) => document.querySelector('.sync')?.dataset.s === s, state, { timeout });
const until = async (fn, timeout = 30000) => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > timeout) throw new Error('timed out waiting: ' + fn); await new Promise((r) => setTimeout(r, 250)); } };
const shot = (p, name) => SHOTS && p.screenshot({ path: `${SHOTS}/${name}.png` });

// ───────────────────────────────────────────── 1. full scanning flow ──
console.log('1. Sign-in, scanning, confirmation, correction, offline');
{
  const { browser, ctx, p } = await open('loop');
  await p.click('text=Sign in with Microsoft');
  await p.waitForSelector('text=Access denied');
  assert.match(await p.textContent('.notice.bad'), /not authorized to use ULD Scanner/);
  ok('account not on the whitelist is refused');
  await login(p); ok('redirect sign-in completes');

  await p.click('text=Start scanning');
  await waitTop(p, 'AKE79210R7'); await shot(p, 'e2e-card');
  assert.match(await p.textContent('.queue .card'), /High confidence/);
  assert.equal(await p.locator('.queue .card >> text=/\\d+ ?%/').count(), 0, 'no raw percentages shown to staff');
  await p.click('.queue .card >> text=Confirm');
  await p.waitForSelector('.flash');
  await p.waitForFunction(() => document.querySelector('.counts b').textContent === '1'); ok('no-button detection, confirm by tap');

  await waitTop(p, 'AKE1234AI');
  const box = await (await p.$('.queue .card .head')).boundingBox();
  await p.mouse.move(box.x + 40, box.y + 20); await p.mouse.down();
  await p.mouse.move(box.x + 120, box.y + 22, { steps: 4 }); await p.mouse.move(box.x + 220, box.y + 22, { steps: 4 }); await p.mouse.up();
  await p.waitForFunction(() => document.querySelector('.counts b').textContent === '2');
  ok('swipe right confirms');

  await until(async () => (await scans(p)).some((s) => s.value === 'PMC12345MH' && s.state === 'AUTO_SAVED'));
  assert.notEqual(await top(p), 'PMC12345MH');
  assert.equal((await counts(p))[1], 0, 'not counted as a pallet: nobody confirmed it');
  assert.equal(await otherCount(p), 1);
  ok('pallet seen while scanning containers is saved silently as Other ULD, no popup');

  await waitTop(p, 'AKE5678A1');
  assert.match(await p.textContent('.queue .card .sugg'), /Did you mean/);
  assert.equal(await p.getAttribute('.queue .card .sugg .uld', 'aria-label'), 'AKE5678AI');
  assert.equal(await p.locator('.queue .card .btn.ok').count(), 0, 'cannot confirm an invalid reading');
  await shot(p, 'e2e-suggestion');
  await p.click('text=Accept suggestion'); await waitTop(p, 'AKE5678AI');
  await p.click('.queue .card .btn.ok');
  await p.waitForFunction(() => document.querySelector('.counts b').textContent === '3');
  ok('correction is offered, not applied; accepted by staff');

  await waitTop(p, 'AAY22222XX');
  assert.match(await p.textContent('.queue .card'), /Needs review[\s\S]*Unknown airline\/operator code/);
  await shot(p, 'e2e-review');
  await p.click('text=Confirm anyway');
  await p.waitForFunction(() => document.querySelector('.counts b').textContent === '4');
  ok('needs-review item confirmed with acknowledgement');

  await waitTop(p, 'AKE30303MH');
  await p.click('.queue .card >> text=Reject');
  await p.waitForFunction(() => document.querySelectorAll('.counts b')[3].textContent === '1');
  ok('reject moves the item to Rejected');

  await p.waitForSelector('.toast:not([hidden]) >> text=/Already scanned|Rejected earlier/', { timeout: 60000 });
  await shot(p, 'e2e-duplicate');
  assert.equal((await counts(p))[2], 0, 'duplicates are not queued');
  ok('duplicate shows a toast and is not added');

  // manual entry
  await p.click('text=Add manually');
  await p.fill('.uldinput', 'akh 9999 sv');
  assert.equal(await p.inputValue('.uldinput'), 'AKH9999SV');
  await p.waitForSelector('text=Valid ULD number');
  await p.click('.sheet .btn.ok');
  await p.waitForFunction(() => document.querySelector('.counts b').textContent === '5');
  await p.click('text=Add manually');
  await p.fill('.uldinput', 'AKE1234A1');
  await p.waitForSelector('text=Already scanned in this session');
  await p.fill('.uldinput', 'AKE1111A1');
  await p.waitForSelector('.sheet >> text=Did you mean');
  assert.equal(await p.inputValue('.uldinput'), 'AKE1111A1', 'typed text is not overwritten');
  assert.equal(await p.isDisabled('.sheet .btn.ok'), true);
  await shot(p, 'e2e-manual');
  await p.click('.sheet >> text=Accept suggestion');
  assert.equal(await p.inputValue('.uldinput'), 'AKE1111AI');
  await p.click('.sheet .btn.ok');
  await p.waitForFunction(() => document.querySelector('.counts b').textContent === '6');
  ok('manual entry: uppercase, live validation, duplicate check, suggestion-only correction');

  // rejected item recovery
  await p.click('.counts');
  await p.waitForSelector('text=Rejected / Review'); await shot(p, 'e2e-session');
  await p.click('.full >> text=Edit');
  await p.fill('.uldinput', 'AKE30304MH');
  await p.click('.sheet .btn.ok');
  await p.waitForFunction(() => !document.body.textContent.includes('Rejected / Review'));
  await p.click('.full >> text=Close');
  assert.deepEqual((await counts(p)).filter((_, i) => i !== 2), [7, 0, 0]);
  assert.equal(await otherCount(p), 1);
  ok('rejected item edited and confirmed');

  // records
  const all = await scans(p);
  const by = (v) => all.find((s) => s.value === v);
  assert.equal(by('AKE5678AI').raw_ocr, 'AKE5678A1'); assert.equal(by('AKE5678AI').correction_accepted, true);
  assert.equal(by('AAY22222XX').review_acknowledged, true); assert.equal(by('AAY22222XX').validation_status, 'NEEDS_REVIEW');
  assert.equal(by('AKE30304MH').manually_corrected, true); assert.equal(by('AKE30304MH').raw_ocr, 'AKE30303MH');
  assert.deepEqual(by('AKE30304MH').history.map((x) => x.action), ['DETECTED', 'REJECTED', 'EDITED', 'CONFIRMED_AFTER_REJECT']);
  assert.equal(by('AKH9999SV').manually_added, true);
  assert.equal(by('AKE1111AI').manual_input, 'AKE1111A1');
  assert.equal(by('PMC12345MH').state, 'AUTO_SAVED'); assert.equal(by('PMC12345MH').category, 'PALLET');
  assert.equal(by('AKE79210R7').image_reference, null, 'clean confident scan keeps no image');
  assert.ok(by('AKE5678AI').image_reference && by('AKE30304MH').image_reference, 'problem scans keep a crop');
  assert.ok(all.every((s) => s.rule_id || s.state !== 'CONFIRMED'), 'rule version recorded');
  ok('scan records carry raw OCR, suggestion, final value, flags and history');

  await waitSync(p, 'SYNCED');
  let st = await api('/_state');
  assert.equal(st.sessions.length, 1); assert.equal(st.scans.length, all.length);
  assert.equal(st.images.length, all.filter((s) => s.image_reference).length);
  assert.ok(st.images.every((i) => i.bytes < 60000), 'only small crops are uploaded');
  ok(`background sync: ${st.scans.length} scans, ${st.images.length} crops on server`);

  // crash recovery
  await p.reload(); await p.waitForSelector('text=Open sessions today');
  await p.click('text=Resume'); await p.waitForSelector('.counts');
  assert.deepEqual((await counts(p)).filter((_, i) => i !== 2), [7, 0, 0]);
  assert.equal(await otherCount(p), 1);
  ok('session survives a reload and can be resumed');

  // offline
  await p.evaluate(() => navigator.serviceWorker.ready);
  await until(() => p.evaluate(async (n) => { const k = (await caches.keys()).find((x) => x.startsWith('uld-scanner-')); return !!k && (await (await caches.open(k)).keys()).length >= n; }, 40), 60000);   // precache finished
  await offline(ctx, true);
  await p.reload(); await p.waitForSelector('text=Open sessions today', { timeout: 20000 });
  ok('app shell loads with no network');
  await p.click('text=Resume');
  await p.waitForSelector('.toast:not([hidden]) >> text=/Already scanned/', { timeout: 60000 });
  ok('camera, detection and local OCR work offline');
  await p.click('text=Add manually'); await p.fill('.uldinput', 'AAY77777MH'); await p.click('.sheet .btn.ok');
  await p.waitForFunction(() => document.querySelector('.counts b').textContent === '8');
  await waitSync(p, 'PENDING');
  await p.click('text=Complete session');
  await p.waitForSelector('text=Session summary'); await shot(p, 'e2e-summary');
  assert.match((await p.textContent('.sheet .summary')).replace(/\s+/g, ''), /Containers8Pallets0OtherULDs1Pending0Rejected0/);
  assert.equal((await p.evaluate(() => window.__uld.db.all('sessions')))[0].status, 'IN_PROGRESS', 'not final until confirmed');
  await p.click('.sheet >> text=Complete');
  await p.waitForSelector('text=/Session .* completed/');
  const local = (await p.evaluate(() => window.__uld.db.all('sessions')))[0];
  assert.equal(local.status, 'COMPLETED');
  ok('session completed offline after summary');

  await offline(ctx, false);
  await waitSync(p, 'SYNCED', 60000);
  st = await api('/_state');
  assert.equal(st.conflicts.length, 0, 'normal single-device use never conflicts');
  assert.equal(st.sessions[0].data.status, 'COMPLETED');
  assert.equal(st.sessions[0].data.completed_at, local.completed_at, 'original timestamp preserved');
  assert.equal(st.scans.length, all.length + 1);
  ok('auto-sync on reconnect, timestamps not rewritten');

  await p.click('text=My history'); await p.waitForSelector('text=Total containers'); await shot(p, 'e2e-history');
  assert.match((await p.textContent('.plate .summary')).replace(/\s+/g, ''), /Totalcontainers8Totalpallets0KULZoneA8OtherULDs1/);
  ok('daily activity: total, zone breakdown, other ULDs');

  // ───────────────────────────────── 2. conflict, takeover, day end ──
  console.log('2. Day-end rule, sync conflict, resume on another device');
  await p.click('text=Back');

  // day-end rule
  await p.selectOption('#zone', { label: 'Zone B' });
  await p.click('text=Start scanning'); await p.waitForSelector('.counts');
  await p.click('text=Add manually'); await p.fill('.uldinput', 'AKE50505MH'); await p.click('.sheet .btn.ok');
  await waitSync(p, 'SYNCED');
  const oldId = await p.evaluate(() => window.__uld.ctx.store.session.session_id);
  await p.click('.scanbar >> text=Sessions'); await p.waitForSelector('text=Open sessions today');
  const before = (await scans(p)).filter((x) => x.session_id === oldId).map((x) => `${x.value}:${x.state}`).sort();
  // Pretend the session was started on an earlier day and the app is reopened.
  await p.evaluate(async (id) => { const s = await window.__uld.db.get('sessions', id); s.day = '2026-01-01'; await window.__uld.db.put('sessions', s); }, oldId);
  await p.reload(); await p.waitForSelector('text=/closed automatically/');
  const stale = await p.evaluate((id) => window.__uld.db.get('sessions', id), oldId);
  assert.equal(stale.status, 'AUTO_COMPLETED'); assert.equal(stale.completion_type, 'AUTO');
  assert.equal(new Date(stale.completed_at).getHours(), 23);
  assert.deepEqual((await scans(p)).filter((x) => x.session_id === oldId).map((x) => `${x.value}:${x.state}`).sort(), before, 'no scan data lost or altered');
  assert.ok(before.includes('AKE50505MH:CONFIRMED'));
  await waitSync(p, 'SYNCED');
  await p.reload(); await p.waitForSelector('text=Start a session');
  assert.equal(await p.locator('text=Open sessions today').count(), 0, 'cannot be resumed on a later day');
  ok('day-end rule: stale session auto-completed, data kept, not resumable');

  // conflict
  await p.selectOption('#zone', { label: 'Zone C' });
  await p.click('text=Start scanning'); await p.waitForSelector('.counts');
  await p.click('text=Add manually'); await p.fill('.uldinput', 'AKE40404MH'); await p.click('.sheet .btn.ok');
  await waitSync(p, 'SYNCED');
  const sid = await p.evaluate(() => window.__uld.ctx.store.session.session_id);
  await api('/_control', { bump: { entity: 'session', id: sid, patch: { zone_name: 'Zone C (edited elsewhere)' } } });
  await p.click('text=Add manually'); await p.fill('.uldinput', 'AKE40405MH'); await p.click('.sheet .btn.ok');
  await until(async () => (await p.evaluate(() => window.__uld.db.all('conflicts'))).length === 1);
  st = await api('/_state');
  assert.equal(st.conflicts.length, 1);
  assert.equal(st.sessions.find((s) => s.data.session_id === sid).data.zone_name, 'Zone C (edited elsewhere)', 'server copy not overwritten');
  assert.equal((await p.evaluate((id) => window.__uld.db.get('syncmeta', `session:${id}`), sid)).state, 'CONFLICT');
  assert.equal(st.conflicts[0].incoming.zone_name, 'Zone C', 'device copy preserved for admin review');
  assert.ok(st.scans.filter((x) => x.data.session_id === sid).length >= 2, 'scans still reach the server');
  ok('conflict: both versions kept and flagged, nothing overwritten');

  // another device picks the session up from the server
  const other = await open('loop', { browser });   // separate storage, same server
  await login(other.p);
  await other.p.waitForSelector('text=Open sessions today');
  await other.p.click('text=Resume'); await other.p.waitForSelector('.counts');
  assert.equal((await counts(other.p))[0], 2, 'confirmed containers carried over');
  await until(async () => (await other.p.evaluate(() => window.__uld.db.all('events'))).some((e) => e.type === 'SESSION_RESUMED'));
  ok('open session resumed from the server on a second device');
  await other.ctx.close();
  await browser.close();
}

// ─────────────────────────────────────────────── 3. queue overflow ──
console.log('3. Queue overflow');
{
  await api('/_control', { config: { queue: { overflowThreshold: 3 } } });
  const { browser, p } = await open('three');
  await login(p); await p.click('text=Start scanning');
  await p.waitForSelector('.full >> text=Scanning paused', { timeout: 90000 }); await shot(p, 'e2e-overflow');
  assert.equal(await p.isHidden('.full >> text=Close'), true, 'the queue cannot be dismissed while over the threshold');
  ok('scanning pauses and the queue opens full-screen at the threshold');
  await p.click('.full .card >> text=Confirm');
  await p.waitForFunction(() => !document.querySelector('.full'));
  assert.equal(await p.isHidden('.paused'), true);
  ok('scanning resumes automatically once below the threshold');
  await api('/_control', { config: { queue: { overflowThreshold: 8 } } });
  await browser.close();
}

// ───────────────────────────────────────────────── 4. multi-scan ──
console.log('4. Multi-Scan');
{
  const { browser, p } = await open('two', { apiMode: false });
  await p.fill('#email', 'demo@company.test'); await p.click('text=Continue');
  await p.click('text=Start scanning');
  await p.waitForFunction(() => document.querySelector('.guide')?.textContent !== 'Starting camera' && document.querySelector('.guide')?.textContent !== 'Preparing scanner', null, { timeout: 60000 });
  await p.click('text=Multi-scan');
  await p.waitForSelector('.toast:not([hidden])', { timeout: 60000 });
  const text = await p.textContent('.toast');
  const values = (await scans(p)).map((s) => s.value).sort();
  assert.deepEqual(values, ['AAY56789MH', 'AKE1234AI']);
  assert.match(text, /added|already scanned/);
  ok(`two ULDs captured from one frame, each validated independently ("${text}")`);
  assert.equal(await p.textContent('.sync'), 'On this device only');
  ok('demo mode never claims to be synced');
  await browser.close();
}

// ───────────────────────────────── 5. unreadable + cloud fallback ──
console.log('5. Unreadable number, cloud OCR fallback');
{
  const a = await open('glare');
  await login(a.p); await a.p.click('text=Start scanning');
  await a.p.waitForSelector('.queue .card.bad', { timeout: 90000 }); await shot(a.p, 'e2e-invalid');
  assert.match(await a.p.textContent('.queue .card'), /Uncertain or invalid/);
  assert.equal(await a.p.locator('.queue .card .btn.ok').count(), 0, 'an invalid ULD cannot be confirmed');
  assert.equal((await api('/_state')).ocrCalls.length, 0, 'cloud OCR is off unless enabled');
  await a.p.click('.queue .card >> text=Edit'); await a.p.fill('.uldinput', 'AKE77410MH'); await a.p.click('.sheet .btn.ok');
  await a.p.waitForFunction(() => document.querySelector('.counts b').textContent === '1');
  const fixed = (await scans(a.p)).find((s) => s.value === 'AKE77410MH');
  assert.equal(fixed.manually_corrected, true); assert.ok(fixed.image_reference); assert.notEqual(fixed.raw_ocr, 'AKE77410MH');
  ok(`glare-damaged number is never guessed: shown as invalid (read "${fixed.raw_ocr}"), fixed by editing`);
  await a.browser.close();

  await api('/_control', { config: { cloudOcr: { enabled: true } } });
  const b = await open('glare');
  await login(b.p); await b.p.click('text=Start scanning');
  await waitTop(b.p, 'AKE77410MH', 90000);
  const viaCloud = (await scans(b.p)).find((s) => s.value === 'AKE77410MH');
  assert.equal(viaCloud.cloud_fallback, true); assert.equal(viaCloud.engine, 'mock-cloud');
  assert.ok(viaCloud.flags.local_ocr && viaCloud.flags.local_ocr !== 'AKE77410MH');
  const calls = (await api('/_state')).ocrCalls;
  assert.ok(calls.length >= 1 && calls.every((c) => c.bytes < 60000), 'only a small crop is sent to the cloud');
  ok(`cloud fallback used only for the unreadable crop (${calls.length} call, ${calls[0].bytes} bytes)`);
  await api('/_control', { config: { cloudOcr: { enabled: false } } });
  await b.browser.close();
}

console.log(`\n${passed} checks passed`);
