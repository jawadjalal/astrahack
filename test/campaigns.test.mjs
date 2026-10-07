import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { campaignSchema, generateCampaigns, planCampaigns, validateCampaign } from '../lib/campaigns.mjs';

function fixture(channel) {
  function fill(schema) {
    if (schema.type === 'string') return 'Specific product detail';
    if (schema.type === 'integer') return 1;
    if (schema.type === 'array') return Array.from({ length: schema.minItems }, () => fill(schema.items));
    return Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, fill(v)]));
  }
  const result = fill(campaignSchema(channel));
  result.posts.forEach((p, i) => { p.id = `${channel}-${i + 1}`; });
  result.calendar.forEach((d, i) => { d.day = i + 1; d.contentId = result.posts[i % result.posts.length].id; });
  return result;
}
const streamed = body => new Response(`event: response.${body.status}\ndata: ${JSON.stringify({ type: `response.${body.status}`, response: body })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
const response = (channel, finishReason = 'STOP') => Response.json({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(fixture(channel)) }] } }] });
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'campaign-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('generates both channel documents with authenticated structured requests', async t => {
  const calls = [];
  const { runDir, manifest } = await generateCampaigns({ provider: 'gemini', prompt: 'Gradlify tutoring campaign', apiKey: 'test-secret', outputDir: await temp(t), fetchImpl: async (url, init) => {
    calls.push({ url, ...init }); return response(calls.length === 1 ? 'x' : 'reddit');
  } });
  assert.equal(manifest.status, 'complete'); assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['x-goog-api-key'], 'test-secret');
  assert.equal(JSON.parse(calls[0].body).generationConfig.responseMimeType, 'application/json');
  assert.ok(calls.every(c => c.url.includes('gemini-2.5-flash:generateContent')));
  assert.deepEqual((await readdir(runDir)).sort(), ['manifest.json', 'reddit-campaign.json', 'reddit-campaign.md', 'x-campaign.json', 'x-campaign.md']);
  assert.match(await readFile(join(runDir, 'reddit-campaign.md'), 'utf8'), /Community Approach|Community approach/);
  assert.ok(!(await readFile(join(runDir, 'manifest.json'), 'utf8')).includes('test-secret'));
});
test('dry run requires no key or network and validates input before output', async t => {
  const outputDir = await temp(t);
  for (const input of [{ prompt: '' }, { prompt: 'a', channels: ['x', 'x'] }, { prompt: 'a', channels: ['bad'] }]) {
    await assert.rejects(generateCampaigns({ provider: 'gemini', ...input, outputDir, dryRun: true }));
  }
  await assert.rejects(generateCampaigns({ provider: 'gemini', prompt: 'Product', outputDir, apiKey: '' }), /GEMINI_API_KEY/);
  assert.deepEqual(await readdir(outputDir), []);
  const { manifest, runDir } = await generateCampaigns({ provider: 'gemini', prompt: 'Product', outputDir, apiKey: '', dryRun: true, fetchImpl: () => assert.fail('network') });
  assert.equal(manifest.status, 'dry-run'); assert.deepEqual(await readdir(runDir), ['manifest.json']);
  assert.match(planCampaigns('Product')[1].prompt, /disclose product affiliation/);
});
test('channel failure preserves successful campaign without retries or provider error leaks', async t => {
  let calls = 0;
  const { manifest, runDir } = await generateCampaigns({ provider: 'gemini', prompt: 'Product', apiKey: 'secret', outputDir: await temp(t), fetchImpl: async () => ++calls === 1 ? response('x') : Response.json({ error: 'secret' }, { status: 429 }) });
  assert.equal(calls, 2); assert.equal(manifest.status, 'partial');
  assert.equal(manifest.campaigns[1].error, 'Provider request failed (HTTP 429).');
  assert.ok(!(await readFile(join(runDir, 'manifest.json'), 'utf8')).includes('secret'));
  assert.ok((await readdir(runDir)).includes('x-campaign.md'));
});
test('rejects malformed, truncated and structurally incomplete responses', async t => {
  for (const fetchImpl of [async () => response('x', 'MAX_TOKENS'), async () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}' }] } }] }), async () => Response.json({ candidates: [] })]) {
    const { manifest, runDir } = await generateCampaigns({ provider: 'gemini', prompt: 'Product', channels: ['x'], apiKey: 'fake', outputDir: await temp(t), fetchImpl });
    assert.equal(manifest.status, 'failed'); assert.deepEqual(await readdir(runDir), ['manifest.json']);
  }
});
test('rejects overlength X posts, duplicate days and nonexistent content references', () => {
  const tooLong = fixture('x'); tooLong.posts[0].copy = '🙂'.repeat(71);
  assert.throws(() => validateCampaign(tooLong, 'x'), /280-byte/);
  const duplicate = fixture('reddit'); duplicate.calendar[1].day = 1;
  assert.throws(() => validateCampaign(duplicate, 'reddit'), /calendar/);
  const dangling = fixture('x'); dangling.calendar[0].contentId = 'nonexistent';
  assert.throws(() => validateCampaign(dangling, 'x'), /calendar/);
});

test('OpenAI Luna generates both campaigns through strict Responses output', async t => {
  const calls = [];
  const { manifest, runDir } = await generateCampaigns({ provider: 'openai', prompt: 'Observed product and launch brief', apiKey: 'openai-test-secret', outputDir: await temp(t),
    fetchImpl: async (url, init) => {
      calls.push({ url, init, payload: JSON.parse(init.body) });
      return streamed({ status: 'completed', usage: { input_tokens: 20, output_tokens: 400 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(fixture(calls.length === 1 ? 'x' : 'reddit')) }] }] });
    } });
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.provider, 'openai');
  assert.equal(manifest.model, 'gpt-6-luna');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url === 'https://api.openai.com/v1/responses'));
  assert.ok(calls.every(call => call.init.headers.Authorization === 'Bearer openai-test-secret'));
  assert.ok(calls.every(call => call.payload.model === 'gpt-6-luna' && call.payload.store === false));
  assert.ok(calls.every(call => call.payload.stream === true && call.payload.reasoning.effort === 'none'));
  assert.equal(calls[0].payload.text.format.strict, true);
  assert.deepEqual(calls[0].payload.text.format.schema, campaignSchema('x'));
  assert.equal(manifest.campaigns[0].usage.output_tokens, 400);
  assert.deepEqual((await readdir(runDir)).sort(), ['manifest.json', 'reddit-campaign.json', 'reddit-campaign.md', 'x-campaign.json', 'x-campaign.md']);
});

test('incomplete OpenAI campaign output is marked failed without saving drafts or retrying', async t => {
  let calls = 0;
  const { manifest, runDir } = await generateCampaigns({ provider: 'openai', prompt: 'Product', channels: ['x'], apiKey: 'fixture-key', outputDir: await temp(t),
    fetchImpl: async () => { calls++; return streamed({ status: 'incomplete', output: [], usage: { input_tokens: 50, output_tokens: 16384 } }); } });
  assert.equal(calls, 1);
  assert.equal(manifest.status, 'failed');
  assert.match(manifest.campaigns[0].error, /did not finish/);
  assert.equal(manifest.campaigns[0].attempts[0].usage.output_tokens, 16384);
  assert.deepEqual(await readdir(runDir), ['manifest.json']);
});

test('resume retries only the failed channel and retains its original error', async t => {
  let initialCalls = 0;
  const reply = channel => streamed({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(fixture(channel)) }] }] });
  const first = await generateCampaigns({ provider: 'openai', prompt: 'Product', apiKey: 'fixture-key', outputDir: await temp(t), fetchImpl: async () => ++initialCalls === 1 ? Response.json({}, { status: 503 }) : reply('reddit') });
  const preserved = await readFile(join(first.runDir, 'reddit-campaign.md'), 'utf8');
  let retryCalls = 0;
  const resumed = await generateCampaigns({ resumeDir: first.runDir, apiKey: 'fixture-key', fetchImpl: async () => { retryCalls++; return reply('x'); } });
  assert.equal(retryCalls, 1);
  assert.equal(resumed.manifest.status, 'complete');
  assert.equal(await readFile(join(first.runDir, 'reddit-campaign.md'), 'utf8'), preserved);
  assert.match(resumed.manifest.campaigns[0].attempts[0].error, /503/);
  assert.equal(resumed.manifest.campaigns[0].attempts[1].status, 'complete');
  assert.equal(resumed.manifest.campaigns[1].attempts.length, 1);
});
