// Run from canvas/: node --import tsx --test test/runs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRunUrl } from '../src/lib/runs.ts';
import { createRunStore, createMemoryRunBackend, createBlobRunBackend } from '../src/server/runStore.ts';
import { POST as createRun, GET as queue } from '../src/app/api/runs/route.ts';
import { GET as status, PATCH as progress } from '../src/app/api/runs/[id]/route.ts';
import { POST as claim } from '../src/app/api/runs/[id]/claim/route.ts';

test('normalizes public URLs and rejects credentials, unsupported schemes and private literal hosts', () => {
  assert.equal(normalizeRunUrl(' example.com/app?mode=demo#home '), 'https://example.com/app?mode=demo#home');
  assert.equal(normalizeRunUrl('http://8.8.8.8'), 'http://8.8.8.8/');
  assert.equal(normalizeRunUrl('https://[2606:4700:4700::1111]'), 'https://[2606:4700:4700::1111]/');
  for (const value of ['', 'not a website', 'ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)',
    'https://user:pass@example.com', 'http://localhost', 'http://app.local', 'http://app.internal',
    'http://127.0.0.1', 'http://127.1', 'http://2130706433', 'http://0x7f000001',
    'http://10.0.0.1', 'http://172.16.2.1', 'http://192.168.0.1', 'http://169.254.169.254',
    'http://100.64.0.1', 'http://0.0.0.0', 'http://224.0.0.1', 'http://[::1]',
    'http://[::ffff:127.0.0.1]', 'http://[fc00::1]', 'http://[fe80::1]', 'http://[2001:db8::1]',
    'http://[2002:7f00:1::]', 'https://example.com:3000', 'https://example.com\\@localhost']) {
    assert.throws(() => normalizeRunUrl(value), undefined, value);
  }
});

test('only a claiming worker can progress a run, terminal status is stable and public shape omits ownership', async () => {
  let time = Date.parse('2026-10-06T12:00:00.000Z');
  const store = createRunStore(createMemoryRunBackend(), () => time);
  const run = await store.create('example.com', 'client');
  assert.equal(run.status, 'queued');
  assert.equal(run.url, 'https://example.com/');
  assert.deepEqual(await store.queued(), [run]);
  await assert.rejects(store.update(run.id, { workerId: 'A', status: 'completed' }), { status: 409 });
  time += 1000;
  const running = await store.claim(run.id, 'A');
  assert.equal(running.startedAt, new Date(time).toISOString());
  assert.equal('workerId' in running, false);
  assert.equal('clientHash' in running, false);
  assert.deepEqual(await store.queued(), []);
  await assert.rejects(store.claim(run.id, 'A'), { status: 409 });
  await assert.rejects(store.update(run.id, { workerId: 'B', status: 'failed' }), { status: 409 });
  time += 1000;
  const exploring = await store.update(run.id, { workerId: 'A', stage: 'exploring', message: 'Testing navigation.' });
  assert.equal(exploring.status, 'running');
  assert.equal(exploring.updatedAt, new Date(time).toISOString());
  time += 1000;
  const complete = await store.update(run.id, { workerId: 'A', status: 'completed', stage: 'done', message: 'Results are ready.' });
  assert.equal(complete.finishedAt, new Date(time).toISOString());
  assert.deepEqual(await store.get(run.id), complete);
  time += 1000;
  assert.deepEqual(await store.update(run.id, { workerId: 'A', status: 'completed' }), complete);
  await assert.rejects(store.update(run.id, { workerId: 'A', status: 'running' }), { status: 409 });
  await assert.rejects(store.update(run.id, { workerId: 'A', status: 'queued' }), { status: 400 });
  assert.equal(await store.get('missing'), null);
});

test('two store instances cannot both claim the same paid exploration', async () => {
  const backend = createMemoryRunBackend();
  const first = createRunStore(backend);
  const second = createRunStore(backend);
  const run = await first.create('example.com', 'client');
  const results = await Promise.allSettled([first.claim(run.id, 'worker1'), second.claim(run.id, 'worker2')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.status, 409);
  assert.equal((await second.get(run.id)).status, 'running');
});

test('concurrent creates preserve both requests and admission limits span store instances', async () => {
  const backend = createMemoryRunBackend();
  const first = createRunStore(backend);
  const second = createRunStore(backend);
  await Promise.all([first.create('one.example.com', 'client'), second.create('two.example.com', 'client')]);
  assert.equal((await first.queued()).length, 2);
  for (let i = 0; i < 3; i++) await first.create(`app${i}.example.com`, 'client');
  await assert.rejects(second.create('example.com', 'client'), { status: 429, code: 'rate_limited' });
  for (let i = 0; i < 15; i++) await second.create('example.com', `client${i}`);
  await assert.rejects(first.create('example.com', 'fresh-client'), { status: 429, code: 'queue_full' });
});

function fakeBlobIO() {
  const objects = new Map();
  const calls = [];
  return {
    objects, calls,
    async list({ prefix }) {
      return { blobs: [...objects.keys()].filter(key => key.startsWith(prefix)).map(pathname => ({ pathname, url: pathname })), hasMore: false };
    },
    async get(pathname, options) {
      calls.push({ method: 'get', pathname, options });
      const blob = objects.get(pathname);
      return blob ? { statusCode: 200, stream: new Response(blob.body).body, blob: { etag: blob.etag, size: blob.body.length } } : null;
    },
    async put(pathname, body, options) {
      calls.push({ method: 'put', pathname, options });
      const existing = objects.get(pathname);
      if (existing && (!options.allowOverwrite || (options.ifMatch && options.ifMatch !== existing.etag))) throw new Error('Blob already exists / precondition failed');
      objects.set(pathname, { body, etag: `etag-${calls.length}` });
      return {};
    },
  };
}

test('public Blob uses immutable revisions: fresh progress is readable and racing claims cannot both win', async () => {
  const io = fakeBlobIO();
  const settings = { token: 'fake-token', access: 'public', pathname: 'queue.json', prefix: 'snapshots/' };
  const a = createRunStore(createBlobRunBackend(settings, io));
  const b = createRunStore(createBlobRunBackend(settings, io));
  const run = await a.create('example.com', 'client');
  const races = await Promise.allSettled([a.claim(run.id, 'A'), b.claim(run.id, 'B')]);
  assert.equal(races.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(races.find(result => result.status === 'rejected').reason.status, 409);
  const winner = races[0].status === 'fulfilled' ? 'A' : 'B';
  await b.update(run.id, { workerId: winner, status: 'partial', stage: 'done', message: 'Some results available.' });
  assert.equal((await a.get(run.id)).status, 'partial');
  assert.equal(io.objects.size, 3);
  for (const call of io.calls.filter(call => call.method === 'put')) {
    assert.equal(call.options.allowOverwrite, false);
    assert.equal(call.options.addRandomSuffix, false);
    assert.match(call.pathname, /^snapshots\/\d{16}\.json$/);
  }
});

test('private Blob requests origin reads and uses ETags for updates', async () => {
  const io = fakeBlobIO();
  const backend = createBlobRunBackend({ token: 'fake-token', access: 'private', pathname: 'queue.json', prefix: 'snapshots/' }, io);
  const store = createRunStore(backend);
  const run = await store.create('example.com', 'client');
  await store.claim(run.id, 'A');
  for (const call of io.calls.filter(call => call.method === 'get')) assert.equal(call.options.useCache, false);
  const writes = io.calls.filter(call => call.method === 'put');
  assert.equal(writes[0].options.allowOverwrite, false);
  assert.equal(writes[1].options.allowOverwrite, true);
  assert.match(writes[1].options.ifMatch, /^etag-/);
});

test('HTTP API requires worker configuration/auth, bounds bodies, and follows create/claim/progress contract', async () => {
  const oldToken = process.env.ASTRAHACK_WORKER_TOKEN;
  const oldBackend = process.env.CANVAS_STORE;
  delete process.env.CANVAS_STORE;
  const request = (body, token, method = 'POST') => new Request('http://localhost/astrahack/api/runs', {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    delete process.env.ASTRAHACK_WORKER_TOKEN;
    assert.equal((await createRun(request({ url: 'example.com' }))).status, 503);
    process.env.ASTRAHACK_WORKER_TOKEN = 'test-worker-secret';
    assert.equal((await queue(request(undefined, undefined, 'GET'))).status, 401);
    assert.equal((await createRun(request({ url: 'localhost' }))).status, 400);
    assert.equal((await createRun(request({ url: 'example.com', extra: 'field' }))).status, 400);
    assert.equal((await createRun(request({ url: 'a'.repeat(5000) }))).status, 413);
    const response = await createRun(request({ url: 'example.com' }));
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { run } = await response.json();
    const context = { params: Promise.resolve({ id: run.id }) };
    assert.equal((await status(request(undefined, undefined, 'GET'), context)).status, 200);
    assert.equal((await claim(request({ workerId: 'api-worker' }, 'wrong'), context)).status, 401);
    assert.equal((await claim(request({ workerId: 'api-worker' }, 'test-worker-secret'), context)).status, 200);
    assert.equal((await claim(request({ workerId: 'api-worker' }, 'test-worker-secret'), context)).status, 409);
    const done = await progress(request({ workerId: 'api-worker', status: 'completed', stage: 'done', message: 'Ready.' }, 'test-worker-secret', 'PATCH'), context);
    assert.equal(done.status, 200);
    const result = await done.json();
    assert.equal(result.run.status, 'completed');
    assert.equal('workerId' in result.run, false);
    assert.equal(JSON.stringify(result).includes('test-worker-secret'), false);
    assert.equal((await status(request(undefined, undefined, 'GET'), { params: Promise.resolve({ id: 'invalid-id' }) })).status, 404);
  } finally {
    if (oldToken === undefined) delete process.env.ASTRAHACK_WORKER_TOKEN; else process.env.ASTRAHACK_WORKER_TOKEN = oldToken;
    if (oldBackend === undefined) delete process.env.CANVAS_STORE; else process.env.CANVAS_STORE = oldBackend;
  }
});
