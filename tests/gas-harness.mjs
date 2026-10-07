// Runs sheets/Code.gs outside Google, against an in-memory imitation of the
// Apps Script services it uses. It proves the script's logic; it cannot prove
// Google's own behaviour (quotas, speed, the real deployment).
//   node tests/gas-harness.mjs 8771   ->  POST http://localhost:8771/exec ,  GET /_sheets
import http from 'node:http';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import path from 'node:path';

export function loadGas({ email = 'admin@company.test' } = {}) {
  const sheets = new Map();
  const mkSheet = (name) => {
    const rows = [];
    const sh = {
      getLastRow: () => rows.length, getMaxRows: () => 1000, setFrozenRows() {},
      appendRow(r) { rows.push(r.map(String)); },
      getRange(r, c, n = 1, m = 1) {
        return {
          setNumberFormat() {},
          getValues: () => Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => (rows[r - 1 + i] || [])[c - 1 + j] ?? '')),
          setValues(v) {
            if (v.length !== n || v.some((x) => x.length !== m)) throw new Error('setValues: size mismatch');
            v.forEach((row, i) => { const t = (rows[r - 1 + i] ||= []); row.forEach((x, j) => { t[c - 1 + j] = String(x); }); });
          },
        };
      },
    };
    sheets.set(name, { sh, rows });
    return sh;
  };
  const props = new Map(), files = [];
  const bytes = (b) => [...b].map((x) => (x > 127 ? x - 256 : x));          // Apps Script bytes are signed
  const buf = (b) => (typeof b === 'string' ? Buffer.from(b) : Buffer.from(b.map((x) => (x + 256) % 256)));
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets.get(n)?.sh || null, insertSheet: mkSheet }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => email }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ content: t, setMimeType() { return this; } }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (t, k) => bytes(crypto.createHmac('sha256', k).update(t).digest()),
      base64EncodeWebSafe: (v) => buf(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64DecodeWebSafe: (s) => bytes(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
      base64Decode: (s) => bytes(Buffer.from(s, 'base64')),
      newBlob: (b, type, name) => ({ bytes: b, name, getDataAsString: () => buf(b).toString() }),
    },
    DriveApp: {
      getFolderById: (id) => { if (id !== 'folder-1') throw new Error('no folder'); return ctx.DriveApp._folder; },
      createFolder: () => ctx.DriveApp._folder,
      _folder: { getId: () => 'folder-1', createFile: (blob) => { files.push(blob); return { getId: () => `file-${files.length}` }; } },
    },
    JSON, Date, Math, String, Number, Object, Array, Error, RegExp, console,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../sheets/Code.gs', import.meta.url), 'utf8'), ctx);
  const dump = () => Object.fromEntries([...sheets].map(([n, s]) => [n, s.rows]));
  return { ctx, dump, files, call: (env) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(env) } }).content) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const gas = loadGas(); gas.ctx.setup();
  http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/_sheets') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ sheets: gas.dump(), files: gas.files.length })); }
    // Like the real web app: refuse anything that would need a CORS preflight.
    if (req.method !== 'POST' || !/^text\/plain/.test(req.headers['content-type'] || '') || req.headers.authorization) { res.writeHead(405); return res.end(); }
    const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(gas.ctx.doPost({ postData: { contents: Buffer.concat(c).toString() } }).content);
    });
  }).listen(Number(process.argv[2] || 8771), () => console.log('fake Apps Script web app on', process.argv[2] || 8771));
}
