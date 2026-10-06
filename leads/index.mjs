// Lead generation: product understanding in, leads.json + leads.md out.
//   generateLeads({ input | brief, mock, dryRun, search, ... })
// Drafts and recipes only. Nothing posts, messages or emails anyone.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadInput } from './input.mjs';
import { mockPlan } from './mock.mjs';
import { assemble } from './recipes.mjs';
import { renderLeads } from './render.mjs';
import { DEFAULT_MODEL, planPrompt, planWithModel } from './gemini.mjs';
import { planWithOpenAI } from './openai.mjs';
import { discoverLeads } from './discover.mjs';
import { DRAFTING_SCHEMA, ICP_SCHEMA, MORE_SCHEMA, PLAN_SCHEMA, validatePlan } from './schema.js';

export { loadInput, mockPlan, assemble, renderLeads, planPrompt, discoverLeads, validatePlan, PLAN_SCHEMA };

export async function generateLeads({
  input, brief, name, url, outputDir, mock = false, dryRun = false, search = false, maxQueries = 6,
  provider = process.env.LEADS_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : process.env.OPENAI_API_KEY ? 'openai' : 'gemini'), apiKey, model,
  fetchImpl = fetch, resolveImpl, delayMs, now = new Date(), onProgress = () => {},
} = {}) {
  if (!['gemini', 'openai'].includes(provider)) throw new Error('Choose gemini or openai as the leads provider.');
  apiKey ??= provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY;
  model ||= provider === 'gemini' ? process.env.GEMINI_TEXT_MODEL || DEFAULT_MODEL : process.env.OPENAI_TEXT_MODEL || 'gpt-6-luna';
  const understanding = await loadInput({ input, brief, name, url });
  const haveKey = typeof apiKey === 'string' && apiKey.trim().length > 0;
  if (mock && dryRun) throw new Error('Choose --mock or --dry-run, not both.');
  if (!mock && !dryRun && !haveKey) throw new Error(`Set ${provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY'} to plan with the model, or use --mock (no key) or --dry-run (prompts only).`);
  if (search && provider !== 'gemini') throw new Error('--search requires the gemini provider and GEMINI_API_KEY for Google Search grounding. OpenAI planning creates proposed sources and outreach drafts only.');
  if (search && !dryRun && !haveKey) throw new Error('--search needs GEMINI_API_KEY: live discovery uses Gemini with Google Search grounding.');
  if (search && !Number.isInteger(maxQueries)) throw new Error('--max-queries must be an integer.');
  if (search && (maxQueries < 1 || maxQueries > 20)) throw new Error('--max-queries must be between 1 and 20.');

  const dir = outputDir ?? join('artifacts', `leads-${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });

  if (dryRun) {
    const prompts = { createdAt: now.toISOString(), mode: 'dry-run', provider, model, product: understanding.name, plan: { prompts: planPrompt(understanding), schemas: { research: ICP_SCHEMA, more: MORE_SCHEMA, drafting: DRAFTING_SCHEMA } }, search: search ? 'Search prompts are built from the plan\'s queries, so they exist only after the plan is generated. A real --search run sends up to --max-queries grounded requests plus one scoring request.' : null };
    await writeFile(join(dir, 'prompts.json'), `${JSON.stringify(prompts, null, 2)}\n`);
    return { dir, doc: null, files: ['prompts.json'], prompts };
  }

  if (mock) onProgress({ stage: 'mock-plan' });
  const plan = mock ? mockPlan(understanding) : await (provider === 'openai' ? planWithOpenAI : planWithModel)({ understanding, apiKey, model, fetchImpl, onProgress });
  if (mock) {
    const problems = validatePlan(plan, { featureIds: understanding.features.map((f) => f.id) });
    if (problems.length) throw new Error(`Mock plan is invalid (bug): ${problems.slice(0, 3).join('; ')}`);
  }
  const doc = assemble({ understanding, plan, mode: mock ? 'mock' : 'model', model: mock ? 'mock' : model, now });
  doc.provider = mock ? 'mock' : provider;

  if (search) {
    const { leads, discovery } = await discoverLeads({ doc, apiKey, model, fetchImpl, resolveImpl, maxQueries, delayMs, onProgress });
    doc.shortlist.leads = leads;
    doc.discovery = discovery;
  } else doc.notes.unshift('No live search was run. Customer profiles, lead sources and outreach drafts are proposed; the verified lead shortlist is empty.');

  await writeFile(join(dir, 'leads.json'), `${JSON.stringify(doc, null, 2)}\n`);
  await writeFile(join(dir, 'leads.md'), renderLeads(doc));
  return { dir, doc, files: ['leads.json', 'leads.md'] };
}
