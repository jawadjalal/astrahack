export async function createResponse(payload, { apiKey = process.env.OPENAI_API_KEY, endpoint = 'https://api.openai.com/v1/responses', fetchImpl = fetch, signal } = {}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for model API calls');
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`OpenAI API ${response.status}: ${String(body.error?.message || response.statusText).replaceAll(apiKey, '[redacted]')}`);
  if (body.status !== 'completed') {
    const error = new Error(`OpenAI response status: ${body.status || 'unknown'}${body.incomplete_details?.reason ? ` (${body.incomplete_details.reason})` : ''}`);
    error.response = body;
    throw error;
  }
  return body;
}

export function outputText(response) {
  return response.output?.filter(item => item.type === 'message')
    .flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text')
    .map(item => item.text).join('\n') || '';
}
