import { createResponse, outputText } from '../src/openai.js';
import { researchPrompt, morePrompt, draftingPrompt, ProviderError } from './gemini.mjs';
import { ICP_SCHEMA, ICP_KEYS, MORE_SCHEMA, MORE_KEYS, DRAFTING_SCHEMA, DRAFTING_KEYS, validatePlan } from './schema.js';

/** Three inexpensive structured planning requests; no search or invented live leads. */
export async function planWithOpenAI({ understanding, apiKey, model = 'gpt-6-luna', fetchImpl, onProgress = () => {} }) {
  const featureIds = understanding.features.map(feature => feature.id);
  async function structured(stage, prompt, schema, keys) {
    let input = prompt;
    let problems = [];
    for (let pass = 0; pass < 2; pass++) {
      onProgress({ stage: pass ? `${stage}-repair` : stage });
      let response;
      try {
        response = await createResponse({
          model, store: false, reasoning: { effort: 'low' }, max_output_tokens: 16384, input,
          text: { format: { type: 'json_schema', name: stage.replaceAll('-', '_'), strict: true, schema } },
        }, { apiKey, fetchImpl });
      } catch (error) {
        // Do not expose provider messages that may echo source content or credentials.
        if (error.response?.status && error.response.status !== 'completed') throw new ProviderError(`OpenAI did not finish the ${stage} response; output may be blocked or truncated.`);
        const status = error.message?.match(/OpenAI API (\d{3})/)?.[1];
        throw new ProviderError(status ? `OpenAI request failed (HTTP ${status}).` : `OpenAI ${stage} request failed before a complete response arrived.`);
      }
      let value;
      try { value = JSON.parse(outputText(response)); } catch { problems = ['output was not valid JSON']; }
      if (value) {
        problems = validatePlan(value, { featureIds, keys });
        if (!problems.length) return value;
      }
      input = `${prompt}\n\nYour previous answer had these problems. Return the full corrected JSON.\n- ${problems.slice(0, 12).join('\n- ')}`;
    }
    throw new ProviderError(`OpenAI returned an invalid ${stage} response after one repair pass: ${problems.slice(0, 3).join('; ')}`);
  }
  const first = await structured('plan-icp', researchPrompt(understanding), ICP_SCHEMA, ICP_KEYS);
  const more = await structured('plan-sources', morePrompt(understanding, first), MORE_SCHEMA, MORE_KEYS);
  const drafting = await structured('plan-drafting', draftingPrompt(understanding, first), DRAFTING_SCHEMA, DRAFTING_KEYS);
  return { ...first, ...more, ...drafting };
}
