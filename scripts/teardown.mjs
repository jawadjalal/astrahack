#!/usr/bin/env node
// One command for the whole product: canvas up, teardown run, evidence on the board, optional marketing kit.
//
//   npm run teardown -- https://example.com            live run on a URL, drawn on the canvas as it goes
//   npm run teardown -- https://example.com --kit      ...then ads, X/Reddit campaigns and a UGC plan on the board
//   npm run teardown -- --mock                         no API keys, no Chrome: prepared sample board + sample kit
//   npm run teardown -- --mock --fixture ignura        same, using the recorded ignura.com run (real screenshots)
//   npm run teardown -- --replay runs/demo             push an existing run directory (report.json or qa-agent.json)
//
// Options: --canvas URL (default $CANVAS_URL, else http://localhost:3000)  --live  --no-clear  --kit  --no-kit
//   --agent auto|astra|runner|custom  --brief TEXT  --paths /a,/b  --config journeys.json  --headed  --max-minutes N
//   --out DIR  --open  --no-start  --no-install  --dry-run
// See docs/RUNBOOK.md. Every optional module is skipped with a clear message when its key or file is missing.
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { LOCAL_URL, ROOT, errText, fetchT, ffmpegPath, loadEnv, parseFlags, probeCanvas, sleep, trimUrl } from './lib/common.mjs';
import { boardBounds, kitToLaneOps } from './lib/kit-lane.mjs';
import { mockKit } from './lib/mock-kit.mjs';
import { findChrome } from '../src/chrome-path.js';

loadEnv();

const USAGE = `usage: npm run teardown -- <url> [options]
       npm run teardown -- --mock [--fixture fernly|ignura]
       npm run teardown -- --replay <runDir>

  --canvas URL       where to draw (default $CANVAS_URL, else ${LOCAL_URL}). A localhost canvas is started for you if it is down.
  --live             animate: one step at a time instead of all at once
  --no-clear         keep what is already on the board (default: clear it first)
  --kit              also generate ads + X/Reddit campaigns + a UGC plan and draw them (live mode; always on for --mock)
  --no-kit           skip the kit
  --agent MODE       auto (default), astra (agent/run.mjs, needs OPENAI_API_KEY), runner (scripted journeys, no key), custom ($ASTRAHACK_AGENT_CMD)
  --brief TEXT       what the agent should look at, and the product context for the kit
  --paths /a,/b      extra paths for the scripted runner (default: the home page)
  --config FILE      a journeys JSON for the scripted runner (see examples/website.json)
  --max-minutes N    time limit for the astra agent (default 10)
  --headed           show the browser
  --out DIR          run directory (default runs/teardown-<host>-<time>)
  --open             open the board in your browser at the end
  --no-start         never start a local canvas; fail if it is down
  --no-install       never run npm install in canvas/
  --dry-run          print what would run, change nothing`;

let flags;
try {
  flags = parseFlags(process.argv.slice(2), {
    canvas: { type: 'string' }, live: { type: 'boolean' }, 'no-clear': { type: 'boolean' }, kit: { type: 'boolean' }, 'no-kit': { type: 'boolean' },
    mock: { type: 'boolean' }, fixture: { type: 'string', default: 'fernly' }, replay: { type: 'string' }, agent: { type: 'string', default: 'auto' },
    brief: { type: 'string', default: '' }, paths: { type: 'string', default: '' }, config: { type: 'string' }, headed: { type: 'boolean' },
    'max-minutes': { type: 'number', default: 10 }, out: { type: 'string' }, open: { type: 'boolean' }, 'no-start': { type: 'boolean' },
    'no-install': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, delay: { type: 'number' }, help: { type: 'boolean' },
  });
} catch (e) { console.error(`${e.message}\n\n${USAGE}`); process.exit(2); }
if (flags.help) { console.log(USAGE); process.exit(0); }

const url = flags._[0];
const mode = flags.mock ? 'mock' : flags.replay ? 'replay' : url ? 'live' : null;
if (!mode) { console.error(`Give a <url>, --mock, or --replay <runDir>.\n\n${USAGE}`); process.exit(2); }
if (!['fernly', 'ignura'].includes(flags.fixture)) { console.error('--fixture must be fernly or ignura'); process.exit(2); }
if (!['auto', 'astra', 'runner', 'custom'].includes(flags.agent)) { console.error('--agent must be auto, astra, runner or custom'); process.exit(2); }

let CANVAS = trimUrl(flags.canvas || process.env.CANVAS_URL || LOCAL_URL);
const api = (p) => `${CANVAS}/api${p}`;
const wantKit = flags['no-kit'] ? false : flags.kit || mode === 'mock';
const notes = []; // things skipped or degraded, printed at the end
const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const note = (msg) => { notes.push(msg); console.log(`    skipped: ${msg}`); };
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/[^a-z0-9.-]/gi, '_'); } catch { return 'site'; } };
const node = process.execPath;

// Run a child to completion with its output on our terminal. Resolves to the exit code. Ctrl-C reaches it too.
function run(cmd, args, opts = {}) {
  console.log(`    $ ${[cmd === node ? 'node' : cmd, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  if (flags['dry-run']) return Promise.resolve(0);
  return new Promise((res) => {
    const child = spawn(cmd, args, { cwd: opts.cwd || ROOT, env: { ...process.env, ...opts.env }, stdio: 'inherit' });
    child.on('error', (e) => { console.error(`    could not start ${cmd}: ${e.message}`); res(127); });
    child.on('exit', (code, sig) => res(code ?? (sig ? 130 : 1)));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// 1. canvas: detect, or start a local one
// ---------------------------------------------------------------------------------------------------------------
async function ensureCanvas() {
  const probe = await probeCanvas(CANVAS, 6000);
  if (probe.ok) { console.log(`    canvas up at ${CANVAS} (${probe.count} ops on the board)`); return { started: null }; }
  const u = new URL(CANVAS);
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  if (!local) throw new Error(`canvas at ${CANVAS} is not reachable (${probe.error}). Check the URL, or run: npm run doctor`);
  if (probe.status && !probe.ok && probe.error?.startsWith('not the canvas')) throw new Error(`something else is listening on ${u.host}: ${probe.error}. Pick another port: PORT=3100 CANVAS_URL=http://localhost:3100 npm run teardown -- ...`);
  if (flags['no-start']) throw new Error(`canvas at ${CANVAS} is down and --no-start was given. Start it: npm run canvas`);
  if (u.pathname !== '/' && u.pathname !== '') throw new Error(`cannot auto-start a canvas under base path ${u.pathname}; start it yourself with NEXT_PUBLIC_BASE_PATH=${u.pathname.replace(/\/$/, '')}`);

  const nm = join(ROOT, 'canvas/node_modules/next');
  if (!existsSync(nm)) {
    if (flags['no-install']) throw new Error('canvas dependencies are missing. Run: npm run setup');
    console.log('    canvas/node_modules missing: running npm install in canvas/ (about 10 s)');
    const code = await run('npm', ['install', '--prefix', 'canvas', '--no-audit', '--no-fund']);
    if (code !== 0) throw new Error('npm install in canvas/ failed. Run `npm run setup` yourself and read the error.');
  }
  if (flags['dry-run']) return { started: null };
  const port = u.port || '80';
  mkdirSync(join(ROOT, 'runs'), { recursive: true });
  const logPath = join(ROOT, 'runs', `canvas-${port}.log`);
  const fd = openSync(logPath, 'a');
  console.log(`    canvas is down: starting it on port ${port} (log: runs/canvas-${port}.log)`);
  const child = spawn('npm', ['run', 'dev', '--prefix', 'canvas'], { cwd: ROOT, env: { ...process.env, PORT: port }, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    await sleep(1000);
    if (child.exitCode !== null) {
      // Next allows one dev server per canvas/ checkout. If one is already running (another port, maybe a teammate shell), use it.
      const log = readFileSync(logPath, "utf8");
      const other = /existing server at (http:\/\/localhost:\d+)/.exec(log)?.[1];
      if (other && (await probeCanvas(other, 4000)).ok) { CANVAS = other; console.log(`    another canvas dev server is already running: using ${other} instead of ${u.origin}`); return { started: null }; }
      throw new Error(`the canvas exited right away (code ${child.exitCode}). See runs/canvas-${port}.log`);
    }
    const p = await probeCanvas(CANVAS, 4000);
    if (p.ok) { console.log(`    canvas ready after ${Math.round((Date.now() - t0) / 1000)} s (pid ${child.pid}, left running; stop it with: kill -- -${child.pid})`); return { started: child.pid }; }
  }
  throw new Error(`canvas did not answer within 120 s. See runs/canvas-${port}.log`);
}

// ---------------------------------------------------------------------------------------------------------------
// 2. the teardown itself -> a run directory (or the board directly)
// ---------------------------------------------------------------------------------------------------------------
const clearArgs = () => (flags['no-clear'] ? [] : ['--clear']);
const liveArgs = () => (flags.live ? ['--live'] : []);
const delayArgs = () => (flags.delay != null ? ['--delay', String(flags.delay)] : []);

async function pushRun(dir) {
  const code = await run(node, [join(ROOT, 'canvas/scripts/push-run.mjs'), dir, '--canvas', CANVAS, ...clearArgs(), ...liveArgs(), ...delayArgs()]);
  if (code !== 0) throw new Error(`push-run failed (exit ${code}). If it says it cannot load runToOps.ts you need Node >= 22.18.`);
}

async function boardMock() {
  if (flags.fixture === 'ignura') {
    const dir = join(ROOT, 'ugc/fixtures/ignura');
    console.log('    fixture: a recorded run of ignura.com (real screenshots). Say "recorded run" out loud.');
    await pushRun(dir);
    return { runDir: dir, report: readJson(join(dir, 'report.json')), source: 'fixture ignura' };
  }
  console.log('    fixture: "Fernly", a fictional plant-care app. Say "prepared sample run" out loud.');
  const code = await run(node, [join(ROOT, 'canvas/scripts/seed-demo.mjs'), '--canvas', CANVAS, ...liveArgs(), ...(flags['no-clear'] ? ['--no-clear'] : [])]);
  if (code !== 0) throw new Error(`seed-demo failed (exit ${code})`);
  return { runDir: null, report: { product: { title: 'Fernly', description: 'A plant-care app: reminders, light checks and care tips.' } }, source: 'seed Fernly' };
}

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

// Same-origin pages worth visiting, found by the key-less crawler (bin/qa.js crawl). Falls back to the home page.
async function discoverPaths(target, out) {
  const cfg = join(out, 'crawl-config.json');
  writeFileSync(cfg, JSON.stringify({ url: target, maxPages: 6, maxDepth: 1 }));
  console.log('    discovering pages with the crawler (no key needed) ...');
  const code = await run(node, [join(ROOT, 'bin/qa.js'), 'crawl', cfg, '--output', join(out, 'crawl')]);
  const crawl = readJson(join(out, 'crawl', 'crawl.json'));
  const paths = [];
  for (const pg of crawl?.pages || []) {
    if (pg.status !== 'visited' || !pg.screenshot) continue;
    try { const u = new URL(pg.finalUrl || pg.url); paths.push(u.pathname + u.search); } catch { /* skip */ }
  }
  const uniq = [...new Set(paths)].slice(0, 5);
  if (!uniq.length) { console.log(`    crawler found nothing (exit ${code}); using the home page only`); return ['/']; }
  console.log(`    pages: ${uniq.join(' ')}`);
  return uniq;
}

async function journeyConfig(target, out) {
  if (flags.config) return resolve(flags.config);
  const explicit = flags.paths.split(',').map((p) => p.trim()).filter(Boolean);
  const paths = explicit.length ? ['/', ...explicit.filter((p) => p !== '/')] : flags['dry-run'] ? ['/'] : await discoverPaths(target, out);
  const file = join(out, 'journeys.json');
  writeFileSync(file, JSON.stringify({ name: `Teardown of ${hostOf(target)}`, target: { type: 'website', url: target }, journeys: paths.map((p, i) => ({ name: p === '/' ? 'Home page' : p, video: i === 0 && Boolean(ffmpegPath()), steps: [{ action: 'goto', url: p, settleMs: 2500 }, { action: 'observe' }] })) }, null, 2));
  return file;
}

function pickAgent() {
  const customCmd = (process.env.ASTRAHACK_AGENT_CMD || '').trim();
  if (flags.agent === 'custom') return customCmd ? 'custom' : null;
  if (flags.agent !== 'auto') return flags.agent;
  if (customCmd) return 'custom';
  if ((process.env.OPENAI_API_KEY || '').trim()) return 'astra';
  return 'runner';
}

async function boardLive() {
  let agent = pickAgent();
  if (!agent) throw new Error('--agent custom needs ASTRAHACK_AGENT_CMD (see .env.example)');
  if (agent === 'astra' && !(process.env.OPENAI_API_KEY || '').trim()) throw new Error('--agent astra needs OPENAI_API_KEY in .env. Use --agent runner for scripted journeys without a key, or --mock for the sample board.');
  const chrome = findChrome();
  if (agent !== 'custom' && !chrome && !flags['dry-run']) throw new Error('no Chrome/Chromium found. Install Chrome or set ASTRAHACK_CHROME in .env (run: npm run doctor). Or use --mock, which needs no browser.');
  const out = resolve(flags.out || join(ROOT, 'runs', `teardown-${hostOf(url)}-${stamp()}`));
  mkdirSync(out, { recursive: true });
  console.log(`    agent: ${agent}${agent === 'runner' ? ' (scripted journeys, no model; pass OPENAI_API_KEY for the Astra agent)' : ''}`);
  console.log(`    run directory: ${out}`);

  if (agent === 'astra') {
    const args = [join(ROOT, 'agent/run.mjs'), url, '--canvas', CANVAS, '--out', out, '--max-minutes', String(flags['max-minutes'])];
    if (flags.brief) args.push('--brief', flags.brief);
    if (!flags['no-clear']) args.push('--clear-canvas');
    if (flags.headed) args.push('--headed');
    const code = await run(node, args);
    if (code === 2 || code === 127) throw new Error(`the Astra agent failed to run (exit ${code})`);
    return { runDir: out, report: readJson(join(out, 'report.json')), source: 'astra agent (streamed live)' };
  }
  if (agent === 'custom') {
    const cmd = process.env.ASTRAHACK_AGENT_CMD.replaceAll('{url}', url).replaceAll('{out}', out).replaceAll('{canvas}', CANVAS);
    console.log('    custom agent from ASTRAHACK_AGENT_CMD');
    const code = await run(process.env.SHELL || 'sh', ['-c', cmd]);
    if (code !== 0 && code !== 1) throw new Error(`custom agent exited ${code}`);
    if (!['report.json', 'qa-agent.json'].some((f) => existsSync(join(out, f)))) throw new Error(`custom agent left no report.json or qa-agent.json in ${out}`);
    await pushRun(out);
    return { runDir: out, report: readJson(join(out, 'report.json')) || readJson(join(out, 'qa-agent.json')), source: 'custom agent' };
  }
  // runner: scripted journeys through CDP
  const args = [join(ROOT, 'bin/astrahack.js'), await journeyConfig(url, out), '--output', out];
  if (flags.headed) args.push('--headed');
  const ff = ffmpegPath();
  if (ff) args.push('--ffmpeg', ff);
  const code = await run(node, args, { env: chrome ? { ASTRAHACK_CHROME: process.env.ASTRAHACK_CHROME || chrome } : {} });
  if (code === 2 || code === 127) throw new Error(`the runner failed (exit ${code}); no report to draw. Run: npm run doctor -- --launch`);
  await pushRun(out); // exit 1 only means QA findings were reported
  return { runDir: out, report: readJson(join(out, 'report.json')), source: 'scripted runner' };
}

async function boardReplay() {
  const dir = resolve(flags.replay);
  if (!existsSync(dir)) throw new Error(`--replay: ${dir} does not exist. runs/ is git-ignored, so a run only exists on the laptop that made it. Committed samples: ugc/fixtures/ignura`);
  console.log('    replay of a recorded run. Say "recorded run" out loud, never "live".');
  await pushRun(dir);
  return { runDir: dir, report: readJson(join(dir, 'report.json')) || readJson(join(dir, 'qa-agent.json')), source: `replay ${basename(dir)}` };
}

// ---------------------------------------------------------------------------------------------------------------
// 3. kit: ads, campaigns, UGC plan -> lane on the board
// ---------------------------------------------------------------------------------------------------------------
function briefFrom(report, target) {
  const p = report?.product || {};
  const bits = [];
  if (flags.brief) bits.push(flags.brief);
  bits.push(`Product: ${p.title || report?.name || target || 'the product'}${target ? ` (${target})` : ''}.`);
  if (p.description) bits.push(`What it says it is: ${p.description}`);
  const heads = (p.headings || []).map((h) => h.text).filter(Boolean).slice(0, 8);
  if (heads.length) bits.push(`Headings seen on the site: ${heads.join(' | ')}.`);
  const fs = (report?.findings || []).slice(0, 5).map((f) => f.summary || f.title).filter(Boolean);
  if (fs.length) bits.push(`QA friction observed (do not use as ad claims): ${fs.join('; ')}.`);
  bits.push('Use only facts stated above. Mark anything else as an assumption.');
  return bits.join('\n');
}

async function resolveKit(board) {
  const report = board.report;
  const name = report?.product?.title || report?.name || (url ? hostOf(url) : 'Your product');
  if (mode === 'mock') {
    const kit = mockKit({ name: flags.fixture === 'fernly' ? 'Fernly' : name.split(/[·|–-]/)[0].trim(), oneLiner: report?.product?.description?.slice(0, 120) });
    if (flags.fixture === 'ignura') {
      const plan = readJson(join(ROOT, 'ugc/fixtures/ignura/ugc-plan.json'));
      if (plan) kit.ugc = { source: 'fixture plan', hooks: plan.hooks.slice(0, 6), scripts: plan.scripts };
    }
    return kit;
  }
  const kitDir = join(board.runDir || resolve(flags.out || join(ROOT, 'runs', `teardown-${stamp()}`)), 'kit');
  mkdirSync(kitDir, { recursive: true });
  const brief = briefFrom(report, url);
  const briefFile = join(kitDir, 'brief.txt');
  writeFileSync(briefFile, brief);
  const kit = { label: `generated from ${board.source}`, ads: [], campaigns: [], ugc: null };
  const env = process.env;

  // ads
  const imgProvider = (env.IMAGE_PROVIDER || 'gemini').toLowerCase();
  const imgKey = imgProvider === 'openai' ? env.OPENAI_API_KEY : env.GEMINI_API_KEY;
  if (!existsSync(join(ROOT, 'generate.mjs'))) note('ads: generate.mjs not found');
  else if (!(imgKey || '').trim()) note(`ads: ${imgProvider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'} not set (npm run generate -- --prompt-file ${briefFile} --dry-run shows the five prompts)`);
  else {
    const out = join(kitDir, 'ads');
    const code = await run(node, [join(ROOT, 'generate.mjs'), '--prompt-file', briefFile, '--out', out]);
    const dir = latest(out, 'ads-');
    const manifest = dir && readJson(join(dir, 'manifest.json'));
    if (manifest) {
      for (const c of manifest.creatives || []) if (c.status === 'complete' && existsSync(join(dir, c.filename))) kit.ads.push({ angle: c.name, headline: c.name, body: '', image: join(dir, c.filename) });
    }
    if (!kit.ads.length) note(`ads: generation produced no images (exit ${code}); see ${dir || out}`);
  }

  // campaigns
  if (!existsSync(join(ROOT, 'campaigns.mjs'))) note('campaigns: campaigns.mjs not found');
  else if (!(env.GEMINI_API_KEY || '').trim()) note(`campaigns: GEMINI_API_KEY not set (npm run campaigns -- --prompt-file ${briefFile} --dry-run shows the prompts)`);
  else {
    const out = join(kitDir, 'campaigns');
    const code = await run(node, [join(ROOT, 'campaigns.mjs'), '--prompt-file', briefFile, '--out', out]);
    const dir = latest(out, 'campaigns-');
    for (const ch of ['x', 'reddit']) {
      const c = dir && readJson(join(dir, `${ch}-campaign.json`));
      if (c) kit.campaigns.push({ channel: ch, title: c.title, objective: c.objective, posts: (c.posts || []).map((p) => ({ title: p.title || p.angle, copy: p.copy })) });
    }
    if (!kit.campaigns.length) note(`campaigns: no campaign files produced (exit ${code})`);
  }

  // ugc
  if (!existsSync(join(ROOT, 'bin/ugc.js'))) note('ugc: bin/ugc.js not found');
  else if (!board.runDir || !existsSync(join(board.runDir, 'report.json'))) note('ugc: needs a report.json in the run directory');
  else {
    const hasKey = (env.GEMINI_API_KEY || env.OPENAI_API_KEY || '').trim();
    const out = join(kitDir, 'ugc');
    const args = [join(ROOT, 'bin/ugc.js'), board.runDir, '--brief-file', briefFile, '--out', out];
    if (!hasKey) { args.push('--mock'); console.log('    ugc: no model key, using the deterministic grounded plan (--mock)'); }
    const code = await run(node, args);
    const plan = readJson(join(out, 'ugc-plan.json'));
    if (plan) kit.ugc = { source: plan.model === 'mock' ? 'deterministic, no model' : plan.model, hooks: plan.hooks.slice(0, 6), scripts: plan.scripts };
    else note(`ugc: planner failed (exit ${code}); the agent report may not match the runner report shape`);
  }
  return kit;
}

function latest(dir, prefix) {
  try {
    const names = readdirSyncSafe(dir).filter((n) => n.startsWith(prefix)).sort();
    return names.length ? join(dir, names.at(-1)) : null;
  } catch { return null; }
}
function readdirSyncSafe(d) { try { return readdirSync(d); } catch { return []; } }

async function uploadImage(src) {
  if (!src) return null;
  if (/^(data:|https?:\/\/|\/)/.test(src)) return src;
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(src);
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'image/png' }), basename(src));
  const res = await fetchT(api('/upload'), { method: 'POST', body: fd }, 60000);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.url) throw new Error(`upload ${basename(src)} failed: HTTP ${res.status} ${body.error || ''}`);
  return body.url;
}

async function pushKit(kit, board) {
  if (!kit) return;
  const pushKitScript = join(ROOT, 'canvas/scripts/push-kit.mjs');
  if (existsSync(pushKitScript) && board.runDir && mode !== 'mock') {
    console.log('    using canvas/scripts/push-kit.mjs');
    const code = await run(node, [pushKitScript, join(board.runDir, 'kit'), '--canvas', CANVAS, ...liveArgs()]);
    if (code === 0) return;
    note('push-kit.mjs failed; falling back to the built-in kit lane');
  }
  const st = await probeCanvas(CANVAS, 10000);
  const { maxX, minY } = boardBounds(st.ok ? st.ops : []);
  const { groups } = await kitToLaneOps(kit, { x: maxX + 600, y: minY, prefix: `kit${Date.now().toString(36).slice(-4)}`, resolveImage: uploadImage });
  const n = groups.flat().length;
  console.log(`    drawing the kit lane: ${kit.ads?.length || 0} ads, ${kit.campaigns?.length || 0} campaigns, ${kit.ugc?.hooks?.length || 0} hooks (${n} ops)`);
  if (flags['dry-run']) return;
  const delay = flags.delay ?? (flags.live ? 350 : 0);
  const batches = flags.live ? groups : [groups.flat()];
  for (const [i, g] of batches.entries()) {
    const res = await fetchT(api('/ops'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(g) }, 30000);
    if (!res.ok) throw new Error(`POST /api/ops failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    if (delay && i < batches.length - 1) await sleep(delay);
  }
}

function openBrowser(u) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [u]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : ['xdg-open', [u]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* no opener */ }
}

// ---------------------------------------------------------------------------------------------------------------
async function main() {
  console.log(`AstraHack teardown  mode=${mode}${url ? `  url=${url}` : ''}  canvas=${CANVAS}${flags['dry-run'] ? '  (dry run)' : ''}`);
  step(1, 'canvas');
  const canvas = await ensureCanvas();

  step(2, mode === 'mock' ? 'sample board' : mode === 'replay' ? 'replay a recorded run' : 'teardown run');
  const board = mode === 'mock' ? await boardMock() : mode === 'replay' ? await boardReplay() : await boardLive();

  let kitDone = false;
  if (wantKit) {
    step(3, 'launch kit: ads, campaigns, UGC plan');
    try { const kit = await resolveKit(board); if (kit.ads?.length || kit.campaigns?.length || kit.ugc) { await pushKit(kit, board); kitDone = true; } else note('kit: nothing to draw (all generators skipped)'); }
    catch (e) { note(`kit failed: ${errText(e)}`); }
  } else if (mode === 'live' || mode === 'replay') {
    console.log('\n(no kit requested: add --kit for ads, X/Reddit campaigns and a UGC plan)');
  }

  console.log('\n----------------------------------------------------------------');
  console.log(`done: ${board.source}${kitDone ? ' + launch kit' : ''}`);
  console.log(`board: ${CANVAS}/?view=canvas${canvas.started ? `   (canvas started by this command, pid ${canvas.started}; stop it with: kill -- -${canvas.started})` : ''}`);
  if (board.runDir) console.log(`run directory: ${board.runDir}`);
  for (const n of notes) console.log(`  - skipped: ${n}`);
  if (mode === 'mock') console.log('This is a prepared sample. Say so out loud; do not call it live.');
  if (flags.open && !flags['dry-run']) openBrowser(`${CANVAS}/?view=canvas`);
}

main().catch((e) => {
  console.error(`\nteardown failed: ${e.message}`);
  console.error('Run `npm run doctor` to see what is missing. `npm run teardown -- --mock` needs no keys or Chrome.');
  process.exit(2);
});
