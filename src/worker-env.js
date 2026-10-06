import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

/** Reload file-owned variables while preserving values supplied by the launching process. */
export function createWorkerEnvReloader({ env = process.env, path = '.env', read = readFile } = {}) {
  const inherited = new Set(Object.keys(env));
  let loaded = new Set();
  return async () => {
    let contents;
    try { contents = await read(path, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Could not read the local .env configuration.');
      contents = '';
    }
    let parsed;
    try { parsed = parseEnv(contents); }
    catch { throw new Error('Could not parse the local .env configuration.'); }
    for (const name of loaded) if (!inherited.has(name) && !Object.hasOwn(parsed, name)) delete env[name];
    for (const [name, value] of Object.entries(parsed)) if (!inherited.has(name)) env[name] = value;
    loaded = new Set(Object.keys(parsed));
  };
}

export async function waitForWorkerToken({ reload, env = process.env, signal, pollMs = 1000,
  log = console.log, sleep = delay } = {}) {
  let announced = false;
  while (!signal?.aborted) {
    await reload();
    if (signal?.aborted) return false;
    if (typeof env.ASTRAHACK_WORKER_TOKEN === 'string' && env.ASTRAHACK_WORKER_TOKEN.trim().length >= 24) return true;
    if (!announced) {
      log('Waiting for ASTRAHACK_WORKER_TOKEN in the local .env file. No runs will start until it is configured.');
      announced = true;
    }
    try { await sleep(pollMs, undefined, { signal }); }
    catch (error) { if (signal?.aborted) return false; throw error; }
  }
  return false;
}
