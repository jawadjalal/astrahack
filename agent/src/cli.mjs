import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CdpBackend, findChrome } from './backend-cdp.mjs';
import { MacBackend } from './backend-macos.mjs';
import { CanvasStreamer, REPO_ROOT, readLocalOps } from './canvas.mjs';
import { startDemoSite } from './demo-site.mjs';
import { runTeardown } from './loop.mjs';
import { createAstraSession, DEFAULT_MODEL } from './model-astra.mjs';
import { createMockSession } from './model-mock.mjs';
import { Recorder, findFfmpeg } from './recorder.mjs';
import { SteerInbox, startSteerServer, watchSteerFile, watchStdin } from './steer.mjs';
import { StopController } from './stop.mjs';

export const USAGE = `Autonomous product teardown agent (GPT-6 Astra computer use, live on the canvas).

Usage:
  node agent/run.mjs <url> --brief "what to look at"        teardown a website / web app
  node agent/run.mjs --app <cdp-port> --brief "..."         attach to an Electron/Chromium app started with --remote-debugging-port
  node agent/run.mjs --mock                                  scripted fake model + built-in demo site, no API key needed

Options:
  --backend cdp|macos      cdp (default): Chromium via DevTools. macos: whole-desktop control (needs permissions, see docs/AGENT.md)
  --max-steps N            action batches in the explore phase (default 40)
  --max-minutes N          wall-clock limit (default 20)
  --canvas URL             canvas base URL incl. basePath (default $CANVAS_URL or http://localhost:3000)
  --dry-run                log actions, execute none (cdp: no browser; macos: no clicks/keys)
  --mock                   use the scripted fake model
  --model ID               default $ASTRA_MODEL or ${DEFAULT_MODEL}
  --effort LEVEL           reasoning effort: low|medium|high|xhigh|max (default $ASTRA_REASONING or low)
  --tool computer|function computer tool (default) or the equivalent function tool
  --no-verify              skip the verify pass; --verify-steps N (8 per finding), --max-verify N (6 findings)
  --no-record              do not record the screen
  --headed                 show the browser window (cdp, launched browsers)
  --chrome PATH, --ffmpeg PATH, --viewport WxH (1440x900)
  --allow-host HOST        extra host the browser may visit (repeatable); other sites are blocked
  --allow-risky            disable the purchase/destructive-click guard (not recommended)
  --mac-app NAME           macos: application to bring to the front / open the URL with
  --port N|off             steering/status server port (default $AGENT_PORT or 7788)
  --out DIR                output directory (default runs/teardown-<host>-<time>)
  --clear-canvas           wipe the canvas before streaming; --id-prefix P to namespace ids
  --include-design         also keep usability/visual observations (category usability|visual, severity info). Default: functional bugs only
  --ack-safety-checks      auto-acknowledge OpenAI computer-use safety checks (default: stop for a human)

Steer a running agent:  curl -s localhost:7788/steer -d '{"text":"skip onboarding, show me settings"}'
Stop it:                Ctrl-C, touch agent/STOP, curl -X POST localhost:7788/stop (macos: hold Esc)
`;

export function parseCli(argv, env = process.env) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, allowNegative: true,
    options: {
      app: { type: 'string' }, 'page-match': { type: 'string' }, brief: { type: 'string', default: '' }, backend: { type: 'string', default: 'cdp' },
      'max-steps': { type: 'string', default: '40' }, 'max-minutes': { type: 'string', default: '20' }, canvas: { type: 'string' },
      'dry-run': { type: 'boolean', default: false }, mock: { type: 'boolean', default: false }, model: { type: 'string' }, effort: { type: 'string' },
      tool: { type: 'string', default: 'computer' }, verify: { type: 'boolean', default: true }, 'verify-steps': { type: 'string', default: '8' }, 'max-verify': { type: 'string', default: '6' },
      record: { type: 'boolean', default: true }, headed: { type: 'boolean', default: false }, chrome: { type: 'string' }, ffmpeg: { type: 'string' }, viewport: { type: 'string', default: '1440x900' },
      'allow-host': { type: 'string', multiple: true, default: [] }, 'allow-risky': { type: 'boolean', default: false }, 'mac-app': { type: 'string' },
      port: { type: 'string' }, out: { type: 'string' }, 'clear-canvas': { type: 'boolean', default: false }, 'id-prefix': { type: 'string', default: '' },
      'ack-safety-checks': { type: 'boolean', default: false }, 'include-design': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false }
    }
  });
  const int = (v, name, min, max) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be an integer from ${min} to ${max}`);
    return n;
  };
  if (values.help) return { help: true };
  if (!['cdp', 'macos'].includes(values.backend)) throw new Error('--backend must be cdp or macos');
  if (!['computer', 'function'].includes(values.tool)) throw new Error('--tool must be computer or function');
  const target = positionals[0];
  if (!target && !values.app && !values.mock) throw new Error('Give a <url>, --app <cdp-port>, or --mock');
  if (values.app && values.backend === 'macos') throw new Error('--app is for the cdp backend; with --backend macos use --mac-app NAME');
  const m = /^(\d+)x(\d+)$/.exec(values.viewport);
  if (!m) throw new Error('--viewport must look like 1440x900');
  const portRaw = values.port ?? env.AGENT_PORT ?? '7788';
  return {
    target, cdpPort: values.app ? int(values.app, 'app', 1, 65535) : null, pageMatch: values['page-match'],
    brief: values.brief, backend: values.backend, maxSteps: int(values['max-steps'], 'max-steps', 1, 500), maxMinutes: int(values['max-minutes'], 'max-minutes', 1, 480),
    canvas: values.canvas || env.CANVAS_URL || 'http://localhost:3000', dryRun: values['dry-run'], mock: values.mock,
    model: values.model || env.ASTRA_MODEL || DEFAULT_MODEL, effort: values.effort || env.ASTRA_REASONING || 'low', tool: values.tool,
    verify: { enabled: values.verify, steps: int(values['verify-steps'], 'verify-steps', 1, 40), maxFindings: int(values['max-verify'], 'max-verify', 0, 50) },
    record: values.record, headed: values.headed, chrome: values.chrome || env.ASTRAHACK_CHROME, ffmpeg: values.ffmpeg || env.ASTRAHACK_FFMPEG,
    viewport: { width: Number(m[1]), height: Number(m[2]) }, allowHosts: values['allow-host'], allowRisky: values['allow-risky'], macApp: values['mac-app'],
    port: portRaw === 'off' ? 'off' : int(portRaw, 'port', 0, 65535), out: values.out, clearCanvas: values['clear-canvas'], idPrefix: values['id-prefix'],
    ackSafetyChecks: values['ack-safety-checks'], includeDesign: values['include-design']
  };
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const hostOf = u => { try { return new URL(u).hostname.replace(/[^a-z0-9.-]/gi, '_'); } catch { return 'app'; } };

export async function main(argv, env = process.env) {
  const log = msg => process.stderr.write(`[agent ${new Date().toTimeString().slice(0, 8)}] ${msg}\n`);
  let opts;
  try { opts = parseCli(argv, env); } catch (error) { console.error(error.message + '\n'); console.error(USAGE); return 2; }
  if (opts.help) { console.log(USAGE); return 0; }
  if (!opts.mock && !env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set (see .env.example). Use --mock to run the whole pipeline with a scripted fake model and no key.');
    return 2;
  }

  let demo = null;
  let target = opts.target;
  if (opts.mock && !target && !opts.cdpPort) { demo = await startDemoSite(); target = demo.url; log(`mock: built-in demo site at ${target}`); }
  const outDir = resolve(opts.out || join('runs', `teardown-${hostOf(target || `app-${opts.cdpPort}`)}-${stamp()}`));
  mkdirSync(outDir, { recursive: true });
  log(`run directory: ${outDir}`);

  const stop = new StopController({ files: [join(REPO_ROOT, 'agent', 'STOP'), join(outDir, 'STOP'), ...(env.AGENT_STOP_FILE ? [env.AGENT_STOP_FILE] : [])], log }).install();
  const inbox = new SteerInbox({ log });
  let backend;
  if (opts.backend === 'macos') {
    backend = new MacBackend({ url: target, app: opts.macApp, dryRun: opts.dryRun, stop, log });
    if (!opts.dryRun) stop.startEscWatcher();
  } else {
    backend = new CdpBackend({ url: target, cdpPort: opts.cdpPort, pageMatch: opts.pageMatch, chrome: opts.chrome, headless: !opts.headed, viewport: opts.viewport, allowHosts: opts.allowHosts, allowRisky: opts.allowRisky, dryRun: opts.dryRun, log });
  }

  const canvas = new CanvasStreamer({ url: opts.canvas, idPrefix: opts.idPrefix, log });
  if (['off', 'none'].includes(opts.canvas)) { canvas.enabled = false; log('canvas: streaming disabled (--canvas off)'); }
  else {
    await canvas.probe();
    if (opts.clearCanvas) await canvas.clear();
  }

  const recorder = opts.record && !opts.dryRun
    ? new Recorder({ backend, ffmpeg: findFfmpeg(opts.ffmpeg), path: join(outDir, 'recording.webm'), log })
    : null;
  if (!recorder && opts.record) log('recorder: skipped in --dry-run');

  const status = { state: 'starting', target, backend: opts.backend, outDir };
  const server = await startSteerServer({ inbox, port: opts.port === 'off' ? 'off' : Number(opts.port), getStatus: () => ({ ...status, stopped: stop.stopped, pendingSteers: inbox.pending }), onStop: r => stop.trigger(r), log });
  const stopFile = watchSteerFile(join(outDir, 'steer.txt'), inbox);
  const stopStdin = watchStdin(inbox);
  log(`steer file: ${join(outDir, 'steer.txt')}`);

  const sessionFactory = (kind, { instructions, functionTools }) => opts.mock
    ? createMockSession(kind, { backend, log })
    : createAstraSession({ model: opts.model, instructions, functionTools, mode: opts.tool, effort: opts.effort, log });

  let report;
  try {
    status.state = 'running';
    report = await runTeardown({
      target: target || `electron app on CDP port ${opts.cdpPort}`, brief: opts.brief, backend, canvas, stop, inbox, recorder, outDir, sessionFactory,
      maxSteps: opts.maxSteps, maxMinutes: opts.maxMinutes, verify: opts.verify, ackSafetyChecks: opts.ackSafetyChecks, includeDesign: opts.includeDesign, env, log,
      model: opts.mock ? 'mock' : opts.model, backendName: opts.backend
    });
  } catch (error) {
    log(`fatal: ${error.message}`);
    return 2;
  } finally {
    status.state = 'finished';
    await backend.close().catch(() => {});
    await server.close();
    stopFile(); stopStdin(); stop.dispose();
    await demo?.close();
  }
  printSummary(report, canvas);
  return report.status === 'error' ? 2 : 0;
}

function printSummary(report, canvas) {
  const out = s => process.stdout.write(s + '\n');
  out(`\n${report.status.toUpperCase()}${report.stopReason ? ' (' + report.stopReason + ')' : ''}: ${report.target}`);
  const c = report.counts;
  out(`${report.steps.length} steps, ${c.total} findings (${c.verified} verified, ${c.unverified} unverified)`);
  for (const f of report.findings) out(`  ${f.id} [${f.severity}] ${f.verified ? 'verified  ' : 'unverified'} ${f.title}`);
  out(`coverage: ${report.coverage.visited.length} visited, ${report.coverage.unreachable.length} unreachable`);
  out(`report: ${report.outDir}/report.md  (json: report.json, findings.json)`);
  if (canvas.enabled && !canvas.dryRun) out(`canvas: ${canvas.base}  (${canvas.posted.length} ops${canvas.errors.length ? `, ${canvas.errors.length} failed` : ''})`);
  if (report.error) out(`error: ${report.error}`);
}
