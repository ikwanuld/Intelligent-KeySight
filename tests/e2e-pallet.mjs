// End-to-end test of Pallets mode: the real app in headless Chrome, the real
// pallet reader (Web Worker + WebAssembly), and the REAL reference photos
// played as the camera picture.
//   node tests/serve.mjs 8766 &
//   sh tests/make_videos.sh /tmp/videos
//   VIDEOS=/tmp/videos node tests/e2e-pallet.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const { chromium } = await import('playwright').catch(() => createRequire(process.env.PLAYWRIGHT_DIR || '/opt/npm-tools/node_modules/')('playwright'));

const BASE = process.env.BASE || 'http://localhost:8766';
const V = process.env.VIDEOS || '.';
const SHOTS = process.env.SHOTS;
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };
// Offline for real: the browser context AND the test server (see tests/serve.mjs).
const offline = async (ctx, on) => { if (on) await ctx.setOffline(true); await fetch(`${BASE}/__net?down=${on ? 1 : 0}`); if (!on) await ctx.setOffline(false); };
const api = async (path, body) => (await fetch(`${BASE}/api${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined)).json();

async function open(video, { apiMode = true } = {}) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${V}/${video}.mjpeg`] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, permissions: ['camera'], hasTouch: true, acceptDownloads: true });
  if (apiMode) await ctx.addInitScript(() => { localStorage.setItem('uld_api_base', '/api'); localStorage.setItem('uld_auth_mode', 'oauth'); });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { console.log('pageerror:', e.message); process.exitCode = 1; });
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) console.log('console:', m.text()); });
  await p.goto(BASE + '/');
  return { browser, ctx, p };
}
const login = async (p) => { await p.click('text=Sign in with Google'); await p.waitForSelector('text=Start a session'); };
const topCard = (p) => p.evaluate(() => {
  const c = document.querySelector('.queue .card');
  if (!c) return null;
  const img = c.querySelector('img.crop');
  return { id: c.dataset.id, value: c.querySelector('.uld.big').getAttribute('aria-label'), text: c.textContent,
    tone: ['ok', 'review', 'bad', 'info'].find((t) => c.classList.contains(t)), canConfirm: !!c.querySelector('.btn.ok'),
    suggestion: c.querySelector('.sugg .uld')?.getAttribute('aria-label') || null,
    image: img && !img.hidden ? [img.naturalWidth, img.naturalHeight] : null };
});
// Tiles on the scanner: [containers, pallets, pending, rejected].
const counts = (p) => p.$$eval('.counts b', (els) => els.map((e) => Number(e.textContent)));
const scans = (p) => p.evaluate(() => window.__uld.db.all('scans'));
const mode = (p) => p.getAttribute('.modes .seg[aria-selected=true]', 'data-mode');
const until = async (fn, timeout = 120000, what = '') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > timeout) throw new Error(`timed out waiting ${what || fn}`); await new Promise((r) => setTimeout(r, 250)); } };
const shot = (p, name) => SHOTS && p.screenshot({ path: `${SHOTS}/${name}.png` });
const readerRunning = (p) => p.waitForFunction(() => { const t = document.querySelector('.guide')?.textContent || ''; return t && !/Starting camera|Preparing|Downloading|unavailable/.test(t); }, null, { timeout: 180000 });

// ─────────────────────────────── 1. single plates, one after the other ──
console.log('1. Pallets mode on the reference photos (clean, rivets, upside down, 3-letter owner, damaged)');
{
  const { browser, ctx, p } = await open('pallets');
  await login(p);
  await p.click('text=Start scanning');
  await p.waitForSelector('.modes');
  assert.equal(await mode(p), 'CONTAINER');
  assert.deepEqual(await p.$$eval('.counts span', (e) => e.map((x) => x.textContent)), ['Containers', 'Pallets', 'Pending', 'Rejected']);
  await p.click('.modes >> text=Pallets');
  assert.equal(await mode(p), 'PALLET');
  assert.equal(await p.evaluate(() => document.querySelector('.counts .main span').textContent), 'Pallets', 'the tile of what is being counted is the big one');
  await readerRunning(p);
  ok('mode switch: Containers | Pallets; the pallet reader loads on first use');

  // The clip shows five plates in a loop. Deal with whatever comes up, as staff would.
  const TRUTH = { PAG70229R7: 'clean', PAG21824R7: 'rivets', PMC91026R7: 'upside down', PAJ0606TRA: '3-letter owner' };
  const DAMAGED = 'PAG22419R7';
  const seen = {};
  let damagedHandled = false, reviewImage = false;
  const t0 = Date.now();
  while (Object.keys(seen).length < 4 || !damagedHandled) {
    if (Date.now() - t0 > 420000) throw new Error(`timed out; handled ${JSON.stringify(seen)}, damaged ${damagedHandled}`);
    const c = await topCard(p);
    if (!c) { await new Promise((r) => setTimeout(r, 300)); continue; }
    if (TRUTH[c.value] && !c.suggestion) {
      seen[c.value] = c.tone;
      if (c.tone !== 'ok') { assert.match(c.text, /Needs review/); if (c.image) reviewImage = true; await shot(p, `pallet-review-${c.value}`); }
      else { assert.match(c.text, /High confidence/); await shot(p, `pallet-card-${c.value}`); }
      assert.ok(c.canConfirm);
      await p.click(`.queue .card[data-id="${c.id}"] .btn.ok`);
    } else {
      // Anything else can only be the damaged plate (one digit is scraped off).
      // It must never be offered as a confident result.
      assert.notEqual(c.tone, 'ok', `"${c.value}" shown as a confident result`);
      assert.ok(c.image, 'the photo of the number is on the card, so it can be typed without going back');
      await shot(p, 'pallet-damaged');
      if (c.tone === 'bad') { assert.match(c.text, /Not read reliably|Uncertain or invalid/); assert.equal(c.canConfirm, false); }
      await p.click(`.queue .card[data-id="${c.id}"] >> text=Edit`);
      await p.waitForSelector('.sheet img.crop:not([hidden])');
      await p.fill('.uldinput', DAMAGED);
      const msg = await p.textContent('.sheet [role=status]');
      if (/Already scanned/.test(msg)) { await p.click('.sheet >> text=Cancel'); await p.click(`.queue .card[data-id="${c.id}"] >> text=Reject`); }
      else { await p.click('.sheet .btn.ok'); damagedHandled = true; }
    }
    await p.waitForFunction((id) => document.querySelector('.queue .card')?.dataset.id !== id, c.id);
  }
  assert.deepEqual(Object.keys(seen).sort(), Object.keys(TRUTH).sort());
  ok(`four plates read off the camera: ${Object.entries(seen).map(([k, v]) => `${k} (${TRUTH[k]}: ${v === 'ok' ? 'high confidence' : 'needs review'})`).join(', ')}`);
  ok('damaged plate was not guessed: shown for checking with its photo, typed by hand');
  if (reviewImage) ok('review cards carry the photo of the number');

  await until(async () => (await counts(p))[1] === 5, 20000, 'pallet count 5');
  assert.equal((await counts(p))[0], 0, 'none of them counted as a container');
  await p.waitForSelector('.toast:not([hidden]) >> text=/Already scanned/', { timeout: 120000 });
  ok('same plates coming round again: "Already scanned", nothing added');

  const all = await scans(p);
  const by = (v) => all.find((s) => s.value === v);
  for (const v of Object.keys(TRUTH)) {
    assert.equal(by(v).state, 'CONFIRMED'); assert.equal(by(v).category, 'PALLET'); assert.equal(by(v).operational, true);
    assert.equal(by(v).engine, 'paddle'); assert.equal(by(v).pipeline, 'pallet'); assert.equal(by(v).raw_ocr, v);
  }
  assert.equal(by('PAJ0606TRA').rule_id, 'rule-pallet-owner3-4');
  assert.equal(by(DAMAGED).manually_corrected, true); assert.notEqual(by(DAMAGED).raw_ocr, DAMAGED);
  assert.ok(by(DAMAGED).image_reference, 'the crop of a hand-corrected plate is kept as evidence');
  const clean = all.filter((s) => s.state === 'CONFIRMED' && s.confidence_status === 'HIGH' && !s.flags.review.length && !s.manually_corrected);
  assert.ok(clean.every((s) => !s.image_reference), 'clean confident scans keep no image');
  ok('records: category PALLET, pallet pipeline, raw reading, rule, evidence only where needed');

  await p.waitForFunction(() => document.querySelector('.sync')?.dataset.s === 'SYNCED', null, { timeout: 30000 });
  const st = await api('/_state');
  assert.ok(st.scans.filter((x) => x.data.category === 'PALLET' && x.data.state === 'CONFIRMED').length >= 5);
  ok('pallet scans sync like container scans');

  // the list can be taken out
  await p.click('.counts'); await p.waitForSelector('.full >> text=Recent scans'); await shot(p, 'pallet-session');
  assert.match((await p.textContent('.full .summary')).replace(/\s+/g, ''), /Containers0Pallets5OtherULDs0/);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.full >> text=Download CSV')]);
  const csv = (await (await import('node:fs')).promises.readFile(await dl.path(), 'utf8'));
  assert.ok(csv.includes('PAJ0606TRA,Confirmed,PAJ,PALLET,KUL,'));
  assert.equal(await p.evaluate(async () => (await import('./js/ui/export.js')).confirmedList(window.__uld.ctx.store.scans).length), 5);
  await p.click('.full >> text=Close');
  ok('session view, CSV and copy list include the pallets');

  // offline, after a restart
  await p.evaluate(() => navigator.serviceWorker.ready);
  await until(() => p.evaluate(async () => { const k = (await caches.keys()).find((x) => x.startsWith('uld-scanner-')); return !!k && (await (await caches.open(k)).keys()).length >= 50; }), 60000, 'precache');
  await until(() => p.evaluate(() => window.__uld.ctx.palletReader.state === 'ready'), 60000, 'pallet reader stored on the device');
  await offline(ctx, true);
  await p.reload(); await p.waitForSelector('text=Open sessions today', { timeout: 20000 });
  await p.click('text=Resume'); await p.waitForSelector('.modes');
  await until(async () => (await mode(p)) === 'PALLET', 10000, 'mode remembered');
  await readerRunning(p);
  await p.waitForSelector('.toast:not([hidden]) >> text=/Already scanned/', { timeout: 120000 });
  const isolated = await p.evaluate(() => self.crossOriginIsolated);
  ok(`after a restart with no network: opens in Pallets again, reader loads from the phone and reads (cross-origin isolated: ${isolated})`);
  await offline(ctx, false);
  await browser.close();
}

// ───────────────────────────────────────────── 2. a stack: Multi-Scan ──
console.log('2. A stack of pallets in one picture');
{
  const { browser, p } = await open('stack', { apiMode: false });
  await p.fill('#email', 'demo@company.test'); await p.click('text=Continue');
  await p.click('text=Start scanning');
  await p.click('.modes >> text=Pallets');
  await readerRunning(p);
  await p.click('text=Multi-scan');
  await p.waitForFunction(() => /added|already scanned|No ULD/.test(document.querySelector('.toast:not([hidden])')?.textContent || ''), null, { timeout: 120000 });
  const text = await p.textContent('.toast'); await shot(p, 'pallet-stack');
  const CLEAR = ['PMC15880R9', 'PMC27257R9', 'PMC81465R7', 'PMC82529R7'];
  await until(async () => { const v = (await scans(p)).map((s) => s.value); return CLEAR.every((x) => v.includes(x)); }, 60000, 'all four clear plates of the stack');
  const all = await scans(p);
  for (const s of all) {
    if (CLEAR.includes(s.value)) continue;
    // The fifth plate is faded. If it shows up at all it must be flagged, never a plain "valid".
    assert.ok(s.validation_status !== 'VALID' || s.confidence_status !== 'HIGH' || s.suggested_correction, `unexpected confident result ${s.value}`);
  }
  assert.ok(all.every((s) => s.state === 'PENDING'), 'nothing is counted before staff confirm it');
  ok(`four plates of one stack captured as four separate numbers ("${text}")`);
  // queue: one card on top, the rest behind it
  assert.ok((await counts(p))[2] >= 4);
  await p.waitForSelector('.queue .more');
  ok('several pending plates queue up behind the top card');
  await browser.close();
}

// ───────────────── 3. containers and pallets in the same session ──
console.log('3. Both kinds in one session');
{
  const { browser, p } = await open('loop');
  await login(p);
  await p.click('text=Start scanning');
  // Containers mode: the pallet in view is stored silently.
  await until(async () => (await topCard(p))?.value === 'AKE79210R7', 60000, 'first container card');
  await p.click('.queue .card .btn.ok');
  await until(async () => (await scans(p)).some((s) => s.value === 'PMC12345MH' && s.state === 'AUTO_SAVED'), 60000, 'pallet auto-saved');
  const silent = (await scans(p)).find((s) => s.value === 'PMC12345MH');
  // Clear the queue so only what Pallets mode brings up is left.
  while ((await counts(p))[2] > 0) {
    const c = await topCard(p);
    if (!c) break;
    if (c.suggestion) await p.click('.queue .card >> text=Keep original');
    await p.click(`.queue .card[data-id="${c.id}"] >> text=Reject`);
    await p.waitForFunction((id) => document.querySelector('.queue .card')?.dataset.id !== id, c.id);
  }
  const containersBefore = (await counts(p))[0];

  await p.click('.modes >> text=Pallets');
  await readerRunning(p);
  await until(async () => (await topCard(p))?.value === 'PMC12345MH', 120000, 'pallet card');
  const promoted = (await scans(p)).find((s) => s.value === 'PMC12345MH');
  assert.equal(promoted.scan_id, silent.scan_id, 'the silently saved record is brought up, not duplicated');
  assert.equal(promoted.state, 'PENDING'); assert.equal(promoted.pipeline, 'pallet');
  assert.deepEqual(promoted.history.map((x) => x.action), ['DETECTED', 'DETECTED']);
  await p.click('.queue .card .btn.ok');
  await until(async () => (await counts(p))[1] === 1, 10000, 'pallet counted');
  ok('pallet saved silently in Containers mode comes up for confirmation once scanned in Pallets mode');

  // Pallets mode: containers passing through the picture never ask for attention.
  await until(async () => (await scans(p)).some((s) => s.state === 'AUTO_SAVED' && s.category === 'CONTAINER'), 120000, 'container auto-saved in Pallets mode');
  await new Promise((r) => setTimeout(r, 6000));
  const c = await counts(p);
  assert.equal(c[0], containersBefore); assert.equal(c[2], 0, 'no container cards in Pallets mode');
  assert.equal(await p.locator('.queue .card').count(), 0);
  ok('in Pallets mode, container numbers are stored silently and unreadable ones are ignored');

  const silentContainers = (await scans(p)).filter((s) => s.state === 'AUTO_SAVED' && s.category === 'CONTAINER').map((s) => s.scan_id);
  await p.click('.modes >> text=Containers');
  const back = await until(async () => (await scans(p)).find((s) => silentContainers.includes(s.scan_id) && s.state === 'PENDING'), 120000, 'container promoted after switching back');
  assert.equal(back.category, 'CONTAINER'); assert.notEqual(back.pipeline, 'pallet');
  ok(`back in Containers mode, a container stored silently meanwhile comes up for confirmation (${back.value})`);
  await browser.close();
}

// ─────────────────────────────────────────────── 4. a slow phone ──
console.log('4. Slow phone (every pass takes about 3 seconds)');
{
  const { browser, p } = await open('damaged', { apiMode: false });
  await p.fill('#email', 'demo@company.test'); await p.click('text=Continue');
  // Hold back every answer of the reader, as a slow processor would.
  await p.evaluate(() => {
    const e = window.__uld.ctx.palletEngine(), read = e.read.bind(e);
    e.read = async (...a) => { const r = await read(...a); await new Promise((res) => setTimeout(res, 2400)); return r; };
  });
  await p.click('text=Start scanning');
  await p.click('.modes >> text=Pallets');
  await readerRunning(p);
  // The damaged plate is only reported after it stayed unreadable over
  // several passes. A plate that is forgotten between two slow passes
  // (longer apart than the normal track lifetime) would never be.
  const c = await until(() => topCard(p), 120000, 'the card of a plate that needed several slow passes');
  assert.notEqual(c.tone, 'ok'); assert.ok(c.image);
  const frames = (await scans(p))[0].timing.frames;
  const ms = await until(() => p.evaluate(async () => (await window.__uld.db.all('sessions'))[0]?.device?.pallet_pass_ms), 120000, 'pass time recorded');
  assert.ok(ms > 2400);
  ok(`a plate is still followed from one pass to the next (pass time ${ms} ms, reported after ${frames} passes)`);
  await browser.close();
}

// ───────────────────────── 5. first use with no connection ──
console.log('5. Pallets opened for the first time where there is no signal');
{
  const { browser, ctx, p } = await open('pallets', { apiMode: false });
  await p.fill('#email', 'demo@company.test'); await p.click('text=Continue');
  // The app itself is installed (as on a phone that has used Containers for weeks)...
  await until(() => p.evaluate(async () => { const k = (await caches.keys()).find((x) => x.startsWith('uld-scanner-')); return !!navigator.serviceWorker.controller && !!k && (await (await caches.open(k)).keys()).length >= 50; }), 60000, 'app installed');
  await until(() => p.evaluate(() => window.__uld.ctx.palletReader.state !== 'downloading'), 60000, 'background download settled');
  await offline(ctx, true);
  // ...but the pallet reader never made it onto the device.
  await p.evaluate(async () => { for (const k of await caches.keys()) if (k.startsWith('uld-pallet-reader-')) await caches.delete(k); });
  await p.click('text=Start scanning');
  await p.click('.modes >> text=Pallets');
  await p.waitForSelector('.camerr:not([hidden]) >> text=/not on this phone yet/', { timeout: 60000 }); await shot(p, 'pallet-not-downloaded');
  assert.match(await p.textContent('.camerr'), /about 30 MB/);
  // Nothing else is blocked: manual entry and Containers still work.
  await p.click('text=Add manually'); await p.fill('.uldinput', 'PMC82529R7'); await p.click('.sheet .btn.ok');
  await until(async () => (await counts(p))[1] === 1, 10000, 'manual pallet counted');
  await p.click('.modes >> text=Containers');
  await p.waitForFunction(() => document.querySelector('.camerr').hidden);
  ok('no signal and reader not downloaded: says so plainly; manual entry and Containers keep working');
  await offline(ctx, false);
  await p.click('.modes >> text=Pallets');
  await readerRunning(p);
  await until(() => topCard(p), 120000, 'a pallet card once the reader is there');
  ok('with a connection again the reader downloads and scanning starts');
  await browser.close();
}

console.log(`\n${passed} checks passed`);
