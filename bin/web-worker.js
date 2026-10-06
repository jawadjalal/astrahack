#!/usr/bin/env node
import { runWorker, workerPreflight } from '../src/web-run-worker.js';
import { findChrome } from '../src/chrome-path.js';
import { createWorkerEnvReloader, waitForWorkerToken } from '../src/worker-env.js';

const reloadEnv = createWorkerEnvReloader();
const usage = 'Usage: node bin/web-worker.js [--once] [--run-id <id>] [--wait-for-token]\n--run-id claims only that queued run, then exits.\n--wait-for-token reloads .env until the shared worker token is configured.\nSet CANVAS_URL, ASTRAHACK_WORKER_TOKEN, ASTRAHACK_CHROME, and OPENAI_API_KEY in your environment or .env.';
const stop = new AbortController();
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  console.log('Stopping the worker and its current browser run.');
  stop.abort();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log(usage);
  else {
    let runId;
    const flags = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--run-id') runId = args[++i];
      else if (args[i].startsWith('--run-id=')) runId = args[i].slice('--run-id='.length);
      else flags.push(args[i]);
    }
    if (flags.some(arg => !['--once', '--wait-for-token'].includes(arg)) || (runId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(runId || ''))) throw new Error(usage);
    if (args.includes('--wait-for-token')) await waitForWorkerToken({ reload: reloadEnv, signal: stop.signal });
    else await reloadEnv();
    const options = {
      canvasUrl: process.env.CANVAS_URL || 'https://ignura.com/astrahack',
      token: process.env.ASTRAHACK_WORKER_TOKEN,
      chrome: process.env.ASTRAHACK_CHROME || findChrome() || undefined,
    };
    if (!stop.signal.aborted) {
      await workerPreflight(options);
      console.log('Worker ready. Waiting for website URLs.');
      await runWorker({ ...options, signal: stop.signal, once: args.includes('--once'), runId });
    }
  }
} catch (error) {
  // Errors emitted by this entry point and the worker client contain no provider response bodies.
  console.error(error.message);
  process.exitCode = 1;
} finally {
  process.off('SIGINT', shutdown);
  process.off('SIGTERM', shutdown);
}
