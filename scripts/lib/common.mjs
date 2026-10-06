// Shared helpers for scripts/*.mjs (doctor, teardown, smoke-prod). Node 22+, no dependencies.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DEPLOYED_URL = 'https://ignura.com/astrahack';
export const LOCAL_URL = 'http://localhost:3000';

// .env then .env.local from the repo root. Real environment variables win (loadEnvFile never overrides them).
export function loadEnv(root = ROOT) {
  for (const name of ['.env', '.env.local']) {
    try { process.loadEnvFile(join(root, name)); } catch { /* file missing: fine */ }
  }
}

export const trimUrl = (u) => String(u || '').replace(/\/+$/, '');

// ---------- tiny CLI flag parser: --name, --name value, --name=value ----------
export function parseFlags(argv, spec) {
  const out = { _: [] };
  for (const [k, v] of Object.entries(spec)) if ('default' in v) out[k] = v.default;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) { out._.push(t); continue; }
    const eq = t.indexOf('=');
    const name = eq > 0 ? t.slice(2, eq) : t.slice(2);
    const def = spec[name];
    if (!def) throw new Error(`Unknown option --${name}`);
    if (def.type === 'boolean') out[name] = eq > 0 ? t.slice(eq + 1) !== 'false' : true;
    else {
      const val = eq > 0 ? t.slice(eq + 1) : argv[++i];
      if (val === undefined) throw new Error(`--${name} needs a value`);
      out[name] = def.type === 'number' ? Number(val) : val;
    }
  }
  return out;
}

// ---------- http ----------
export async function fetchT(url, opts = {}, ms = 10000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(timer); }
}

export const errText = (e) => e?.cause?.code || e?.cause?.message || (e?.name === 'AbortError' ? 'timed out' : e?.message) || String(e);

// GET <base>/api/state. Never throws.
export async function probeCanvas(base, ms = 8000) {
  const url = `${trimUrl(base)}/api/state`;
  try {
    const res = await fetchT(url, { cache: 'no-store' }, ms);
    const type = res.headers.get('content-type') || '';
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    if (!type.includes('json')) return { ok: false, status: res.status, error: `not the canvas (content-type ${type || 'none'})` };
    const body = await res.json();
    if (!Array.isArray(body?.ops)) return { ok: false, status: res.status, error: 'response has no ops[] (not the canvas API)' };
    return { ok: true, seq: body.seq ?? 0, ops: body.ops, count: body.ops.length };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// ---------- tools ----------
export function which(cmd, env = process.env) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (env.PATH || '').split(delimiter)) {
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      if (dir && existsSync(p)) return p;
    }
  }
  return null;
}

export function ffmpegPath(env = process.env) {
  if (env.ASTRAHACK_FFMPEG && existsSync(env.ASTRAHACK_FFMPEG)) return env.ASTRAHACK_FFMPEG;
  return which('ffmpeg', env);
}

export function nodeAtLeast(major, minor, v = process.versions.node) {
  const [a, b] = v.split('.').map(Number);
  return a > major || (a === major && b >= minor);
}

export function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

export const pad = (s, n) => String(s).padEnd(n);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
