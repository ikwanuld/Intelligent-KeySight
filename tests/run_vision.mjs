import { createRequire } from 'node:module';
// `npm i -D playwright` in this folder, or point PLAYWRIGHT_DIR at an existing install.
const { chromium } = await import('playwright').catch(() => createRequire(process.env.PLAYWRIGHT_DIR || '/opt/npm-tools/node_modules/')('playwright'));
const b = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const p = await b.newPage();
p.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) console.log('console:', m.text()); });
p.on('requestfailed', (r) => console.log('reqfail:', r.url())); p.on('response', (r) => { if (r.status() >= 400) console.log('http', r.status(), r.url()); });
p.on('pageerror', (e) => console.log('pageerror:', e.message));
await p.goto(`${process.env.BASE || 'http://localhost:8766'}/tests/vision.html`);
await p.waitForFunction('window.runVision');
const out = await p.evaluate(() => window.runVision().catch((e) => { throw new Error(String(e && (e.stack || e.message || e))); }));
let ok = 0;
for (const r of out) {
  const got = r.single.map((s) => s.split(/[ →]/)[0]);
  const multi = r.multi.map((s) => s.split(' ')[0]);
  const singleOk = r.unreadable ? r.single.every((s) => s.includes('INVALID')) : r.expect.length ? r.expect.includes(got[0]) : got.length === 0;
  const multiOk = r.expect.every((e) => multi.includes(e)) && multi.length === r.expect.length;
  if (singleOk && multiOk) ok++;
  console.log(`${singleOk ? '✓' : '✗'}${multiOk ? '✓' : '✗'} ${r.name.padEnd(13)} regions=${r.regions} ${r.lighting.padEnd(9)} passes=${r.passes} ${String(r.ms).padStart(4)}ms  single=${JSON.stringify(r.single)} multi=${JSON.stringify(r.multi)}`);
}
console.log(`${ok}/${out.length} fully correct`);
if (ok !== out.length) process.exitCode = 1;
await b.close();
