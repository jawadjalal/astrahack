import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedVmChromeFlags } from '../src/cdp.js';
import { createRunClient, publicAddress, runWorker, validatePublicTarget, workerPreflight } from '../src/web-run-worker.js';

test('public target validation rejects private DNS answers, alternate IP encodings and unsupported targets', async () => {
  for (const address of ['127.0.0.1', '10.3.4.5', '172.20.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://[::1]', 'file:///etc/passwd', 'https://user:secret@example.com', 'https://example.com:8080', 'http://service.local']) await assert.rejects(validatePublicTarget(url));
  await assert.rejects(validatePublicTarget('https://example.com', { lookupImpl: async () => [{ address: '93.184.215.14' }, { address: '10.1.2.3' }] }), /Private/);
  assert.equal(await validatePublicTarget('https://example.com/product?view=1#part', { lookupImpl: async () => [{ address: '93.184.215.14' }] }), 'https://example.com/product?view=1');
});

test('preflight rejects missing credentials or Chrome before work starts', async () => {
  const options = { canvasUrl: 'https://ignura.com/astrahack', token: 'worker-test-token-long-enough', chrome: process.execPath, apiKey: 'fixture-key' };
  await workerPreflight(options);
  await assert.rejects(workerPreflight({ ...options, apiKey: '' }), /OPENAI_API_KEY/);
  await assert.rejects(workerPreflight({ ...options, chrome: '' }), /ASTRAHACK_CHROME/);
  await assert.rejects(workerPreflight({ ...options, token: '' }), /ASTRAHACK_WORKER_TOKEN/);
});

test('worker claims dynamic URL under /astrahack, heartbeats, saves partial and never reruns a recorded attempt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-web-worker-'));
  const token = 'worker-test-token-long-enough';
  const job = { id: 'a9b9a561-4fda-4af7-ae41-02114c8e047c', url: 'https://customer.example/products?test=1', status: 'queued' };
  const seen = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    seen.push({ method: req.method, path: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') res.end(JSON.stringify({ runs: [job] }));
    else res.end(JSON.stringify({ run: { ...job, ...body, status: body?.status || 'running' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const canvasUrl = `http://127.0.0.1:${server.address().port}/astrahack`;
  let calls = 0;
  const options = { canvasUrl, token, chrome: '/fixture/chrome', outputRoot: directory, once: true, heartbeatMs: 5,
    validateTarget: async url => url, log: () => {}, pipeline: async (received, opts) => {
      calls++;
      assert.equal(received.url, job.url);
      assert.equal(opts.canvasUrl, canvasUrl);
      await opts.onProgress({ stage: 'exploring', message: 'Exploring.' });
      await delay(20);
      return { status: 'partial', stage: 'finished', message: 'Coverage limits remain.' };
    },
  };
  try {
    assert.deepEqual(await runWorker(options), { processed: 1 });
    assert.equal(calls, 1);
    assert.ok(seen.every(item => item.path.startsWith('/astrahack/api/runs')));
    assert.ok(seen.some(item => item.path.endsWith('/claim') && item.body.workerId));
    assert.ok(seen.filter(item => item.method === 'PATCH' && item.body.status === 'running').length >= 2);
    assert.equal(seen.at(-1).body.status, 'partial');
    // Simulate an incorrectly requeued server record after a worker restart: marker still prevents paid work.
    await runWorker(options);
    assert.equal(calls, 1);
    assert.equal(seen.at(-1).body.status, 'failed');
    assert.match(seen.at(-1).body.message, /previous worker attempt/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});

test('request timeouts and API failures do not expose credentials or response bodies', async () => {
  const secret = 'credential-not-for-logs';
  const rejected = createRunClient({ canvasUrl: 'https://canvas.example/astrahack', token: secret,
    fetchImpl: async () => new Response(JSON.stringify({ error: secret }), { status: 403 }) });
  await assert.rejects(rejected(''), error => error.status === 403 && !error.message.includes(secret));
  const timeout = createRunClient({ canvasUrl: 'https://canvas.example/astrahack', token: secret, timeoutMs: 5,
    fetchImpl: async (_url, init) => { await delay(100, undefined, { signal: init.signal }); return new Response('{}'); } });
  await assert.rejects(timeout(''), /request limit/);
});

test('lost terminal update retries status delivery without repeating the pipeline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-web-worker-final-'));
  let calls = 0;
  let terminalWrites = 0;
  const job = { id: 'terminal-retry', url: 'https://customer.example' };
  try {
    await runWorker({ once: true, canvasUrl: 'https://canvas.example', outputRoot: directory, log: () => {},
      validateTarget: async url => url,
      request: async (path, options) => {
        if (!path) return { runs: [job] };
        if (path.endsWith('/claim')) return { run: job };
        if (options.body.status === 'completed' && ++terminalWrites < 3) throw new Error('lost reply');
        return { run: job };
      }, pipeline: async () => { calls++; return { status: 'completed', message: 'Done.' }; },
    });
    assert.equal(calls, 1);
    assert.equal(terminalWrites, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('shutdown interrupts active pipeline and stores failure without taking another run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-web-worker-stop-'));
  const stop = new AbortController();
  const states = [];
  let calls = 0;
  const job = { id: 'interrupted', url: 'https://customer.example' };
  try {
    await runWorker({ canvasUrl: 'https://canvas.example', outputRoot: directory, signal: stop.signal, log: () => {},
      validateTarget: async url => url,
      request: async (path, options) => {
        if (!path) return { runs: [job, { ...job, id: 'second' }] };
        if (path.endsWith('/claim')) return { run: job };
        states.push(options.body);
        return { run: job };
      }, pipeline: async (_job, { signal }) => { calls++; stop.abort(); signal.throwIfAborted(); },
    });
    assert.equal(calls, 1);
    assert.equal(states.at(-1).status, 'failed');
    assert.match(states.at(-1).message, /interrupted/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('--run-id claims only the named run, ignores the rest of the queue, and exits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-web-worker-runid-'));
  const paths = [];
  const target = { id: 'target-run', url: 'https://customer.example' };
  try {
    const result = await runWorker({ runId: target.id, once: false, canvasUrl: 'https://canvas.example', outputRoot: directory, log: () => {},
      validateTarget: async url => url,
      request: async (path, options) => {
        paths.push(`${options?.method || 'GET'} ${path}`);
        if (path.endsWith('/claim')) return { run: target };
        return { run: target };
      }, pipeline: async () => ({ status: 'completed', message: 'Done.' }) });
    assert.deepEqual(result, { processed: 1 });
    assert.ok(!paths.includes('GET '), 'must not list the queue');
    assert.ok(paths.every(path => path.includes('/target-run')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('--run-id exits quietly when another worker already claimed the run', async () => {
  let pipelines = 0;
  const logs = [];
  const result = await runWorker({ runId: 'taken-run', canvasUrl: 'https://canvas.example', log: line => logs.push(line),
    request: async path => { if (path.endsWith('/claim')) throw Object.assign(new Error('conflict'), { status: 409 }); throw new Error('unexpected'); },
    pipeline: async () => { pipelines++; return { status: 'completed' }; } });
  assert.deepEqual(result, { processed: 0 });
  assert.equal(pipelines, 0);
  assert.match(logs.join('\n'), /already claimed/);
  await assert.rejects(runWorker({ runId: '../x', canvasUrl: 'https://canvas.example', request: async () => ({}) }), /Invalid run ID/);
});

test('Chrome no-sandbox flags are opt-in only', () => {
  assert.deepEqual(isolatedVmChromeFlags({}), []);
  assert.deepEqual(isolatedVmChromeFlags({ ASTRAHACK_CHROME_NO_SANDBOX: '0' }), []);
  assert.ok(isolatedVmChromeFlags({ ASTRAHACK_CHROME_NO_SANDBOX: '1' }).includes('--no-sandbox'));
});
