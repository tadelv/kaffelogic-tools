// Copies web/ to dist/ with content-hashed URLs.
//
// GitHub Pages serves assets with max-age=14400 (4 h), so a plain app.js can be
// served stale for hours after a deploy. Appending ?v=<hash> changes the URL
// whenever the code changes, which makes that cache harmless.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = dirname(fileURLToPath(import.meta.url));
const dist = join(src, '..', 'dist');

const codeFiles = readdirSync(src).filter((f) => f.endsWith('.js') || f.endsWith('.css') || f.endsWith('.json'));
const code = codeFiles.map((f) => readFileSync(join(src, f), 'utf8')).join('\n');
const hash = createHash('sha256').update(code).digest('hex').slice(0, 10);
const v = `?v=${hash}`;

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// HTML: version the stylesheet and entry modules
for (const page of readdirSync(src).filter((f) => f.endsWith('.html'))) {
  let html = readFileSync(join(src, page), 'utf8');
  html = html.replace(/\.\/([A-Za-z0-9_.-]+\.(?:js|css))/g, (_m, name) => `./${name}${v}`);
  writeFileSync(join(dist, page), html);
}

// JS: version its own imports and data fetches
for (const file of readdirSync(src).filter((f) => f.endsWith('.js'))) {
  let js = readFileSync(join(src, file), 'utf8');
  js = js.replace(/(from '\.\/[A-Za-z0-9_.-]+\.js)'/g, (_m, spec) => `${spec}${v}'`);
  js = js.replace(/(fetch\('\.\/[A-Za-z0-9_.-]+\.json)'\)/g, (_m, spec) => `${spec}${v}')`);
  writeFileSync(join(dist, file), js);
}

// everything else verbatim (data, fixtures)
for (const file of readdirSync(src)) {
  if (/\.(js|mjs|html)$/.test(file) || file === 'fixtures') continue;
  cpSync(join(src, file), join(dist, file), { recursive: true });
}

console.log(`dist/ built — asset version ${hash} (${codeFiles.length} source files)`);
