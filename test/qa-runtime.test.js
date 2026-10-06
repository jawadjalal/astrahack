import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunBudget, RunLimitError } from '../src/qa-runtime.js';
import { runQaAgent } from '../src/qa-agent.js';

test('simultaneous workers reserve one shared request cap before any response arrives', async () => {
  const pending = [];
  const budget = createRunBudget(payload => new Promise(resolve => pending.push({ payload, resolve })), { maxRequests: 3 });
  const results = Promise.allSettled(Array.from({ length: 12 }, (_, worker) => budget.request({ model: 'worker-model', worker })));
  assert.equal(pending.length, 3);
  assert.equal(budget.usage.requests, 3);
  assert.equal(budget.usage.completedRequests, 0);
  assert.throws(() => budget.check(), RunLimitError);
  // Finish out of order: a freed request must never create a new budget slot.
  for (const request of pending.toReversed()) request.resolve({ model: request.payload.model });
  const settled = await results;
  assert.equal(settled.filter(item => item.status === 'fulfilled').length, 3);
  const rejected = settled.filter(item => item.status === 'rejected');
  assert.equal(rejected.length, 9);
  assert.ok(rejected.every(item => item.reason instanceof RunLimitError));
  await assert.rejects(budget.request({ model: 'worker-model' }), /Shared API request limit/);
  assert.equal(pending.length, 3);
  assert.equal(budget.usage.completedRequests, 3);
  assert.equal(budget.usage.failedRequests, 0);
});

test('provider failures consume their reserved slot and do not fabricate token usage', async () => {
  const failure = new Error('Provider rejected the request');
  let calls = 0;
  const budget = createRunBudget(async () => { calls++; throw failure; }, { maxRequests: 1 });
  await assert.rejects(budget.request({ model: 'worker-model' }), error => error === failure);
  await assert.rejects(budget.request({ model: 'worker-model' }), RunLimitError);
  assert.equal(calls, 1);
  assert.equal(budget.usage.requests, 1);
  assert.equal(budget.usage.failedRequests, 1);
  assert.equal(budget.usage.completedRequests, 0);
  assert.equal(budget.usage.totalTokens, 0);
});

test('incomplete provider responses retain billed usage while counting as failed requests', async () => {
  const incomplete = Object.assign(new Error('OpenAI response status: incomplete'), { response: {
    model: 'billed-model', status: 'incomplete',
    usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 80 }, output_tokens: 64, total_tokens: 184 }
  } });
  const budget = createRunBudget(async () => { throw incomplete; });
  await assert.rejects(budget.request({ model: 'requested-model' }), error => error === incomplete);
  assert.equal(budget.usage.requests, 1);
  assert.equal(budget.usage.failedRequests, 1);
  assert.equal(budget.usage.completedRequests, 0);
  assert.equal(budget.usage.inputTokens, 120);
  assert.equal(budget.usage.cachedInputTokens, 80);
  assert.equal(budget.usage.outputTokens, 64);
  assert.equal(budget.usage.totalTokens, 184);
  assert.deepEqual(budget.usage.byModel['billed-model'], { requests: 1, inputTokens: 120, cachedInputTokens: 80, outputTokens: 64, totalTokens: 184 });
});

test('model names matching object prototype properties each receive isolated usage totals', async () => {
  const budget = createRunBudget(async payload => ({ model: payload.model, usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }));
  for (const model of ['__proto__', 'constructor', 'toString']) {
    await budget.request({ model });
    assert.equal(Object.hasOwn(budget.usage.byModel, model), true);
    assert.deepEqual(budget.usage.byModel[model], { requests: 1, inputTokens: 3, cachedInputTokens: 0, outputTokens: 2, totalTokens: 5 });
  }
  assert.equal(budget.usage.requests, 3);
  assert.equal(budget.usage.totalTokens, 15);
});

test('shared output cap is sent to every provider call and usage aggregates by response model', async () => {
  const sent = [];
  const responses = [
    { model: 'actual-model', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 20, total_tokens: 120 } },
    { model: 'actual-model', usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 } },
    { usage: { input_tokens: 25, output_tokens: 5, total_tokens: 30 } },
    {}
  ];
  const budget = createRunBudget(async (payload, options) => { sent.push({ payload, options }); return responses.shift(); }, { maxOutputTokens: 512 });
  const payload = { model: 'requested-model', max_output_tokens: 32000 };
  await budget.request(payload);
  await budget.request({ model: 'requested-model' });
  await budget.request({ model: 'fallback-model' });
  await budget.request({ model: 'fallback-model' });
  assert.equal(payload.max_output_tokens, 32000, 'The shared wrapper must not mutate its caller payload');
  assert.ok(sent.every(item => item.payload.max_output_tokens === 512));
  assert.ok(sent.every(item => item.options.signal === budget.signal));
  assert.equal(budget.usage.requests, 4);
  assert.equal(budget.usage.completedRequests, 4);
  assert.equal(budget.usage.failedRequests, 0);
  assert.equal(budget.usage.inputTokens, 175);
  assert.equal(budget.usage.cachedInputTokens, 60);
  assert.equal(budget.usage.outputTokens, 35);
  assert.equal(budget.usage.totalTokens, 210);
  assert.deepEqual(budget.usage.byModel['actual-model'], { requests: 2, inputTokens: 150, cachedInputTokens: 60, outputTokens: 30, totalTokens: 180 });
  assert.deepEqual(budget.usage.byModel['fallback-model'], { requests: 2, inputTokens: 25, cachedInputTokens: 0, outputTokens: 5, totalTokens: 30 });
});

test('external cancellation aborts all pending workers and refuses future requests', async () => {
  const controller = new AbortController();
  const signals = [];
  const budget = createRunBudget((payload, { signal }) => new Promise((resolve, reject) => {
    signals.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), { signal: controller.signal });
  const results = Promise.allSettled([budget.request({ model: 'one' }), budget.request({ model: 'two' })]);
  controller.abort(new Error('User cancelled the run'));
  const settled = await results;
  assert.ok(signals.every(signal => signal.aborted));
  assert.ok(settled.every(item => item.status === 'rejected' && item.reason instanceof RunLimitError));
  assert.equal(budget.usage.requests, 2);
  assert.equal(budget.usage.failedRequests, 2);
  assert.equal(budget.usage.completedRequests, 0);
  await assert.rejects(budget.request({ model: 'three' }), /cancelled or time limit reached/);
  assert.equal(signals.length, 2);
});

test('already-cancelled runs never reserve or dispatch a provider request', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const budget = createRunBudget(async () => { called = true; return {}; }, { signal: controller.signal });
  assert.throws(() => budget.check(), RunLimitError);
  await assert.rejects(budget.request({ model: 'worker-model' }), RunLimitError);
  assert.equal(called, false);
  assert.equal(budget.usage.requests, 0);
  assert.equal(budget.usage.failedRequests, 0);
});

test('deadline aborts an active provider request instead of waiting for another turn', async () => {
  const budget = createRunBudget((payload, { signal }) => new Promise((resolve, reject) => {
    // Keep the process alive because AbortSignal.timeout itself uses an unref timer.
    const fallback = setTimeout(() => reject(new Error('Deadline did not abort provider request')), 2000);
    signal.addEventListener('abort', () => { clearTimeout(fallback); reject(signal.reason); }, { once: true });
  }), { maxDurationMs: 1000 });
  await assert.rejects(budget.request({ model: 'worker-model' }), error => error instanceof RunLimitError && /time limit reached/.test(error.message));
  assert.equal(budget.signal.aborted, true);
  assert.equal(budget.usage.failedRequests, 1);
  assert.equal(budget.usage.completedRequests, 0);
});

test('a cancelled QA worker writes a terminal report before attempting browser startup', async () => {
  const output = await mkdtemp(join(tmpdir(), 'astrahack-cancelled-worker-'));
  const controller = new AbortController();
  controller.abort();
  let called = false;
  try {
    const { report } = await runQaAgent({ url: 'https://site.test/', chrome: '/nonexistent/browser', output,
      signal: controller.signal, request: async () => { called = true; return {}; } });
    assert.equal(report.status, 'limit_reached');
    assert.match(report.error, /cancelled or time limit reached/);
    assert.equal(report.usage.requests, 0);
    assert.equal(report.steps.length, 0);
    assert.equal(called, false);
    const saved = JSON.parse(await readFile(join(output, 'qa-agent.json'), 'utf8'));
    assert.equal(saved.status, 'limit_reached');
    assert.ok(saved.finishedAt);
  } finally { await rm(output, { recursive: true, force: true }); }
});


test('transient provider failures retry twice and count every API attempt', async () => {
  let calls = 0;
  const budget = createRunBudget(async () => {
    if (++calls < 3) throw Object.assign(new Error('Temporary server failure'), { status: 500 });
    return { model: 'gpt-6-luna', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
  });
  await budget.request({ model: 'gpt-6-luna' });
  assert.equal(budget.usage.requests, 3);
  assert.equal(budget.usage.failedRequests, 2);
  assert.equal(budget.usage.completedRequests, 1);
  assert.equal(budget.usage.totalTokens, 12);
});
