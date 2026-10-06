import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { planFleet, runFleet } from '../src/fleet.js';
import { findChrome } from '../src/chrome-path.js';

const page = (url, controls = []) => ({
  url, finalUrl: url, status: 'visited', screenshot: 'screenshots/page.png',
  observation: { url, title: url, headings: [{ level: 'h1', text: url }], controls, text: 'Example' }
});

test('fleet launches separate real browser sessions for discovered pages', {
  skip: !findChrome()
}, async () => {
  const output = await mkdtemp(join(tmpdir(), 'astrahack-fleet-browser-'));
  const chrome = findChrome();
  try {
    await writeFile(join(output, 'home.html'), '<title>Home</title><h1>Home</h1><a href="feature.html">Feature</a>');
    await writeFile(join(output, 'feature.html'), '<title>Feature</title><h1>Feature</h1>');
    let serial = 0;
    const request = async payload => payload.previous_response_id
      ? { id: `end-${++serial}`, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
        productUnderstanding: 'Fixture', observedFeatures: ['Page'], journeysExercised: ['View'], issues: [], limitations: []
      }) }] }] }
      : { id: `start-${++serial}`, status: 'completed', output: [{ type: 'computer_call', call_id: 'shot', actions: [{ type: 'screenshot' }] }] };
    const result = await runFleet({ url: pathToFileURL(join(output, 'home.html')).href,
      chrome, output: join(output, 'run'), maxPages: 2, maxAgents: 2, concurrency: 2,
      request });
    assert.equal(result.fleet.coverage.crawledPages, 2);
    assert.equal(result.fleet.coverage.completedAgents, 2);
    assert.equal(result.agent.steps.length, 2);
    assert.equal(result.agent.steps[0].workerId, 'A001');
    assert.equal(result.agent.steps[1].workerId, 'A002');
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('fleet assigns every page before duplicate missions', () => {
  const crawl = { pages: [page('https://site.test/'), page('https://site.test/a', [{ tag: 'button', label: 'Filter' }]), page('https://site.test/b')] };
  const plan = planFleet(crawl, 7);
  assert.equal(plan.jobs.length, 7);
  assert.deepEqual(plan.jobs.slice(0, 3).map(job => job.mission), ['journey', 'journey', 'journey']);
  assert.deepEqual(plan.jobs.slice(3, 6).map(job => job.mission), ['feature_map', 'feature_map', 'feature_map']);
  assert.equal(plan.jobs[6].mission, 'controls');
  assert.equal(new Set(plan.jobs.map(job => job.id)).size, 7);
  assert.deepEqual(planFleet(crawl, 2).unassigned, ['https://site.test/b']);
});

test('fleet runs isolated agents in parallel and merges numbered evidence', async () => {
  const output = await mkdtemp(join(tmpdir(), 'astrahack-fleet-test-'));
  let active = 0;
  let peak = 0;
  const crawl = async ({ output: out }) => {
    const report = { target: 'https://site.test/', product: { title: 'Site' },
      pages: [page('https://site.test/'), page('https://site.test/a'), page('https://site.test/b')], observations: [], findings: [] };
    await writeFile(join(out, 'crawl.json'), JSON.stringify(report));
    return { out, report };
  };
  const agent = async ({ url, output: workerOut }) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 30));
    active--;
    await mkdir(join(workerOut, 'screenshots'), { recursive: true });
    await writeFile(join(workerOut, 'screenshots/001.png'), 'image');
    const report = { status: 'completed', target: url, steps: [{ index: 1, type: 'screenshot', status: 'passed',
      screenshot: 'screenshots/001.png', observation: { url, title: url } }],
      assets: [{ type: 'screenshot', path: 'screenshots/001.png' }],
      assessment: { productUnderstanding: 'Site', observedFeatures: ['Feature'], journeysExercised: ['View'],
        issues: [{ summary: 'Issue', severity: 'low', expected: 'Expected', actual: 'Actual', reproduction: ['Open'], evidenceStep: 1, evidence: 'screenshots/001.png' }], limitations: [] },
      limitations: [] };
    await writeFile(join(workerOut, 'qa-agent.json'), JSON.stringify(report));
    return { out: workerOut, report };
  };
  try {
    const result = await runFleet({ url: 'https://site.test/', chrome: 'unused', output,
      maxAgents: 6, concurrency: 2, crawl, agent, request: async () => ({}) });
    assert.equal(peak, 2);
    assert.equal(result.fleet.coverage.totalAgents, 6);
    assert.equal(result.fleet.coverage.assignedPages, 3);
    assert.equal(result.fleet.coverage.completedAgents, 6);
    assert.equal(result.agent.steps.length, 6);
    assert.deepEqual(result.agent.steps.map(step => step.index), [1, 2, 3, 4, 5, 6]);
    assert.equal(result.agent.assessment.issues[5].evidenceStep, 6);
    assert.equal(result.fleet.observations.length, 6);
    assert.equal(JSON.parse(await readFile(join(output, 'fleet.json'), 'utf8')).status, 'completed');
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('fleet spawns another agent for a route discovered through computer-use observations', async () => {
  const output = await mkdtemp(join(tmpdir(), 'astrahack-fleet-discovery-'));
  const visited = [];
  const crawl = async ({ output: out }) => {
    const report = { target: 'https://site.test/', pages: [page('https://site.test/')], observations: [], findings: [] };
    await writeFile(join(out, 'crawl.json'), JSON.stringify(report));
    return { out, report };
  };
  const agent = async ({ url, output: workerOut }) => {
    visited.push(url);
    await mkdir(join(workerOut, 'screenshots'), { recursive: true });
    await writeFile(join(workerOut, 'screenshots/000-initial.png'), 'image');
    const report = { status: 'completed', target: url,
      initialObservation: { url, controls: url.endsWith('/') ? [{ href: 'https://site.test/hidden' }] : [] },
      steps: [], assets: [], assessment: { issues: [], observedFeatures: [], journeysExercised: [], limitations: [] }, limitations: [] };
    await writeFile(join(workerOut, 'qa-agent.json'), JSON.stringify(report));
    return { out: workerOut, report };
  };
  try {
    const result = await runFleet({ url: 'https://site.test/', chrome: 'unused', output,
      maxAgents: 2, concurrency: 2, crawl, agent, request: async () => ({}) });
    assert.deepEqual(visited, ['https://site.test/', 'https://site.test/hidden']);
    assert.deepEqual(result.fleet.discoveredByAgents, ['https://site.test/hidden']);
    assert.equal(result.fleet.coverage.assignedPages, 2);
  } finally { await rm(output, { recursive: true, force: true }); }
});
