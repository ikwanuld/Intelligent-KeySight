// The pallet reader in a real browser (Web Worker + WebAssembly), on the
// reference photos. Checks that the browser gives the same answers as the
// Node harness and reports how long a frame takes.
//   node tests/serve.mjs 8766 &
//   node tests/pallet-browser.mjs [--limit 640] [--threads 1]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = await import('playwright').catch(() => createRequire(process.env.PLAYWRIGHT_DIR || '/opt/npm-tools/node_modules/')('playwright'));

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : d; };
const limit = Number(flag('limit', 640)), threads = Number(flag('threads', 1));
const BASE = process.env.BASE || 'http://localhost:8766';
const root = path.dirname(new URL(import.meta.url).pathname);
const gt = JSON.parse(fs.readFileSync(path.join(root, 'pallet-photos', 'ground-truth.json'), 'utf8'));

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const context = await browser.newContext();     // one context = one phone's storage
const page = await context.newPage();
page.on('pageerror', (e) => { console.log('pageerror:', e.message); process.exitCode = 1; });
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
await page.goto(`${BASE}/tests/pallet-browser.html`);
await page.waitForFunction(() => !!window.palletTest);
const first = await page.evaluate((t) => window.palletTest.load(t), threads);
console.log(`Loaded in ${(first.loadMs / 1000).toFixed(1)} s (${first.downloaded ? 'downloaded' : 'from the device'}, ${(first.total / 1e6).toFixed(1)} MB), threads ${first.info.threads}, cross-origin isolated: ${first.isolated}`);

let need = 0, read = 0, wrong = 0, wrongFlagged = 0, detMs = 0, recMs = 0, recCalls = 0, n = 0;
for (const key of Object.keys(gt).sort()) {
  const r = await page.evaluate(([u, o]) => window.palletTest.read(u, o), [`pallet-photos/${key}.jpg`, { detLimit: limit }]);
  detMs += r.detMs; recMs += r.recMs; recCalls += r.recCalls; n++;
  const offered = r.candidates.filter((c) => c.status !== 'INVALID').map((c) => ({ id: c.suggestion || c.raw,
    flagged: !!c.suggestion || c.status !== 'VALID' || c.conf < 90 }));
  const notes = [];
  for (const g of gt[key]) {
    const hit = offered.some((o) => o.id === g.id);
    if (g.level !== 'optional' && g.level !== 'damaged') { need++; if (hit) read++; }
    notes.push(`${hit ? '✓' : '✗'} ${g.id}${hit ? '' : ` (${g.level})`}`);
  }
  for (const o of offered) {
    if (gt[key].some((g) => g.id === o.id)) continue;
    if (o.flagged) { wrongFlagged++; notes.push(`!  wrong ${o.id} (for review)`); } else { wrong++; notes.push(`!! WRONG ${o.id}`); }
  }
  console.log(`${key}  det ${r.detMs.toFixed(0)}ms rec ${r.recMs.toFixed(0)}ms/${r.recCalls}  ${notes.join('  ')}`);
}
console.log(`\nBrowser (WebAssembly, ${first.info.threads} thread${first.info.threads > 1 ? 's' : ''}), detector input ${limit}px`);
console.log(`Plates read: ${read}/${need}   wrong shown as confident: ${wrong}   wrong shown for review: ${wrongFlagged}`);
console.log(`Time per photo: detect ${(detMs / n).toFixed(0)}ms + read ${(recMs / n).toFixed(0)}ms (${(recCalls / n).toFixed(1)} lines)`);

// Second start: nothing may be downloaded again.
const page2 = await context.newPage();
await page2.goto(`${BASE}/tests/pallet-browser.html`);
await page2.waitForFunction(() => !!window.palletTest);
const again = await page2.evaluate(() => window.palletTest.load(1));
console.log(`Second start: ${(again.loadMs / 1000).toFixed(1)} s, ${again.downloaded ? 'DOWNLOADED AGAIN' : 'from the device'}`);
if (again.downloaded) process.exitCode = 1;
// Start-up problems must come back as errors, never as a reader that hangs.
const f = await page2.evaluate(() => window.palletTest.failures());
console.log(`Start-up failures: bad options -> ${f.badOptions} (then tried with ${f.threadsAfterFailure} thread); next attempt -> ${f.retry}; no sign of life -> ${f.timeout}`);
if (f.badOptions !== 'Error:LOAD' || f.threadsAfterFailure !== 1 || !/^started/.test(f.retry) || !/^LOAD/.test(f.timeout) || !f.workerGone) { console.log('UNEXPECTED', f); process.exitCode = 1; }
await browser.close();
if (wrong) process.exitCode = 1;
