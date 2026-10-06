#!/usr/bin/env node
import { runWorker, workerPreflight } from '../src/web-run-worker.js';
import { findChrome } from '../src/chrome-path.js';

try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }

const usage = 'Usage: node bin/web-worker.js [--once] [--run-id <id>]\n--run-id claims only that queued run, then exits (used by the cloud dispatcher).\nSet CANVAS_URL, ASTRAHACK_WORKER_TOKEN, ASTRAHACK_CHROME, and OPENAI_API_KEY in your environment or .env.';
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
    if (flags.some(arg => arg !== '--once') || (runId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(runId || ''))) throw new Error(usage);
    const options = {
      canvasUrl: process.env.CANVAS_URL || 'https://ignura.com/astrahack',
      token: process.env.ASTRAHACK_WORKER_TOKEN,
      chrome: process.env.ASTRAHACK_CHROME || findChrome() || undefined,
    };
    await workerPreflight(options);
    console.log('Worker ready. Waiting for website URLs.');
    await runWorker({ ...options, signal: stop.signal, once: args.includes('--once'), runId });
  }
} catch (error) {
  // Errors emitted by this entry point and the worker client contain no provider response bodies.
  console.error(error.message);
  process.exitCode = 1;
} finally {
  process.off('SIGINT', shutdown);
  process.off('SIGTERM', shutdown);
}
