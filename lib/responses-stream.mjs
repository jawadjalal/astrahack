/** Read Responses SSE through its terminal event; callers still validate response.status and output. */
export async function streamResponse(payload, { apiKey = process.env.OPENAI_API_KEY, fetchImpl = fetch, signal, timeoutMs = 600000, onEvent = () => {} } = {}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ ...payload, stream: true }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`OpenAI streaming request failed (HTTP ${response.status})`);
    if (!response.body) throw new Error('OpenAI returned no response stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        let end;
        while ((end = pending.search(/\r?\n\r?\n/)) >= 0) {
          const delimiter = pending.slice(end).match(/^\r?\n\r?\n/)[0];
          const block = pending.slice(0, end); pending = pending.slice(end + delimiter.length);
          const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data || data === '[DONE]') continue;
          const event = JSON.parse(data);
          onEvent(event);
          if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
            if (!event.response) throw new Error('OpenAI terminal event has no response');
            return event.response;
          }
          if (event.type === 'error') throw new Error('OpenAI returned a streaming error');
        }
        if (done) throw new Error('OpenAI stream ended before a terminal response');
        if (pending.length > 16000000) throw new Error('OpenAI stream event exceeded the size limit');
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch (error) {
    const clean = new Error(String(error.message).replaceAll(apiKey, '[redacted]'));
    clean.name = error.name;
    clean.causeCode = error.cause?.code;
    throw clean;
  }
}
