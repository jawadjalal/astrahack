import { access, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFleet } from './fleet.js';
import { analyzeQa } from './qa-analysis.js';
import { captureMajorFeatures } from './feature-capture.js';
import { publishFeatureCaptures } from './feature-canvas.js';
import { createResponse } from './openai.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exists = async path => { try { await access(path); return true; } catch { return false; } };

export function boundedFetch(signal, timeoutMs = 120_000, fetchImpl = fetch) {
  return (url, init = {}) => fetchImpl(url, {
    ...init,
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...[signal, init.signal].filter(Boolean)]),
  });
}

/** The importer gets only fixed arguments and a validated run ID; no shell is involved. */
export function pushRun(output, { canvasUrl, runId, signal } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [join(root, 'canvas/scripts/push-run.mjs'), output,
      '--canvas', canvasUrl, '--run-id', runId], { cwd: root, stdio: 'ignore', signal });
    const timer = setTimeout(() => child.kill('SIGTERM'), 180_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) accept();
      else reject(new Error('Evidence publishing did not finish.'));
    });
  });
}

/** Run the existing modules once. Failed stages do not discard evidence from earlier stages. */
export async function runWebPipeline(job, options = {}) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(job?.id || '')) throw new Error('Invalid run ID.');
  const { canvasUrl, chrome, signal, onProgress = async () => {}, outputRoot = join(root, 'runs'),
    fleet = runFleet, analyze = analyzeQa, capture = captureMajorFeatures,
    publish = pushRun, publishFeatures = publishFeatureCaptures,
    fileExists = exists } = options;
  const output = join(resolve(outputRoot), `web-${job.id}`);
  await mkdir(output, { recursive: true });
  const failures = [];
  let incomplete = false;
  let fleetResult;
  let captureResult;
  let published = false;
  const progress = async (stage, message) => onProgress({ stage, message });
  const stage = async (name, message, work) => {
    if (signal?.aborted) return;
    await progress(name, message);
    try { return await work(); }
    catch {
      // Provider messages may contain request content or credentials; publish only our own text.
      failures.push(name);
      await progress(name, `${message.replace(/\.$/, '')} did not finish; continuing with available evidence.`);
    }
  };
  fleetResult = await stage('exploring', 'Exploring the website and recording evidence.', () => fleet({
    url: job.url, chrome, output, headless: true,
    signal,
    onProgress: event => progress('exploring', event.phase === 'crawl' ? 'Mapping website pages.' : 'Testing observed website journeys.'),
  }));
  if (fleetResult && fleetResult.fleet?.status !== 'completed') incomplete = true;
  const hasEvidence = await fileExists(join(output, 'crawl.json')) || await fileExists(join(output, 'qa-agent.json'));
  if (hasEvidence && !signal?.aborted) {
    await stage('analyzing', 'Analyzing recorded QA evidence.', () => analyze(output, {
      request: (payload, requestOptions = {}) => createResponse(payload, { ...requestOptions, signal }),
    }));
    const captureReport = await fileExists(join(output, 'fleet.json')) ? 'fleet.json'
      : await fileExists(join(output, 'qa-agent.json')) ? 'qa-agent.json' : 'crawl.json';
    captureResult = await stage('capturing', 'Selecting screenshots of observed features.', () => capture(join(output, captureReport), {
      fetchImpl: boundedFetch(signal),
    }));
    if (captureResult?.manifest?.gaps?.length) incomplete = true;
    const result = await stage('publishing', 'Publishing QA evidence to the canvas.', async () => {
      await publish(output, { canvasUrl, runId: job.id, signal });
      return true;
    });
    published ||= Boolean(result);
    const manifestPath = join(captureResult?.outputDir || join(output, 'feature-captures'), 'manifest.json');
    if (await fileExists(manifestPath)) {
      const features = await stage('publishing_features', 'Publishing selected feature screenshots.', () => publishFeatures(manifestPath, {
        canvasUrl, fetchImpl: boundedFetch(signal, 30_000),
      }));
      published ||= Boolean(features);
    }
  }
  const status = !hasEvidence ? 'failed' : signal?.aborted || failures.length || incomplete || !published ? 'partial' : 'completed';
  const message = signal?.aborted ? 'Run interrupted. Available local evidence has been retained.'
    : !hasEvidence ? 'Exploration produced no usable evidence.'
      : !published ? 'Evidence was saved locally, but publishing to the canvas did not finish.'
        : status === 'partial' ? `Available evidence is on the canvas. ${failures.length ? `Incomplete stages: ${failures.join(', ')}.` : 'Coverage limits or screenshot gaps remain.'}`
          : 'QA evidence and selected screenshots are on the canvas.';
  return { status, stage: 'finished', message, output, failures };
}

// The worker supervises this process, including Chrome descendants, so shutdown is bounded.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.send) {
  const stop = new AbortController();
  process.on('SIGTERM', () => stop.abort());
  process.on('SIGINT', () => stop.abort());
  process.once('message', async ({ job, options }) => {
    try {
      const result = await runWebPipeline(job, { ...options, signal: stop.signal,
        onProgress: event => { if (process.connected) process.send({ type: 'progress', event }); },
      });
      if (process.connected) process.send({ type: 'result', result }, () => process.disconnect());
    } catch {
      if (process.connected) process.send({ type: 'result', result: { status: 'failed', stage: 'finished', message: 'The worker could not finish this run.' } }, () => process.disconnect());
    }
  });
}
