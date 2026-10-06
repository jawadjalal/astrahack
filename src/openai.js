export async function createResponse(payload, { apiKey = process.env.OPENAI_API_KEY, endpoint = 'https://api.openai.com/v1/responses', fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for GPT-6 Astra QA runs');
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`OpenAI API ${response.status}: ${body.error?.message || response.statusText}`);
  if (body.status !== 'completed') throw new Error(`OpenAI response status: ${body.status || 'unknown'}`);
  return body;
}

export function outputText(response) {
  return response.output?.filter(item => item.type === 'message')
    .flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text')
    .map(item => item.text).join('\n') || '';
}
