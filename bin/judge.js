#!/usr/bin/env node
// Self-improving judge for a UGC plan: score every hook and script, rewrite what is under the bar, re-score, repeat.
//   node bin/judge.js <runDir|ugc-plan.json> [--rounds 2] [--threshold 8] [--mock] [--out dir] [--canvas URL] [--dry-run]
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadEnv, parseFlags, fetchT, trimUrl } from '../scripts/lib/common.mjs';
import { judgePlan, formatTable } from '../judge/loop.mjs';
import { judgeOps } from '../judge/canvas.mjs';

const USAGE = 'usage: node bin/judge.js <runDir|ugc-plan.json> [--rounds 2] [--threshold 8] [--mock] [--out dir] [--canvas URL] [--dry-run]';

export function resolvePlanPath(arg) {
  const p = resolve(arg);
  if (existsSync(p) && statSync(p).isFile()) return p;
  for (const c of ['ugc-plan.json', 'ugc/ugc-plan.json', 'kit/ugc/ugc-plan.json']) if (existsSync(join(p, c))) return join(p, c);
  throw new Error(`no ugc-plan.json in ${arg}`);
}

async function main(argv) {
  const flags = parseFlags(argv, {
    rounds: { type: 'number', default: 2 }, threshold: { type: 'number', default: 8 }, mock: { type: 'boolean' },
    out: { type: 'string' }, canvas: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  });
  if (flags.help || !flags._[0]) { console.log(USAGE); return flags.help ? 0 : 2; }
  loadEnv();
  const planPath = resolvePlanPath(flags._[0]);
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const apiKey = flags.mock ? undefined : process.env.OPENAI_API_KEY;
  if (!flags.mock && !apiKey) console.log('no OPENAI_API_KEY: using the deterministic heuristic judge (same as --mock)');
  const { plan: judged, report } = await judgePlan(plan, { rounds: flags.rounds, threshold: flags.threshold, mock: !apiKey, apiKey, log: (m) => console.log(`  ${m}`) });
  const outDir = resolve(flags.out || dirname(planPath));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'judge.json'), JSON.stringify({ ...report, source: planPath, generatedAt: new Date().toISOString() }, null, 2) + '\n');
  writeFileSync(join(outDir, 'ugc-plan.judged.json'), JSON.stringify(judged, null, 2) + '\n');
  console.log(formatTable(report));
  console.log(`wrote ${join(outDir, 'judge.json')}\nwrote ${join(outDir, 'ugc-plan.judged.json')}`);

  if (flags.canvas || flags['dry-run']) {
    const base = trimUrl(flags.canvas || 'http://localhost:3000');
    let envs = [];
    try { const res = await fetchT(`${base}/api/state`, {}, 5000); if (res.ok) envs = (await res.json()).ops || []; }
    catch { if (!flags['dry-run']) throw new Error(`canvas not reachable at ${base}`); }
    const { ops, lane, say } = judgeOps(report, plan, envs);
    console.log(`canvas: ${ops.length} ops, ${lane ? `next to UGC lane "${lane}"` : 'no UGC lane found, placed right of the board'}`);
    if (flags['dry-run']) { console.log(JSON.stringify(ops, null, 2)); return 0; }
    const res = await fetchT(`${base}/api/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ops) }, 15000);
    if (!res.ok) throw new Error(`POST /api/ops failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    console.log(`pushed. ${say}`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('bin/judge.js')) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`judge: ${e.message}`); process.exit(1); });
}
