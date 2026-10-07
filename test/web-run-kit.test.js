import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateWebKit, marketingReport, namespaceKitOps, publishWebKit } from '../src/web-run-kit.js';

test('kit publisher rejects redirected and HTML responses before uploading or posting', async () => {
  for (const bad of [
    () => new Response(null, { status: 301, headers: { location: '/canvas' } }),
    () => new Response('<html>Wrong application</html>', { headers: { 'content-type': 'text/html' } }),
    () => Object.defineProperty(Response.json({ ops: [] }), 'redirected', { value: true })
  ]) {
    let calls = 0;
    await assert.rejects(publishWebKit({}, { output: '/tmp', canvasUrl: 'https://canvas.example/astrahack', runId: 'route-test', board: 'route-test',
      fetchImpl: async (url, init) => {
        calls++;
        assert.equal(init.redirect, 'manual');
        assert.equal(new URL(url).searchParams.get('board'), 'route-test');
        return bad();
      }
    }), /redirected|non-JSON/);
    assert.equal(calls, 1);
  }
});

const crawl = { product: { title: 'Example product', url: 'https://example.com/', text: 'An observed service.' },
  pages: [{ url: 'https://example.com/', status: 'visited', screenshot: 'screenshots/home.png',
    observation: { title: 'Example product', url: 'https://example.com/', headings: [{ text: 'Observed feature' }], text: 'An observed service.' } }], assets: [] };

test('marketing adapter retains recorded actions and evidence without fabricating assertions', () => {
  const agent = { status: 'completed', workers: [{ id: 'A001', mission: 'journey', url: 'https://example.com/', status: 'completed' }],
    steps: [{ index: 4, workerId: 'A001', type: 'click', action: { type: 'click', x: 20, y: 30 }, status: 'passed', screenshot: 'workers/A001/004.png', observation: crawl.product }], assets: [] };
  const report = marketingReport({ agent, crawl, url: 'https://example.com/', runId: 'demo' });
  assert.equal(report.journeys[0].steps[0].action, 'click');
  assert.equal(report.journeys[0].steps[0].screenshot, 'workers/A001/004.png');
  assert.equal(report.journeys[1].steps[0].action, 'observe');
  assert.equal(report.journeys[1].steps[0].index, 5);
});

test('real generator routes run concurrently, preserve partial output, and never select mocks', async () => {
  const output = await mkdtemp(join(tmpdir(), 'web-kit-generate-'));
  const started = [];
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const begin = async (name, options) => {
    assert.equal(options.provider, 'openai');
    assert.equal(options.mock, undefined);
    assert.equal(options.dryRun, undefined);
    if (name !== 'ugc') assert.equal(options.requestTimeoutMs, 600000);
    started.push(name);
    if (started.length === 3) release();
    await barrier;
  };
  try {
    await writeFile(join(output, 'crawl.json'), JSON.stringify(crawl));
    const result = await generateWebKit(output, { url: 'https://example.com/', runId: 'demo', env: {},
      ads: async options => { await begin('ads', options); assert.equal(options.openaiApi, 'responses'); throw new Error('secret-provider-body'); },
      campaigns: async options => { await begin('campaigns', options); assert.deepEqual(options.channels, ['x', 'reddit']); return { runDir: 'real-campaigns', manifest: { status: 'complete' } }; },
      ugc: async options => { await begin('ugc', options); assert.ok(options.report.journeys.length); return { scripts: [{ id: 'S1' }] }; },
      render: () => 'Generated UGC scripts'
    });
    assert.deepEqual(started, ['ads', 'campaigns', 'ugc']);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.failures, ['ads']);
    assert.equal(result.ads, null);
    assert.equal(result.campaigns.runDir, 'real-campaigns');
    assert.ok((await readFile(join(output, 'ugc-plan.json'), 'utf8')).includes('S1'));
    assert.ok(!(await readFile(join(output, 'launch-kit.json'), 'utf8')).includes('secret-provider-body'));
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('incomplete generators with surviving ads and Reddit remain partial when UGC fails', async () => {
  const output = await mkdtemp(join(tmpdir(), 'web-kit-surviving-'));
  try {
    await writeFile(join(output, 'crawl.json'), JSON.stringify(crawl));
    const result = await generateWebKit(output, { url: 'https://example.com/', runId: 'partial', env: {},
      ads: async () => ({ runDir: 'real-ads', manifest: { status: 'partial', creatives: [{ status: 'complete' }, { status: 'failed' }] } }),
      campaigns: async () => ({ runDir: 'real-campaigns', manifest: { status: 'partial', campaigns: [{ channel: 'x', status: 'failed' }, { channel: 'reddit', status: 'complete' }] } }),
      ugc: async () => { throw new Error('failed'); }
    });
    assert.equal(result.failures.length, 3);
    assert.equal(result.status, 'partial');
    assert.equal(JSON.parse(await readFile(join(output, 'launch-kit.json'), 'utf8')).status, 'partial');
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('older canvas schemas skip unsupported decorations while required and other failures still throw', async () => {
  const output = await mkdtemp(join(tmpdir(), 'web-kit-old-canvas-'));
  const kit = { ads: { manifest: { creatives: [{ index: 1, name: 'hero', filename: 'hero.png', status: 'failed' }] } } };
  try {
    for (const scenario of [
      { status: 400, message: 'invalid op(s)', optional: true, succeeds: true },
      { status: 503, message: 'unavailable', optional: true, succeeds: false },
      { status: 400, message: 'invalid JSON body', optional: true, succeeds: false },
      { status: 400, message: 'invalid op(s)', optional: false, succeeds: false }
    ]) {
      const posted = [];
      const task = publishWebKit(kit, { output, canvasUrl: 'https://canvas.example', runId: 'old-server',
        fetchImpl: async (url, init) => {
          if (url.endsWith('/state')) return Response.json({ ops: [] });
          const body = JSON.parse(init.body);
          const optional = !Array.isArray(body) && ['say', 'group'].includes(body.type);
          if (optional === scenario.optional) return Response.json({ error: scenario.message }, { status: scenario.status });
          posted.push(...(Array.isArray(body) ? body : [body]));
          return Response.json({ ok: true });
        }
      });
      if (!scenario.succeeds) await assert.rejects(task, /Canvas request failed/);
      else {
        const result = await task;
        assert.ok(result.optionalSkipped > 0);
        assert.equal(result.warnings.length, result.optionalSkipped);
        assert.equal(result.postedCount, posted.length);
        assert.ok(result.postedCount > 0);
      }
    }
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('run namespaces isolate generated IDs while retaining external screenshot arrows', () => {
  const ops = [{ type: 'add_shape', id: 'ugc-S1' }, { type: 'add_arrow', id: 'kit-arrow', from: 'ugc-S1', to: 'run-existing-step-4' },
    { type: 'group', id: 'kit-group', ids: ['ugc-S1'] }, { type: 'say', target: 'ugc-S1', text: 'Draft' }];
  const first = namespaceKitOps(ops, 'first');
  const second = namespaceKitOps(ops, 'second');
  assert.notEqual(first[0].id, second[0].id);
  assert.equal(first[1].from, first[0].id);
  assert.equal(first[1].to, 'run-existing-step-4');
  assert.equal(first[2].ids[0], first[0].id);
  assert.equal(first[3].target, first[0].id);
});

test('kit publisher uploads real files and appends namespaced ops beside an existing kit', async () => {
  const output = await mkdtemp(join(tmpdir(), 'web-kit-publish-'));
  const posted = [];
  let uploads = 0;
  try {
    const directory = join(output, 'ads');
    await mkdir(directory);
    const bytes = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
    bytes.writeUInt32BE(1024, 16); bytes.writeUInt32BE(1024, 20);
    await writeFile(join(directory, 'hero.png'), bytes);
    const kit = { ads: { runDir: directory, manifest: { creatives: [{ index: 1, name: 'hero', filename: 'hero.png', status: 'complete', prompt: 'Observed service advertisement' }] } } };
    const result = await publishWebKit(kit, { output, canvasUrl: 'https://canvas.example/astrahack', runId: 'public-trial',
      fetchImpl: async (url, init = {}) => {
        assert.notEqual(init.method, 'DELETE');
        if (url.endsWith('/state')) return Response.json({ ops: [{ op: { type: 'add_shape', id: 'kit-old', kind: 'note', x: 0, y: 0, w: 200, h: 200, text: 'Existing kit' } }] });
        if (url.endsWith('/upload')) { uploads++; assert.ok(init.body instanceof FormData); return Response.json({ url: '/astrahack/uploads/hero.png' }); }
        const ops = JSON.parse(init.body);
        posted.push(...(Array.isArray(ops) ? ops : [ops]));
        return Response.json({ ok: true });
      }
    });
    assert.equal(uploads, 1);
    assert.ok(result.postedCount > 0);
    assert.ok(posted.some(op => op.type === 'add_image' && op.src === '/astrahack/uploads/hero.png'));
    assert.ok(posted.filter(op => op.id).every(op => /^run-[a-f0-9]{12}-kit-/.test(op.id)));
    assert.ok(posted.every(op => !['clear', 'delete'].includes(op.type)));
  } finally { await rm(output, { recursive: true, force: true }); }
});


test('web kit injects streaming UGC requests with caller cancellation and terminal output', async () => {
  const output = await mkdtemp(join(tmpdir(), 'web-kit-stream-'));
  const controller = new AbortController();
  let requestSignal;
  try {
    await writeFile(join(output, 'crawl.json'), JSON.stringify(crawl));
    const result = await generateWebKit(output, { url: 'https://example.com/', runId: 'stream', env: {}, signal: controller.signal,
      ads: async () => ({ manifest: { status: 'complete' } }),
      campaigns: async () => ({ manifest: { status: 'complete' } }),
      ugc: async options => {
        const response = await options.request({ model: 'gpt-6-luna' }, { apiKey: 'fixture-key', fetchImpl: options.fetchImpl });
        assert.equal(response.status, 'completed');
        return { scripts: [{ id: 'S1' }] };
      },
      render: () => 'Generated scripts',
      fetchImpl: async (url, init) => {
        assert.equal(url, 'https://api.openai.com/v1/responses');
        assert.equal(JSON.parse(init.body).stream, true);
        requestSignal = init.signal;
        return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n');
      }
    });
    assert.equal(result.status, 'complete');
    controller.abort();
    assert.equal(requestSignal.aborted, true);
  } finally { await rm(output, { recursive: true, force: true }); }
});
