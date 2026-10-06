#!/usr/bin/env node
import { runWorker, workerPreflight } from '../src/web-run-worker.js';

try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }

const usage = 'Usage: node bin/web-worker.js [--once]\nSet CANVAS_URL, ASTRAHACK_WORKER_TOKEN, ASTRAHACK_CHROME, and OPENAI_API_KEY in your environment or .env.';
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
    if (args.some(arg => arg !== '--once')) throw new Error(usage);
    const options = {
      canvasUrl: process.env.CANVAS_URL || 'https://ignura.com/astrahack',
      token: process.env.ASTRAHACK_WORKER_TOKEN,
      chrome: process.env.ASTRAHACK_CHROME,
    };
    await workerPreflight(options);
    console.log('Worker ready. Waiting for website URLs.');
    await runWorker({ ...options, signal: stop.signal, once: args.includes('--once') });
  }
} catch (error) {
  // Errors emitted by this entry point and the worker client contain no provider response bodies.
  console.error(error.message);
  process.exitCode = 1;
} finally {
  process.off('SIGINT', shutdown);
  process.off('SIGTERM', shutdown);
}
