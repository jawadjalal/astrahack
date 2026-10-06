// gpt-6-astra judge + rewriter over structured outputs (src/openai.js createResponse). Same rubric as heuristic.mjs.
import { createResponse, outputText } from '../src/openai.js';
import { CRITERIA, RUBRIC, HOOK_MAX_WORDS } from './heuristic.mjs';

export const MODEL = process.env.OPENAI_JUDGE_MODEL || 'gpt-6-astra';
const num = { type: 'number' };
const str = { type: 'string' };
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

export const SCORE_SCHEMA = obj({
  items: { type: 'array', items: obj({ id: str, scores: obj(Object.fromEntries(CRITERIA.map((k) => [k, num]))), rationale: str }) },
});
export const REWRITE_SCHEMA = obj({
  hooks: { type: 'array', items: obj({ id: str, text: str, visualOpener: str }) },
  scripts: { type: 'array', items: obj({ id: str, beats: { type: 'array', items: obj({ voiceover: str, onScreenText: str }) } }) },
});

const RULES = `Rubric, each 0-10:\n${CRITERIA.map((k) => `- ${k}: ${RUBRIC[k]}`).join('\n')}
Hooks: at most ${HOOK_MAX_WORDS} words and must open with tension or curiosity.
Only the observed features below are facts. Never invent stats, prices, results or testimonials. Figures the site shows must be attributed to the site.`;

function facts(plan) {
  return plan.product.observedFeatures.map((f) => `${f.id} ${f.name}: ${f.whatItDoes}`).join('\n');
}

async function call(name, schema, system, user, opts) {
  const payload = { model: MODEL, input: [{ role: 'system', content: system }, { role: 'user', content: user }],
    text: { format: { type: 'json_schema', name, strict: true, schema } } };
  const res = await (opts.request || createResponse)(payload, { apiKey: opts.apiKey, fetchImpl: opts.fetchImpl });
  return JSON.parse(outputText(res));
}

/** items: [{id, kind:'hook'|'script', text}] -> Map id -> {scores, rationale} */
export async function modelScore(plan, items, opts = {}) {
  const out = await call('ugc_judge_scores', SCORE_SCHEMA, `You are a strict UGC creative director judging short-form video copy for ${plan.product.name}.\n${RULES}`,
    `Observed features:\n${facts(plan)}\n\nScore each item:\n${items.map((i) => `[${i.id}] (${i.kind}) ${i.text}`).join('\n')}`, opts);
  return new Map(out.items.map((i) => [i.id, i]));
}

/** low: [{id, kind, text, rationale, beats?}] -> { hooks, scripts } rewrites (caller re-validates and re-scores) */
export async function modelRewrite(plan, low, opts = {}) {
  return call('ugc_judge_rewrites', REWRITE_SCHEMA, `You rewrite UGC hooks and scripts for ${plan.product.name} so they score higher.\n${RULES}
Keep ids. For scripts return exactly as many beats as given, in order; beat 1 voiceover must equal the hook.`,
    `Observed features:\n${facts(plan)}\n\nRewrite these (judge notes in brackets):\n${low.map((i) => `[${i.id}] (${i.kind}) ${i.text}\n  [${i.rationale}]`).join('\n')}`, opts);
}
