#!/usr/bin/env node
// node bin/video.js animatic <runDir> [--script S1|all] [--canvas URL] [--dry-run] [--no-voice]
// Renders each UGC script in <runDir>/ugc-plan.json as a vertical storyboard animatic (see docs/VIDEO.md).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { renderScript, pushToCanvas, openaiKey, FFMPEG, CHROME } from '../video/animatic.mjs';
import { execFileSync } from 'node:child_process';

const USAGE = 'usage: node bin/video.js animatic <runDir> [--script S1|all] [--canvas URL] [--dry-run] [--no-voice]';

export function parseArgs(argv) {
  const [cmd, runDir, ...rest] = argv;
  const o = { cmd, runDir, script: 'all', canvas: null, dryRun: false, voice: true };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--script') o.script = rest[++i];
    else if (a.startsWith('--script=')) o.script = a.slice(9);
    else if (a === '--canvas') o.canvas = rest[++i];
    else if (a.startsWith('--canvas=')) o.canvas = a.slice(9);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--no-voice') o.voice = false;
    else throw new Error(`unknown option ${a}\n${USAGE}`);
  }
  if (cmd !== 'animatic' || !runDir) throw new Error(USAGE);
  return o;
}

function have(bin) { try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } }

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const runDir = resolve(o.runDir);
  const planFile = join(runDir, 'ugc-plan.json');
  if (!existsSync(planFile)) { console.error(`no ugc-plan.json in ${runDir}`); process.exit(1); }
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const scripts = o.script === 'all' ? plan.scripts : plan.scripts.filter((s) => s.id.toLowerCase() === String(o.script).toLowerCase());
  if (!scripts?.length) { console.error(`no script ${o.script} in plan (have ${plan.scripts.map((s) => s.id).join(', ')})`); process.exit(1); }
  if (!o.dryRun) {
    if (!have(FFMPEG)) { console.error(`ffmpeg not found (${FFMPEG}); brew install ffmpeg`); process.exit(1); }
    if (!existsSync(CHROME)) { console.error(`Chrome not found at ${CHROME}; set CHROME_PATH`); process.exit(1); }
  }
  const voice = o.voice && !!openaiKey();
  console.log(`animatic: ${scripts.length} script(s) from ${relative(process.cwd(), planFile)}${o.dryRun ? ' (dry run)' : ''}, voiceover ${voice ? 'on (OpenAI TTS)' : 'off'}`);
  const results = [];
  for (const s of scripts) {
    const r = await renderScript(plan, s, runDir, { dryRun: o.dryRun, voice: o.voice, log: (m) => console.log(m) });
    results.push({ scriptId: s.id, ...r });
    if (o.dryRun) {
      console.log(`  ${s.id}: ${r.segments.length} segments, ${r.durationSec}s -> ${relative(process.cwd(), r.mp4)}`);
      for (const seg of r.segments) console.log(`    ${seg.kind.padEnd(5)} ${String(seg.dur).padStart(4)}s  ${seg.caption || seg.hook || seg.cta || ''}${seg.assetRef ? `  [${seg.assetRef}]` : ''}`);
      for (const c of r.commands) console.log(`    $ ${c.map((x) => (/[\s'();,]/.test(x) ? JSON.stringify(x) : x)).join(' ')}`);
    } else {
      console.log(`  ${s.id}: ${r.durationSec}s, ${(r.bytes / 1e6).toFixed(2)} MB${r.voice ? ', with voiceover' : ''} -> ${relative(process.cwd(), r.mp4)}`);
    }
  }
  if (o.canvas) {
    if (o.dryRun) console.log(`  (dry run) would upload ${results.length} MP4(s) to ${o.canvas}/api/upload and add add_video ops next to the UGC script cards`);
    else await pushToCanvas(o.canvas, results, (m) => console.log(m));
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('bin/video.js')) {
  main().catch((e) => { console.error(`animatic failed: ${e.stderr?.toString?.().slice(0, 600) || e.message}`); process.exit(1); });
}
