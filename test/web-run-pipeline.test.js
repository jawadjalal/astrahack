import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { runWebPipeline } from '../src/web-run-pipeline.js';

test('pipeline propagates submitted URL and run identity through bounded exploration and canvas publishing', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'astra-web-pipeline-'));
  const events = [];
  const calls = [];
  const job = { id: 'customer-run', url: 'https://customer.example/app?demo=2' };
  const output = join(outputRoot, 'web-customer-run');
  try {
    const result = await runWebPipeline(job, { outputRoot, chrome: '/fixture/chrome', canvasUrl: 'https://ignura.com/astrahack',
      onProgress: event => events.push(event), fileExists: async () => true,
      fleet: async options => {
        calls.push('fleet');
        assert.equal(options.url, job.url);
        assert.equal(options.output, output);
        assert.equal(options.chrome, '/fixture/chrome');
        assert.equal(Object.hasOwn(options, 'maxRequests'), false);
        assert.equal(Object.hasOwn(options, 'concurrency'), false);
        assert.equal(Object.hasOwn(options, 'maxAgents'), false);
        assert.equal(options.maxDurationMs, 300_000);
        return { fleet: { status: 'completed' } };
      }, analyze: async path => { calls.push('analyze'); assert.equal(path, output); },
      capture: async path => { calls.push('capture'); assert.equal(path, join(output, 'fleet.json')); return { outputDir: join(output, 'feature-captures'), manifest: { gaps: [] } }; },
      publish: async (path, options) => { calls.push('publish'); assert.equal(path, output); assert.equal(options.runId, job.id); assert.equal(options.canvasUrl, 'https://ignura.com/astrahack'); assert.equal(options.clear, undefined); },
      publishFeatures: async (path, options) => { calls.push('features'); assert.equal(path, join(output, 'feature-captures/manifest.json')); assert.equal(options.canvasUrl, 'https://ignura.com/astrahack'); return {}; },
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(calls, ['fleet', 'analyze', 'capture', 'publish', 'features']);
    assert.deepEqual(events.map(event => event.stage), ['exploring', 'analyzing', 'capturing', 'publishing', 'publishing_features']);
  } finally { await rm(outputRoot, { recursive: true, force: true }); }
});

test('failed fleet and analysis preserve crawl evidence and publish partial results with sanitized failures', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'astra-web-pipeline-partial-'));
  const events = [];
  let published = 0;
  const secret = 'provider-request-secret';
  try {
    const result = await runWebPipeline({ id: 'partial', url: 'https://customer.example' }, {
      outputRoot, onProgress: event => events.push(event),
      fileExists: async path => basename(path) === 'crawl.json',
      fleet: async () => { throw new Error(secret); },
      analyze: async () => { throw new Error(secret); },
      capture: async path => { assert.equal(basename(path), 'crawl.json'); throw new Error(secret); },
      publish: async () => { published++; },
    });
    assert.equal(result.status, 'partial');
    assert.equal(published, 1);
    assert.deepEqual(result.failures, ['exploring', 'analyzing', 'capturing']);
    assert.ok(!JSON.stringify([result, events]).includes(secret));
  } finally { await rm(outputRoot, { recursive: true, force: true }); }
});

test('fleet limits remain partial even when every downstream stage succeeds', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'astra-web-pipeline-limit-'));
  try {
    const result = await runWebPipeline({ id: 'limited', url: 'https://customer.example' }, {
      outputRoot, fileExists: async path => basename(path) !== 'manifest.json',
      fleet: async () => ({ fleet: { status: 'partial' } }), analyze: async () => {},
      capture: async () => ({ manifest: { gaps: [] } }), publish: async () => {},
    });
    assert.equal(result.status, 'partial');
    assert.match(result.message, /Coverage limits/);
  } finally { await rm(outputRoot, { recursive: true, force: true }); }
});

test('no recorded evidence fails without paid downstream calls or publishing', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'astra-web-pipeline-empty-'));
  try {
    const unexpected = () => assert.fail('must not run without evidence');
    const result = await runWebPipeline({ id: 'empty', url: 'https://customer.example' }, {
      outputRoot, fileExists: async () => false, fleet: async () => { throw new Error('Browser unavailable'); },
      analyze: unexpected, capture: unexpected, publish: unexpected,
    });
    assert.equal(result.status, 'failed');
  } finally { await rm(outputRoot, { recursive: true, force: true }); }
});
