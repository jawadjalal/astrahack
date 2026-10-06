#!/usr/bin/env node
// One command for the whole product: canvas up, teardown run, evidence on the board, optional marketing kit.
//
//   npm run teardown -- https://example.com            live run on a URL, drawn on the canvas as it goes
//   npm run teardown -- https://example.com --kit      ...then ads, X/Reddit campaigns and a UGC plan on the board
//   npm run teardown -- --mock                         no API keys, no Chrome: the recorded ignura.com run (real screenshots) + a sample kit
//   npm run teardown -- --mock --fixture fernly        instant fictional sample board with ranked findings (no kit)
//   npm run teardown -- --replay runs/demo             push an existing run directory (report.json or qa-agent.json)
//
// Options: --canvas URL (default $CANVAS_URL, else http://localhost:3000)  --live  --clear  --no-clear  --kit  --no-kit
//   --agent auto|astra|runner|custom  --brief TEXT  --paths /a,/b  --config journeys.json  --headed  --max-minutes N
//   --out DIR  --open  --no-start  --no-install  --dry-run
// See docs/RUNBOOK.md. Every optional module is skipped with a clear message when its key or file is missing.
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { LOCAL_URL, ROOT, errText, ffmpegPath, loadEnv, parseFlags, probeCanvas, sleep, trimUrl } from './lib/common.mjs';
import { findChrome } from '../src/chrome-path.js';

loadEnv();

const USAGE = `usage: npm run teardown -- <url> [options]
       npm run teardown -- --mock [--fixture ignura|fernly]
       npm run teardown -- --replay <runDir>

  --canvas URL       where to draw (default $CANVAS_URL, else ${LOCAL_URL}). A localhost canvas is started for you if it is down.
  --live             animate: one step at a time instead of all at once
  --clear / --no-clear  wipe the board first / keep what is there. Default: a localhost canvas is cleared, a REMOTE canvas (the shared
                     https://ignura.com/astrahack board) is never cleared unless you pass --clear
  --kit              also generate ads + X/Reddit campaigns + a UGC plan and draw them (always on for --mock --fixture ignura)
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
    canvas: { type: 'string' }, live: { type: 'boolean' }, 'no-clear': { type: 'boolean' }, clear: { type: 'boolean' }, kit: { type: 'boolean' }, 'no-kit': { type: 'boolean' },
    mock: { type: 'boolean' }, fixture: { type: 'string', default: 'ignura' }, replay: { type: 'string' }, agent: { type: 'string', default: 'auto' },
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
const wantKit = flags['no-kit'] ? false : flags.kit || (mode === 'mock' && flags.fixture === 'ignura');
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
// Clearing wipes everything for everyone. Local boards are cleared by default; a remote (shared) board only with an explicit --clear.
const isLocalCanvas = () => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(CANVAS).hostname);
const shouldClear = () => (flags['no-clear'] ? false : flags.clear || isLocalCanvas());
const clearArgs = () => (shouldClear() ? ['--clear'] : []);
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
  const code = await run(node, [join(ROOT, 'canvas/scripts/seed-demo.mjs'), '--canvas', CANVAS, ...liveArgs(), ...(shouldClear() ? [] : ['--no-clear'])]);
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
    if (shouldClear()) args.push('--clear-canvas');
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

// Inputs for canvas/scripts/push-kit.mjs: { ads: dir|null, campaigns: [dir], ugc: file|null, notes }
async function resolveKit(board) {
  const kit = { ads: null, campaigns: [], ugc: null };
  const env = process.env;
  const have = (f) => existsSync(join(ROOT, f));

  if (mode === 'mock') {
    if (flags.fixture !== 'ignura') { note('kit: the Fernly sample has no kit fixtures; use --fixture ignura for the full three-lane board'); return null; }
    const fx = join(ROOT, 'scripts/fixtures/mock-kit');
    kit.ads = join(fx, 'ads');
    kit.campaigns = [join(fx, 'campaigns')];
    kit.ugc = join(ROOT, 'ugc/fixtures/ignura/ugc-plan.json');
    console.log('    sample kit from scripts/fixtures/mock-kit: placeholder ad images, sample X/Reddit drafts, the ignura UGC plan (no model was called)');
    return kit;
  }

  const kitDir = join(board.runDir || resolve(flags.out || join(ROOT, 'runs', `teardown-${stamp()}`)), 'kit');
  mkdirSync(kitDir, { recursive: true });
  const briefFile = join(kitDir, 'brief.txt');
  writeFileSync(briefFile, briefFrom(board.report, url));

  // ads: real images with a key, otherwise the five prompts only (push-kit draws grey "not generated yet" cards with the art direction)
  const imgProvider = (env.IMAGE_PROVIDER || 'gemini').toLowerCase();
  const imgKey = imgProvider === 'openai' ? env.OPENAI_API_KEY : env.GEMINI_API_KEY;
  if (!have('generate.mjs')) note('ads: generate.mjs not found');
  else {
    const out = join(kitDir, 'ads');
    const dry = !(imgKey || '').trim();
    if (dry) note(`ads: ${imgProvider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'} not set, so the board gets the five ad prompts as grey cards instead of images`);
    const code = await run(node, [join(ROOT, 'generate.mjs'), '--prompt-file', briefFile, '--out', out, ...(dry ? ['--dry-run'] : [])]);
    kit.ads = latest(out, 'ads-');
    if (!kit.ads) note(`ads: generator produced nothing (exit ${code})`);
  }

  // campaigns: need Gemini (a dry run writes prompts only, nothing to draw)
  if (!have('campaigns.mjs')) note('campaigns: campaigns.mjs not found');
  else if (!(env.GEMINI_API_KEY || '').trim()) note('campaigns: GEMINI_API_KEY not set (X/Reddit drafts are not generated)');
  else {
    const out = join(kitDir, 'campaigns');
    const code = await run(node, [join(ROOT, 'campaigns.mjs'), '--prompt-file', briefFile, '--out', out]);
    const dir = latest(out, 'campaigns-');
    if (dir) kit.campaigns.push(dir); else note(`campaigns: no campaign files produced (exit ${code})`);
  }

  // ugc: a model with a key, the deterministic grounded plan without one
  if (!have('bin/ugc.js')) note('ugc: bin/ugc.js not found');
  else if (!board.runDir || !existsSync(join(board.runDir, 'report.json'))) note('ugc: needs a runner report.json in the run directory');
  else {
    const hasKey = (env.GEMINI_API_KEY || env.OPENAI_API_KEY || '').trim();
    const out = join(kitDir, 'ugc');
    if (!hasKey) console.log('    ugc: no model key, using the deterministic grounded plan (--mock)');
    const code = await run(node, [join(ROOT, 'bin/ugc.js'), board.runDir, '--brief-file', briefFile, '--out', out, ...(hasKey ? [] : ['--mock'])]);
    if (existsSync(join(out, 'ugc-plan.json'))) kit.ugc = join(out, 'ugc-plan.json');
    else note(`ugc: planner exited ${code} (message above). A run with very few pages gives it too little to plan from; pass --paths /a,/b to visit more`);
  }
  return kit;
}

function latest(dir, prefix) {
  try {
    const names = readdirSync(dir).filter((n) => n.startsWith(prefix)).sort();
    return names.length ? join(dir, names.at(-1)) : null;
  } catch { return null; }
}

async function pushKit(kit, board) {
  const script = join(ROOT, 'canvas/scripts/push-kit.mjs');
  if (!existsSync(script)) { note('kit: canvas/scripts/push-kit.mjs not found (pull main)'); return false; }
  const args = [script];
  if (kit.ads) args.push('--ads', kit.ads);
  for (const c of kit.campaigns) args.push('--campaigns', c);
  if (kit.ugc) args.push('--ugc', kit.ugc);
  if (!kit.ads && !kit.campaigns.length && !kit.ugc) { note('kit: nothing to draw (every generator was skipped)'); return false; }
  if (board.runDir && ['report.json', 'qa-agent.json'].some((f) => existsSync(join(board.runDir, f)))) args.push('--run', board.runDir);
  args.push('--canvas', CANVAS, ...liveArgs(), ...delayArgs());
  args.push('--replace'); // only removes kit-* / ad-* / gtm-* / ugc-* ids, never the teardown
  const code = await run(node, args);
  if (code !== 0) { note(`kit: push-kit.mjs failed (exit ${code})`); return false; }
  return true;
}

function openBrowser(u) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [u]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : ['xdg-open', [u]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* no opener */ }
}

// ---------------------------------------------------------------------------------------------------------------
async function main() {
  console.log(`AstraHack teardown  mode=${mode}${url ? `  url=${url}` : ''}  canvas=${CANVAS}${flags['dry-run'] ? '  (dry run)' : ''}`);
  if (mode === 'mock' && !isLocalCanvas() && !flags.canvas) throw new Error(`CANVAS_URL points at a remote board (${CANVAS}). Sample data should not land on a shared board by accident: pass --canvas ${CANVAS} explicitly if you mean it, or unset CANVAS_URL for the local canvas.`);
  step(1, 'canvas');
  const canvas = await ensureCanvas();
  console.log(shouldClear() ? '    the board is cleared first (local canvas; --no-clear keeps it)' : '    existing board content is kept (shared/remote canvas; pass --clear to wipe it)');

  step(2, mode === 'mock' ? 'sample board' : mode === 'replay' ? 'replay a recorded run' : 'teardown run');
  const board = mode === 'mock' ? await boardMock() : mode === 'replay' ? await boardReplay() : await boardLive();

  let kitDone = false;
  if (wantKit) {
    step(3, 'launch kit: ads, campaigns, UGC plan');
    try { const kit = await resolveKit(board); if (kit) kitDone = await pushKit(kit, board); }
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
