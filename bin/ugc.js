#!/usr/bin/env node
// UGC planner CLI: a computer-use run (report.json) in, ugc-plan.json + ugc-plan.md out.
import { existsSync, statSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { planUgc, dryRunPrompts, validatePlan } from '../ugc/plan.mjs';
import { renderPlan } from '../ugc/render.mjs';

try { process.loadEnvFile('.env'); } catch { /* no .env, or already set in the environment */ }

const USAGE = `Plan a UGC campaign from a computer-use run.

  node bin/ugc.js <runDir|report.json> [options]
  npm run ugc -- ugc/fixtures/ignura --mock

Options:
  --brief TEXT          what the team wants: audience, goal, platforms, tone
  --brief-file PATH     read the brief from a file
  --provider NAME       gemini | openai (default: UGC_PROVIDER, else whichever API key is set)
  --model ID            override GEMINI_TEXT_MODEL / OPENAI_TEXT_MODEL (OpenAI default: gpt-6-luna)
  --out DIR             where to write ugc-plan.json and ugc-plan.md (default: the run directory)
  --mock                deterministic plan from the report, no API key
  --dry-run             print the prompts and schema, write nothing

Env: GEMINI_API_KEY, GEMINI_TEXT_MODEL, OPENAI_API_KEY, OPENAI_TEXT_MODEL, UGC_PROVIDER.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      brief: { type: 'string' }, 'brief-file': { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
      out: { type: 'string' }, mock: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) { console.log(USAGE); process.exit(0); }
  if (positionals.length !== 1) throw new Error(`Give exactly one run directory or report.json.\n\n${USAGE}`);
  if (values.brief && values['brief-file']) throw new Error('Use --brief or --brief-file, not both.');

  const input = resolve(positionals[0]);
  if (!existsSync(input)) throw new Error(`Not found: ${positionals[0]}`);
  const reportPath = statSync(input).isDirectory() ? join(input, 'report.json') : input;
  if (!existsSync(reportPath)) throw new Error(`No report.json in ${positionals[0]}. Run node bin/astrahack.js first.`);
  const runDir = dirname(reportPath);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const brief = values['brief-file'] ? await readFile(resolve(values['brief-file']), 'utf8') : values.brief || '';
  const rel = (p) => relative(process.cwd(), p) || '.';

  if (values['dry-run']) {
    const { system, user, schema } = dryRunPrompts({ report, brief });
    console.log(`--- SYSTEM ---\n${system}\n\n--- USER ---\n${user}\n\n--- SCHEMA (${JSON.stringify(schema).length} bytes, PLAN_SCHEMA without observedFeatures/frictionFromQa) ---\n${JSON.stringify(schema, null, 1).slice(0, 600)}\n...`);
    console.error('\nDry run: no model call, nothing written.');
    process.exit(0);
  }

  const missing = (report.assets || []).filter((a) => !existsSync(join(runDir, a.path))).map((a) => a.path);
  if (missing.length) console.error(`Warning: ${missing.length} asset(s) listed in the report are missing on disk (first: ${missing[0]}). The plan still cites them by path.`);

  const doc = await planUgc({
    report, brief, provider: values.provider, model: values.model, mock: values.mock,
    reportPath: rel(reportPath), runDir: rel(runDir),
  });

  const outDir = resolve(values.out || runDir);
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, 'ugc-plan.json'), mdPath = join(outDir, 'ugc-plan.md');
  await writeFile(jsonPath, `${JSON.stringify(doc, null, 2)}\n`);
  await writeFile(mdPath, renderPlan(doc));

  // Validate what is actually on disk, not what was in memory.
  const onDisk = JSON.parse(await readFile(jsonPath, 'utf8'));
  const problems = validatePlan(onDisk, { assets: new Set(onDisk.product.observedFeatures.flatMap((f) => f.evidence).concat(report.assets.map((a) => a.path))) });
  if (problems.length) throw new Error(`Wrote ${rel(jsonPath)} but it failed validation:\n${problems.map((p) => `  - ${p}`).join('\n')}`);

  console.log(`${doc.model === 'mock' ? 'Mock plan' : `Plan from ${doc.model}`} for ${doc.product.name}`);
  console.log(`  ${rel(jsonPath)}\n  ${rel(mdPath)}`);
  console.log(`  valid: PLAN_SCHEMA + grounding checks passed (${doc.product.observedFeatures.length} observed features, ${doc.angles.length} angles, ${doc.hooks.length} hooks, ${doc.scripts.length} scripts, ${doc.campaign.calendar.length} calendar days)`);
  console.log(`  proposals to verify: ${doc.proposals.length}; grounding repairs: ${doc.grounding.repairs.length}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
