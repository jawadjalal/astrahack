// UGC planner. Input: a computer-use run's report.json (src/runner.js). Output: a ugc-plan.json
// document matching PLAN_SCHEMA in ./schema.js.
//
//   1. extractObserved(report)  features, journeys, evidence, site claims, friction (deterministic)
//   2. text model (or --mock)   angles, hooks, creators, scripts, campaign, as structured JSON
//   3. assemble + repairPlan    evidence comes from step 1 only; unknown ids and assets are fixed or dropped
//   4. validatePlan             PLAN_SCHEMA shape, checkGrounding, unique ids, 3 to 5 scripts, known assets
import { wrapPlan } from './schema.js';
import { extractObserved } from './extract.mjs';
import { buildPrompts, modelSchema } from './prompt.mjs';
import { mockPlan } from './mock.mjs';
import { assemble, repairPlan } from './repair.mjs';
import { validatePlan, validateSchema } from './validate.mjs';
import { callModel, defaultModel, keyFor, resolveProvider } from './providers.mjs';

export { extractObserved } from './extract.mjs';
export { buildPrompts, modelSchema } from './prompt.mjs';
export { validatePlan } from './validate.mjs';

/** Prompts and schema only. No network, no key. */
export function dryRunPrompts({ report, brief = '' }) {
  return buildPrompts(extractObserved(report), brief);
}

/**
 * @param {object} opts
 * @param {object} opts.report     parsed report.json from the runner
 * @param {string} [opts.brief]    free-text brief from the team (audience, goal, platforms, tone)
 * @param {'gemini'|'openai'} [opts.provider]  default: UGC_PROVIDER, else whichever API key is set
 * @param {string} [opts.model]    default: GEMINI_TEXT_MODEL / OPENAI_TEXT_MODEL
 * @param {string} [opts.apiKey]   default: GEMINI_API_KEY / OPENAI_API_KEY
 * @param {boolean} [opts.mock]    deterministic plan, no network
 * @param {string} [opts.reportPath]  recorded in source.report
 * @param {string} [opts.runDir]      recorded in source.runDir (evidence paths are relative to it)
 * @param {number} [opts.maxAttempts] model attempts when output fails validation (default 2)
 * @param {Function} [opts.fetchImpl] injected fetch (Gemini)
 * @param {Function} [opts.request]   injected Responses helper (OpenAI)
 * @returns {Promise<object>} the ugc-plan document (wrapPlan output plus a `grounding` block)
 */
export async function planUgc({
  report, brief = '', provider, model, apiKey, mock = false, reportPath = null, runDir = null,
  maxAttempts = 2, fetchImpl = fetch, request,
} = {}) {
  const observed = extractObserved(report);
  const assets = new Set(observed.assets.map((a) => a.path));
  const schema = modelSchema();
  let modelId = 'mock', providerName = 'mock';
  let build;

  if (mock) {
    build = async () => mockPlan(observed, brief);
    maxAttempts = 1;
  } else {
    providerName = resolveProvider(provider);
    modelId = model || defaultModel(providerName);
    const key = apiKey ?? keyFor(providerName);
    const prompts = buildPrompts(observed, brief);
    let feedback = '';
    build = async (attempt, previous) => {
      if (previous) feedback = `\n\nYour previous answer failed validation. Fix every item and return the full JSON again:\n${previous.slice(0, 20).map((p) => `- ${p}`).join('\n')}`;
      return callModel({ provider: providerName, model: modelId, apiKey: key, system: prompts.system, user: prompts.user + feedback, schema, fetchImpl, request });
    };
  }

  let problems = [], result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = await build(attempt, problems.length ? problems : null);
    problems = validateSchema(raw, schema);
    if (problems.length) continue;
    result = repairPlan(assemble(raw, observed), observed);
    problems = validatePlan(result.plan, { assets });
    if (!problems.length) break;
  }
  if (problems.length) {
    throw new Error(`The ${providerName} plan failed validation after ${maxAttempts} attempt(s):\n${problems.slice(0, 12).map((p) => `  - ${p}`).join('\n')}`);
  }

  const doc = wrapPlan(result.plan, {
    model: modelId,
    source: { report: reportPath, runDir, target: report.target?.url || observed.product.url || null, runName: report.name || null },
  });
  doc.grounding = {
    provider: providerName,
    observedFeatureCount: observed.features.length,
    evidenceRoot: runDir,
    repairs: result.repairs,
    flaggedFigures: result.flaggedFigures,
    note: 'Features, evidence paths and friction come from the run. Everything in proposals, and all creative copy, is not observed.',
  };
  return doc;
}
