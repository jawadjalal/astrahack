#!/usr/bin/env node
// `npm run check`: syntax-check every plain JS/MJS entry point in the repo (no install needed).
// TypeScript in canvas/ is checked by `cd canvas && npm run build`.
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = ['.', 'bin', 'src', 'lib', 'scripts', 'canvas/scripts', 'canvas/mcp', 'ugc', 'agent', 'media'];
const skip = new Set(['node_modules', '.next', 'fixtures', 'artifacts', 'runs']);

function files(dir, depth = 0) {
  const abs = join(root, dir);
  let entries = [];
  try { entries = readdirSync(abs); } catch { return []; }
  const out = [];
  for (const name of entries) {
    if (skip.has(name)) continue;
    const rel = join(dir, name);
    const st = statSync(join(root, rel));
    if (st.isDirectory()) { if (dir !== '.' && depth < 3) out.push(...files(rel, depth + 1)); }
    else if (/\.(m?js|cjs)$/.test(name)) out.push(rel);
  }
  return out;
}

const list = [...new Set(dirs.flatMap(d => files(d)))].sort();
let bad = 0;
for (const f of list) {
  const r = spawnSync(process.execPath, ['--check', join(root, f)], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; console.error(`FAIL ${f}\n${r.stderr}`); }
}
console.log(`${list.length - bad}/${list.length} files pass node --check`);
process.exit(bad ? 1 : 0);
