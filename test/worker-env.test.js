import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerEnvReloader, waitForWorkerToken } from '../src/worker-env.js';
import { runWorker } from '../src/web-run-worker.js';

test('waiting reloads an initially blank token while preserving inherited configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-env-'));
  const path = join(directory, '.env');
  const env = { OPENAI_API_KEY: 'inherited-fixture-key', CANVAS_URL: 'https://inherited.example' };
  const token = 'worker-fixture-token-long-enough';
  const logs = [];
  let polls = 0;
  try {
    await writeFile(path, 'ASTRAHACK_WORKER_TOKEN=\nOPENAI_API_KEY=file-key\nCANVAS_URL=https://file.example\n');
    const reload = createWorkerEnvReloader({ env, path });
    const ready = await waitForWorkerToken({ env, reload, log: text => logs.push(text), sleep: async () => {
      polls++;
      await writeFile(path, `ASTRAHACK_WORKER_TOKEN=${token}\nOPENAI_API_KEY=replacement-key\nCANVAS_URL=https://file.example\n`);
    } });
    assert.equal(ready, true);
    assert.equal(polls, 1);
    assert.equal(env.ASTRAHACK_WORKER_TOKEN, token);
    assert.equal(env.OPENAI_API_KEY, 'inherited-fixture-key');
    assert.equal(env.CANVAS_URL, 'https://inherited.example');
    assert.equal(logs.length, 1);
    assert.ok(!logs.join('').includes(token));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing file waits, short tokens wait, and cancellation exits without starting work', async () => {
  const stop = new AbortController();
  const env = {};
  let reads = 0;
  const reload = createWorkerEnvReloader({ env, read: async () => {
    reads++;
    if (reads === 1) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return 'ASTRAHACK_WORKER_TOKEN=too-short';
  } });
  let sleeps = 0;
  const ready = await waitForWorkerToken({ env, reload, signal: stop.signal, log: () => {}, sleep: async () => {
    if (++sleeps === 2) stop.abort();
  } });
  assert.equal(ready, false);
  assert.equal(reads, 2);
});

test('a valid inherited token proceeds immediately and file errors never expose contents', async () => {
  const env = { ASTRAHACK_WORKER_TOKEN: 'inherited-worker-token-long-enough' };
  const reload = createWorkerEnvReloader({ env, read: async () => 'ASTRAHACK_WORKER_TOKEN=file-value' });
  assert.equal(await waitForWorkerToken({ env, reload, sleep: () => assert.fail('must not wait'), log: () => assert.fail('must not log') }), true);
  assert.equal(env.ASTRAHACK_WORKER_TOKEN, 'inherited-worker-token-long-enough');
  const broken = createWorkerEnvReloader({ env: {}, read: async () => { throw new Error('credential-not-for-logs'); } });
  await assert.rejects(broken(), error => !error.message.includes('credential-not-for-logs'));
});

test('a rejected configured token stops before any pipeline call or retry', async () => {
  let polls = 0;
  await assert.rejects(runWorker({ request: async () => {
    polls++;
    throw Object.assign(new Error('sensitive-provider-content'), { status: 401 });
  }, pipeline: () => assert.fail('must not start paid work'), log: () => {} }), error => {
    assert.match(error.message, /authentication was rejected/);
    return !error.message.includes('sensitive-provider-content');
  });
  assert.equal(polls, 1);
});
