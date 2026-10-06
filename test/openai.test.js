import test from 'node:test';
import assert from 'node:assert/strict';
import { createResponse } from '../src/openai.js';

const apiKey = 'fixture-api-key-never-log';

test('Responses client serializes the payload and passes an abortable signal to fetch', async () => {
  const controller = new AbortController();
  const payload = { model: 'fixture-model', max_output_tokens: 256, input: 'fixture prompt' };
  const result = { status: 'completed', id: 'fixture-response', output: [] };
  let request;
  assert.deepEqual(await createResponse(payload, { apiKey, signal: controller.signal, fetchImpl: async (url, options) => {
    request = { url, options };
    return Response.json(result);
  } }), result);
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, `Bearer ${apiKey}`);
  assert.deepEqual(JSON.parse(request.options.body), payload);
  assert.equal(request.options.signal.aborted, false);
  controller.abort();
  assert.equal(request.options.signal.aborted, true);
});

test('cancellation reaches an active fetch and preserves the abort reason', async () => {
  const controller = new AbortController();
  const reason = new Error('Fixture cancelled');
  const result = createResponse({ model: 'fixture-model' }, { apiKey, signal: controller.signal,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
  controller.abort(reason);
  await assert.rejects(result, error => error === reason || error.message === reason.message);
});

test('incomplete responses throw with their body and usage available for budget accounting', async () => {
  const body = { id: 'fixture-incomplete', model: 'fixture-model', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    usage: { input_tokens: 100, output_tokens: 256, total_tokens: 356 }, output: [] };
  await assert.rejects(createResponse({ model: 'fixture-model' }, { apiKey, fetchImpl: async () => Response.json(body) }), error => {
    assert.match(error.message, /incomplete/);
    assert.deepEqual(error.response, body);
    assert.equal(error.response.usage.total_tokens, 356);
    assert.equal(error.message.includes(apiKey), false);
    return true;
  });
});

test('provider HTTP errors never echo the API key into an error message', async () => {
  await assert.rejects(createResponse({ model: 'fixture-model' }, { apiKey,
    fetchImpl: async () => Response.json({ error: { message: `Invalid Authorization: Bearer ${apiKey}` } }, { status: 401 }) }), error => {
    assert.match(error.message, /401/);
    assert.equal(error.message.includes(apiKey), false);
    return true;
  });
});

test('transport errors never echo the API key into an error message', async () => {
  await assert.rejects(createResponse({ model: 'fixture-model' }, { apiKey,
    fetchImpl: async () => { throw new Error(`Could not send request with Authorization: Bearer ${apiKey}`); } }), error => {
    assert.equal(error.message.includes(apiKey), false);
    return true;
  });
});
