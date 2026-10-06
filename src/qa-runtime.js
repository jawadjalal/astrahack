export const DEFAULT_QA_MODEL = 'gpt-6-luna';

export function qaModel(explicit) {
  const model = explicit ?? process.env.OPENAI_QA_MODEL ?? DEFAULT_QA_MODEL;
  if (typeof model !== 'string' || !model.trim()) throw new Error('QA model must be a nonempty string');
  return model.trim();
}

export function integerLimit(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}–${max}`);
}

export class RunLimitError extends Error {
  constructor(message) { super(message); this.name = 'RunLimitError'; }
}

/** Reserve requests synchronously before awaiting so concurrent workers share one hard call cap. */
export function createRunBudget(request, { maxRequests, maxDurationMs = 900000, maxOutputTokens = 8192, signal } = {}) {
  if (maxRequests !== undefined) integerLimit('maxRequests', maxRequests, 1, 10000);
  integerLimit('maxDurationMs', maxDurationMs, 1000, 7200000);
  integerLimit('maxOutputTokens', maxOutputTokens, 256, 32768);
  const deadline = AbortSignal.timeout(maxDurationMs);
  const combinedSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const usage = { requests: 0, completedRequests: 0, failedRequests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, byModel: Object.create(null) };
  const check = () => {
    if (combinedSignal.aborted) throw new RunLimitError('Run cancelled or time limit reached');
    if (maxRequests !== undefined && usage.requests >= maxRequests) throw new RunLimitError(`Shared API request limit (${maxRequests}) reached`);
  };
  const recordUsage = (response, payload) => {
      const model = response.model || payload.model;
      const totals = usage.byModel[model] ||= { requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 };
      totals.requests++;
      const values = {
        inputTokens: response.usage?.input_tokens || 0,
        cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
        totalTokens: response.usage?.total_tokens || 0
      };
      for (const [name, value] of Object.entries(values)) { usage[name] += value; totals[name] += value; }
  };
  const wrapped = async (payload, attempt = 0) => {
    check();
    usage.requests++;
    try {
      const response = await request({ ...payload, max_output_tokens: maxOutputTokens }, { signal: combinedSignal });
      usage.completedRequests++;
      recordUsage(response, payload);
      return response;
    } catch (error) {
      usage.failedRequests++;
      if (error.response) recordUsage(error.response, payload);
      if (combinedSignal.aborted) throw new RunLimitError('Run cancelled or time limit reached');
      if (attempt < 2 && (error.status >= 500 && error.status <= 599 || error.status === 429 && error.code === 'rate_limit_exceeded')) {
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        return wrapped(payload, attempt + 1);
      }
      throw error;
    }
  };
  return { request: wrapped, usage, signal: combinedSignal, check,
    limits: { maxRequests: maxRequests ?? null, maxDurationMs, maxOutputTokens } };
}
