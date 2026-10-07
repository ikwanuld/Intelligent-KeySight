// Regenerates the precache list and cache version in sw.js.
// Run after changing any file:  node tools/update-sw.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const include = ['index.html', 'manifest.webmanifest', 'css', 'js', 'icons', 'vendor'];
// Not precached: licences and notes, and the pallet reader's large files
// (models + WebAssembly runtime). Those are fetched when first needed and kept
// in their own cache, see js/pallet/assets.js.
const skip = /LICENSE|\.map$|\.md$|\.onnx$|^vendor\/paddle\/dict\.txt$|^vendor\/ort\/.*\.wasm$/;
const files = [];
const walk = (p) => {
  const abs = path.join(root, p);
  if (fs.statSync(abs).isDirectory()) fs.readdirSync(abs).sort().forEach((f) => walk(path.posix.join(p, f)));
  else if (!skip.test(p)) files.push(p);
};
include.forEach(walk);
const hash = crypto.createHash('sha1');
files.forEach((f) => hash.update(f).update(fs.readFileSync(path.join(root, f))));
const version = hash.digest('hex').slice(0, 10);
let sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
sw = sw.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`)
  .replace(/const ASSETS = \[[\s\S]*?\];/, `const ASSETS = [\n  './',\n${files.map((f) => `  '${f}',`).join('\n')}\n];`);
fs.writeFileSync(path.join(root, 'sw.js'), sw);
console.log(`sw.js: ${files.length} files, version ${version}`);
