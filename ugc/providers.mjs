// Text-model calls for the planner. Same provider pattern as the rest of the repo:
// Gemini via GEMINI_API_KEY + GEMINI_TEXT_MODEL (as lib/campaigns.mjs), OpenAI via
// OPENAI_API_KEY and the shared Responses helper in src/openai.js (as src/qa-analysis.js).
// No dependencies. Provider error bodies are never surfaced, since they can echo request content.
import { createResponse, outputText } from '../src/openai.js';

export const PROVIDERS = ['gemini', 'openai'];
const MAX_OUTPUT_TOKENS = 16384;

export function defaultModel(provider, env = process.env) {
  return provider === 'gemini' ? env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash' : env.OPENAI_TEXT_MODEL || 'gpt-6-astra';
}

/** Explicit choice wins, then UGC_PROVIDER / IMAGE_PROVIDER, then whichever key is set, then gemini. */
export function resolveProvider(requested, env = process.env) {
  const chosen = requested || env.UGC_PROVIDER;
  if (chosen) {
    if (!PROVIDERS.includes(chosen)) throw new Error(`Choose gemini or openai as the provider (got "${chosen}").`);
    return chosen;
  }
  if (env.GEMINI_API_KEY) return 'gemini';
  if (env.OPENAI_API_KEY) return 'openai';
  return PROVIDERS.includes(env.IMAGE_PROVIDER) ? env.IMAGE_PROVIDER : 'gemini';
}

export function keyFor(provider, env = process.env) {
  return provider === 'gemini' ? env.GEMINI_API_KEY : env.OPENAI_API_KEY;
}

async function callGemini({ model, apiKey, system, user, schema, fetchImpl }) {
  const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: MAX_OUTPUT_TOKENS },
    }),
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) {
    const errors = { 400: 'request rejected (check the model name and schema support)', 401: 'API key rejected', 403: 'model access denied', 429: 'quota or rate limit reached' };
    throw new Error(`Gemini ${errors[response.status] || `request failed (HTTP ${response.status})`}.`);
  }
  const data = await response.json();
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason !== 'STOP') throw new Error('Gemini did not finish the plan; output may be blocked or truncated.');
  const raw = candidate.content?.parts?.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  return raw;
}

async function callOpenAI({ model, apiKey, system, user, schema, fetchImpl, request }) {
  const payload = {
    model, store: false, max_output_tokens: MAX_OUTPUT_TOKENS,
    text: { format: { type: 'json_schema', name: 'ugc_plan', strict: true, schema } },
    input: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  const response = await (request || createResponse)(payload, { apiKey, fetchImpl });
  return outputText(response);
}

/**
 * One structured-output request. Returns the parsed JSON value.
 * `request` (OpenAI) and `fetchImpl` are injectable so tests never touch the network.
 */
export async function callModel({ provider, model, apiKey, system, user, schema, fetchImpl = fetch, request }) {
  if (!PROVIDERS.includes(provider)) throw new Error(`Unknown provider "${provider}".`);
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error(`Set ${provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY'} to call ${provider}, or use --mock / --dry-run.`);
  }
  const raw = await (provider === 'gemini' ? callGemini : callOpenAI)({ model, apiKey, system, user, schema, fetchImpl, request });
  try { return JSON.parse(raw); } catch { throw new Error(`${provider} returned text that is not valid JSON.`); }
}
