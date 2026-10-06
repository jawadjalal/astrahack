import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fork } from 'node:child_process';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const denied = new BlockList();
for (const [network, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) denied.addSubnet(network, bits, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
denied.addSubnet('2001::', 23, 'ipv6');
denied.addSubnet('2001:db8::', 32, 'ipv6');
denied.addSubnet('2002::', 16, 'ipv6');
denied.addSubnet('3fff::', 20, 'ipv6');

export function publicAddress(address) {
  if (isIP(address) === 4) return !denied.check(address, 'ipv4');
  if (isIP(address) === 6) return globalV6.check(address, 'ipv6') && !denied.check(address, 'ipv6');
  return false;
}

export async function validatePublicTarget(raw, { lookupImpl = lookup, timeoutMs = 10_000 } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('A valid public website URL is required.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) throw new Error('Use a public HTTP or HTTPS website URL without credentials or a custom port.');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal|test|invalid)$/.test(host)) throw new Error('Private and local website targets are not supported.');
  let addresses;
  if (isIP(host)) addresses = [{ address: host }];
  else {
    let timer;
    try {
      addresses = await Promise.race([
        lookupImpl(host, { all: true, verbatim: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Website DNS lookup timed out.')), timeoutMs); }),
      ]);
    } catch { throw new Error('The website could not be resolved to a public address.'); }
    finally { clearTimeout(timer); }
  }
  if (!addresses?.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error('Private and local website targets are not supported.');
  url.hash = '';
  return url.href;
}

export async function workerPreflight({ canvasUrl, token, chrome, apiKey = process.env.OPENAI_API_KEY }) {
  if (!token || token.length < 24) throw new Error('Set ASTRAHACK_WORKER_TOKEN to the same secret as the deployed canvas (at least 24 characters).');
  if (!apiKey?.trim()) throw new Error('OPENAI_API_KEY is required before starting the worker.');
  if (!chrome) throw new Error('Set ASTRAHACK_CHROME to the Chrome executable on this machine.');
  await access(chrome, constants.X_OK).catch(() => { throw new Error('ASTRAHACK_CHROME must point to an executable Chrome installation.'); });
  let url;
  try { url = new URL(canvasUrl); } catch { throw new Error('Set CANVAS_URL to the deployed canvas base URL.'); }
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('CANVAS_URL must be a plain HTTP(S) base URL.');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use HTTPS for a remote CANVAS_URL.');
}

export function createRunClient({ canvasUrl, token, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const base = canvasUrl.replace(/\/+$/, '');
  return async (path, { method = 'GET', body, signal } = {}) => {
    let response;
    try {
      response = await fetchImpl(`${base}/api/runs${path}`, {
        method, redirect: 'error',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...[signal].filter(Boolean)]),
      });
    } catch {
      throw new Error('The run service could not be reached within the request limit.');
    }
    if (!response.ok) {
      const error = new Error(`The run service returned HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    try { return await response.json(); }
    catch { throw new Error('The run service returned an invalid response.'); }
  };
}

/** Child process group includes its Chrome processes; never pass submitted input through a shell. */
export function executePipelineProcess(job, { signal, onProgress, ...options }) {
  return new Promise((accept, reject) => {
    if (signal?.aborted) { reject(new Error('Run interrupted.')); return; }
    const child = fork(join(root, 'src/web-run-pipeline.js'), [], {
      cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let result;
    let killTimer;
    const killGroup = how => {
      try { if (process.platform === 'win32') child.kill(how); else process.kill(-child.pid, how); } catch { /* already exited */ }
    };
    const stop = () => {
      killGroup('SIGTERM');
      killTimer ||= setTimeout(() => killGroup('SIGKILL'), 5_000);
    };
    const deadline = setTimeout(stop, 20 * 60_000);
    const cleanup = () => { clearTimeout(deadline); clearTimeout(killTimer); signal?.removeEventListener('abort', stop); killGroup('SIGKILL'); };
    signal?.addEventListener('abort', stop, { once: true });
    child.on('message', message => {
      if (message?.type === 'progress') onProgress?.(message.event);
      if (message?.type === 'result') result = message.result;
    });
    child.once('error', () => { cleanup(); reject(new Error('The pipeline process could not start.')); });
    child.once('exit', () => {
      cleanup();
      if (result) accept(result);
      else reject(new Error('The pipeline process stopped before completion.'));
    });
    child.send({ job: { id: job.id, url: job.url }, options });
  });
}

export async function runWorker({ canvasUrl, token, chrome, signal, outputRoot = join(root, 'runs'),
  workerId = `${hostname().replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 30)}-${randomUUID()}`,
  pollMs = 3_000, heartbeatMs = 15_000, once = false, log = console.log,
  request = createRunClient({ canvasUrl, token }), pipeline = executePipelineProcess,
  validateTarget = validatePublicTarget, sleep = delay } = {}) {
  const attempts = new Set();
  let processed = 0;
  while (!signal?.aborted) {
    let queued;
    try { queued = await request('', { signal }); }
    catch (error) {
      if (signal?.aborted) break;
      if ([401, 403].includes(error.status)) throw new Error('Worker authentication was rejected; check ASTRAHACK_WORKER_TOKEN.');
      log('Run service unavailable; waiting before the next poll.');
      if (once) throw error;
      await sleep(pollMs, undefined, { signal }).catch(() => {});
      continue;
    }
    for (const queuedRun of queued.runs || []) {
      if (signal?.aborted) break;
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(queuedRun.id || '') || attempts.has(queuedRun.id)) continue;
      let job;
      try { ({ run: job } = await request(`/${encodeURIComponent(queuedRun.id)}/claim`, { method: 'POST', body: { workerId }, signal })); }
      catch (error) {
        if (error.status === 409) continue;
        // A lost claim response is uncertain: do not try to claim or execute it again in this process.
        attempts.add(queuedRun.id);
        log('A run claim could not be confirmed; it will not be executed automatically.');
        continue;
      }
      if (!job || job.id !== queuedRun.id) { attempts.add(queuedRun.id); log('Invalid claim response; no work was started.'); continue; }
      attempts.add(job.id);
      let current = { stage: 'starting', message: 'The worker is preparing the run.' };
      let updates = Promise.resolve();
      let updateFailed = false;
      const update = (fields, terminal = false) => {
        const task = updates.then(async () => {
          // Terminal writes are idempotent. Retrying their delivery never repeats the pipeline.
          for (let attempt = 0; ; attempt++) {
            try {
              return await request(`/${encodeURIComponent(job.id)}`, {
                method: 'PATCH', body: { workerId, status: 'running', ...fields }, ...(terminal ? {} : { signal }),
              });
            } catch (error) {
              if (!terminal || attempt >= 2 || [401, 403, 409].includes(error.status)) throw error;
            }
          }
        });
        updates = task.catch(() => { if (!updateFailed) log('A progress update could not be saved.'); updateFailed = true; });
        return terminal ? task : updates;
      };
      const heartbeat = setInterval(() => { if (!signal?.aborted) void update(current); }, heartbeatMs);
      let result;
      try {
        if (signal?.aborted) throw new Error('Run interrupted.');
        job = { id: job.id, url: await validateTarget(job.url) };
        const directory = join(resolve(outputRoot), `web-${job.id}`);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'worker-attempt.json'), JSON.stringify({ id: job.id, workerId, startedAt: new Date().toISOString() }) + '\n', { flag: 'wx' });
        await update(current);
        result = await pipeline(job, { canvasUrl, chrome, outputRoot: resolve(outputRoot), signal,
          onProgress: event => {
            current = { stage: String(event.stage || 'running').slice(0, 64), message: String(event.message || 'Run in progress.').slice(0, 500) };
            return update(current);
          },
        });
        if (!['completed', 'partial', 'failed'].includes(result?.status)) throw new Error('Invalid pipeline result.');
      } catch (error) {
        result = { status: 'failed', stage: 'finished', message: signal?.aborted ? 'Run interrupted. It will not restart automatically.'
          : error.code === 'EEXIST' ? 'This run has a previous worker attempt. It will not restart automatically.'
            : 'The worker could not complete this run. Check the worker setup and submitted public URL.' };
      } finally { clearInterval(heartbeat); }
      await update({ status: result.status, stage: result.stage || 'finished', message: result.message }, true)
        .catch(() => log('The final run status could not be saved. The pipeline will not be repeated; check the service connection.'));
      log(`Run ${job.id}: ${result.status}.`);
      processed++;
      if (once || signal?.aborted) break;
    }
    if (once || signal?.aborted) break;
    await sleep(pollMs, undefined, { signal }).catch(() => {});
  }
  return { processed };
}
