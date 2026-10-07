// Static server + mock API for local testing:  node tests/serve.mjs [port]
// Serves the app at http://localhost:<port>/ and a mock backend at /api.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createMockApi } from './mock-api.mjs';
const mock = createMockApi();
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.gz': 'application/gzip', '.wasm': 'application/wasm', '.jpg': 'image/jpeg', '.txt': 'text/plain' };
const port = Number(process.argv[2] || 8766);
// --isolate: send the headers that make the page "cross-origin isolated"
// (needed for WebAssembly threads), to try the pallet reader with threads.
const isolate = process.argv.includes('--isolate')
  ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } : {};
// Tests switch the "network" off here as well as in the browser: the browser's
// own offline switch does not stop a service worker from fetching, so without
// this an offline test could pass on files that were quietly fetched online.
//   GET /__net?down=1   every other request is cut off      GET /__net?down=0   back to normal
let down = false;
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/__net') { down = /down=1/.test(req.url); res.writeHead(200, { 'Cache-Control': 'no-store' }); return res.end(down ? 'down' : 'up'); }
  if (down) return req.socket.destroy();
  if (p.startsWith('/api/')) {
    return mock.handle(req, res, p.slice(4), new URL(req.url, 'http://x').searchParams).catch((e) => { res.writeHead(500); res.end(String(e)); });
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    console.log('404', p); res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...isolate });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log('serving', root, 'on', port));
