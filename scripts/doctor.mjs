#!/usr/bin/env node
// npm run doctor: checks this machine can run the AstraHack demo and prints exactly what to fix.
//
//   npm run doctor
//   npm run doctor -- --launch          also start a headless Chrome and wait for its DevTools port
//   npm run doctor -- --canvas URL      local canvas to check (default $CANVAS_URL, else http://localhost:3000)
//   npm run doctor -- --offline         skip the deployed-canvas check
//   npm run doctor -- --json            machine-readable result
//
// Exit 1 only when something blocks even the mock demo (node version, canvas dependencies). Missing keys, Chrome
// or ffmpeg are warnings: they only limit the live modes. Secrets are never printed, only "set" or "missing".
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromeCandidates, findChrome } from '../src/chrome-path.js';
import { DEPLOYED_URL, LOCAL_URL, ROOT, ffmpegPath, loadEnv, nodeAtLeast, parseFlags, probeCanvas, sh, trimUrl } from './lib/common.mjs';

loadEnv();
const flags = parseFlags(process.argv.slice(2), {
  canvas: { type: 'string' }, deployed: { type: 'string' }, launch: { type: 'boolean' }, offline: { type: 'boolean' },
  json: { type: 'boolean' }, strict: { type: 'boolean' }, help: { type: 'boolean' },
});
if (flags.help) {
  console.log('usage: npm run doctor -- [--launch] [--canvas URL] [--deployed URL] [--offline] [--json] [--strict]');
  process.exit(0);
}

const local = trimUrl(flags.canvas || process.env.CANVAS_URL || LOCAL_URL);
const deployed = trimUrl(flags.deployed || DEPLOYED_URL);
const results = [];
const add = (level, name, detail, fix) => results.push({ level, name, detail, fix });
const ok = (name, detail) => add('ok', name, detail);
const warn = (name, detail, fix) => add('warn', name, detail, fix);
const fail = (name, detail, fix) => add('fail', name, detail, fix);

// ---- node
const nv = process.versions.node;
if (!nodeAtLeast(22, 9)) fail('node', `v${nv}, needs >= 22.18`, 'Install Node 22 LTS or newer (https://nodejs.org, or `nvm install 22`).');
else if (!nodeAtLeast(22, 18)) warn('node', `v${nv}; canvas scripts import .ts files and need >= 22.18`, 'Upgrade Node: `nvm install 22 && nvm use 22`.');
else ok('node', `v${nv}`);

// ---- repo + canvas dependencies
const nm = join(ROOT, 'canvas/node_modules');
if (!existsSync(join(nm, 'next')) || !existsSync(join(nm, 'tldraw'))) {
  fail('canvas dependencies', 'canvas/node_modules is missing or incomplete', 'Run: npm run setup   (same as: cd canvas && npm install)');
} else ok('canvas dependencies', 'installed');
const git = sh('git', ['-C', ROOT, 'status', '--porcelain=v1', '-b']);
if (git.status === 0) {
  const head = git.stdout.split('\n')[0];
  const behind = /behind (\d+)/.exec(head)?.[1];
  if (behind) warn('git', `${head.slice(3)}`, `You are ${behind} commit(s) behind. Run: git pull --rebase origin main`);
  else ok('git', head.slice(3) || 'repo');
}

// ---- keys (presence only, never the value)
const keyInfo = [
  ['OPENAI_API_KEY', 'the Astra computer-use agent (agent/run.mjs, npm run qa), QA analysis, UGC with provider openai'],
  ['GEMINI_API_KEY', 'ad creatives (npm run generate), campaigns (npm run campaigns), UGC with provider gemini'],
];
for (const [k, why] of keyInfo) {
  if ((process.env[k] || '').trim()) ok(k, 'set');
  else warn(k, 'missing', `Only needed for ${why}. Add it to .env (cp .env.example .env). \`npm run teardown -- --mock\` needs no keys.`);
}
if (!existsSync(join(ROOT, '.env'))) warn('.env', 'no .env file in the repo root', 'cp .env.example .env, then fill in the keys you have (optional).');

// ---- Chrome and ffmpeg
const chrome = findChrome();
if (chrome) ok('chrome', chrome + (process.env.ASTRAHACK_CHROME && chrome === process.env.ASTRAHACK_CHROME ? ' (ASTRAHACK_CHROME)' : ''));
else {
  const hint = process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome';
  warn('chrome', `none found (looked at ${chromeCandidates().length} locations)`, `Live runs need Chrome or Chromium. Install it, or set ASTRAHACK_CHROME="${hint}" in .env. Or: npx playwright install chromium (found automatically).`);
}
const ff = ffmpegPath();
if (ff) ok('ffmpeg', ff);
else warn('ffmpeg', 'not found (optional)', 'Only for screen recordings. macOS: brew install ffmpeg. Or set ASTRAHACK_FFMPEG=/path/to/ffmpeg.');
if (process.platform === 'darwin' && chrome) {
  ok('macos permissions', 'cannot be checked from Node. Needed only for `agent/run.mjs --backend macos`: System Settings > Privacy & Security > Screen Recording and Accessibility, for your terminal app (then restart it). The default cdp backend needs neither.');
}

// ---- optional: really launch a headless Chrome
if (flags.launch) {
  if (!chrome) fail('chrome launch', 'skipped: no Chrome', 'Install Chrome first.');
  else {
    const t0 = Date.now();
    try {
      const { launchBrowser } = await import(pathToFileURL(join(ROOT, 'src/cdp.js')).href);
      const b = await launchBrowser({ executable: chrome });
      await b.close();
      ok('chrome launch', `headless Chrome exposed its DevTools port in ${Date.now() - t0} ms`);
    } catch (e) {
      fail('chrome launch', e.message, 'Chrome started but gave no DevTools port. Quit other Chrome windows using the same binary, unlock the screen (headless Chrome can hang on a locked or asleep macOS display), and retry.');
    }
  }
}

// ---- canvases
const lp = await probeCanvas(local, 6000);
if (lp.ok) ok(`canvas (local) ${local}`, `reachable, ${lp.count} ops on the board, seq ${lp.seq}`);
else warn(`canvas (local) ${local}`, lp.error, 'Not running. Start it: npm run canvas   (or: cd canvas && npm run dev). `npm run teardown` starts it for you. Use PORT=3100 for another port.');

if (flags.offline) warn('canvas (deployed)', 'skipped (--offline)');
else {
  const dp = await probeCanvas(deployed, 15000);
  if (!dp.ok) {
    warn(`canvas (deployed) ${deployed}`, dp.error, 'The shared board is unreachable. Ask @jawadjalal (canvas/deploy). Local demos still work. Run `npm run smoke:prod` once it is back.');
  } else {
    // Blob-backed op logs use time-based sequence numbers (ms * 1000, about 1.7e15). The in-memory store counts 1, 2, 3...
    if (dp.seq > 1e12) ok(`canvas (deployed) ${deployed}`, `reachable, Blob-backed (time-based seq), ${dp.count} ops on the board`);
    else if (dp.seq === 0) warn(`canvas (deployed) ${deployed}`, 'reachable, board is empty, so Blob vs memory store cannot be told apart from /api/state alone', 'Run: npm run smoke:prod. It writes and reads back a few ops and an upload.');
    else warn(`canvas (deployed) ${deployed}`, `reachable but seq=${dp.seq} looks like the in-memory store (data would vanish between serverless instances)`, 'On Vercel set CANVAS_STORE=blob and link a Blob store (BLOB_READ_WRITE_TOKEN), then redeploy. Ask @jawadjalal.');
  }
}

// ---- report
if (flags.json) {
  console.log(JSON.stringify({ ok: !results.some((r) => r.level === 'fail'), results }, null, 2));
} else {
  const mark = { ok: ' ok ', warn: 'warn', fail: 'FAIL' };
  console.log('AstraHack doctor\n');
  for (const r of results) console.log(`  [${mark[r.level]}] ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
  const todo = results.filter((r) => r.fix);
  if (todo.length) {
    console.log('\nTo fix:');
    for (const r of todo) console.log(`  ${r.level === 'fail' ? '!' : '-'} ${r.name}: ${r.fix}`);
  }
  const fails = results.filter((r) => r.level === 'fail').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  console.log(`\n${fails ? `${fails} blocking problem(s).` : 'Nothing blocks the mock demo.'} ${warns} warning(s).`);
  console.log(fails ? '' : 'Try it: npm run teardown -- --mock');
}
process.exit(results.some((r) => r.level === 'fail' || (flags.strict && r.level === 'warn')) ? 1 : 0);
