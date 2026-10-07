import test from 'node:test';
import assert from 'node:assert/strict';
import { streamResponse } from '../lib/responses-stream.mjs';
const chunks = strings => new Response(new ReadableStream({ start(controller) { for (const value of strings) controller.enqueue(new TextEncoder().encode(value)); controller.close(); } }));
test('stream parser handles split SSE boundaries and keeps final usage', async () => {
  const body = { status: 'completed', usage: { total_tokens: 12 }, output: [] };
  let payload;
  const response = await streamResponse({ model: 'gpt-6-luna' }, { apiKey: 'fixture-key', fetchImpl: async (url, init) => {
    payload = JSON.parse(init.body);
    return chunks(['event: response.created\r\ndata: {"type":"response.created"}\r', '\n\r\n', `data: ${JSON.stringify({ type: 'response.completed', response: body })}\n`, '\n']);
  } });
  assert.equal(payload.stream, true);
  assert.deepEqual(response, body);
});
test('truncated streams fail rather than accepting partial output', async () => {
  await assert.rejects(streamResponse({}, { apiKey: 'fixture-key', fetchImpl: async () => chunks(['data: {"type":"response.output_text.delta","delta":"partial"}\n\n']) }), /ended before/);
});
test('stream failures redact credentials and preserve transport code', async () => {
  await assert.rejects(streamResponse({}, { apiKey: 'fixture-key', fetchImpl: async () => { throw new Error('fixture-key failed', { cause: { code: 'ECONNRESET' } }); } }), error => !error.message.includes('fixture-key') && error.causeCode === 'ECONNRESET');
});


test('HTTP failures retain status without exposing the response body', async () => {
  await assert.rejects(streamResponse({}, { apiKey: 'fixture-key', fetchImpl: async () => Response.json({ error: 'fixture-key private body' }, { status: 429 }) }),
    error => error.status === 429 && !error.message.includes('fixture-key') && !error.message.includes('private body'));
});
