#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { generateLeads } from '../leads/index.mjs';

const HELP = `Lead generation from a product understanding. Writes leads.json and leads.md. Drafts and recipes only: nothing posts, messages or emails anyone.

  npm run leads -- --input ugc/fixtures/ignura/report.json --mock
  npm run leads -- --input <run dir | report.json | ugc-plan.json | brief.md> [--search]
  npm run leads -- --brief "One paragraph about the product, who it is for, what it does." --mock

Input (exactly one): --input <path>   --brief <text>
Mode:  default = plan with Gemini (GEMINI_API_KEY)   --mock = deterministic, no key, no network   --dry-run = write prompts only
Live discovery: --search   Gemini + Google Search grounding finds real public threads (needs a key and search quota)
               --max-queries N   searches to run (default 6, max 20)
Other: --name <product>  --url <product url>  --model <text model>  --out <directory> (default artifacts/leads-<time>)

Exit codes: 0 ok, 1 error, 2 file written but live discovery had errors (quota, no results).`;

try {
  const { values } = parseArgs({ options: {
    input: { type: 'string' }, brief: { type: 'string' }, name: { type: 'string' }, url: { type: 'string' },
    model: { type: 'string' }, out: { type: 'string' }, 'max-queries': { type: 'string', default: '6' },
    mock: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, search: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { console.log(HELP); }
  else {
    const { dir, doc, files } = await generateLeads({
      input: values.input, brief: values.brief, name: values.name, url: values.url, model: values.model,
      outputDir: values.out ? resolve(values.out) : undefined, mock: values.mock, dryRun: values['dry-run'], search: values.search,
      maxQueries: Number(values['max-queries']),
      onProgress: (p) => console.error(`  ${p.stage}${p.q ? `: ${p.q}` : ''}`),
    });
    if (!doc) { console.log(`dry-run: prompts written to ${dir}/${files[0]}`); }
    else {
      const d = doc.discovery;
      console.log(`${doc.mode}: ${doc.sources.length} sources, ${doc.outreach.length} outreach drafts, ${doc.shortlist.leads.length} live leads`);
      console.log(`  ${dir}/leads.json\n  ${dir}/leads.md`);
      if (d.enabled) {
        console.log(`  discovery: ${d.queriesRun}/${d.queries.length} searches succeeded, ${d.results} results`);
        for (const e of d.errors) console.error(`  discovery problem: ${e}`);
        if (d.errors.length || !d.results) process.exitCode = 2;
      }
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
