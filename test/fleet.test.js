import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { combineAgentReports, defaultFleetConcurrency, planFleet, runFleet } from '../src/fleet.js';
import { findChromeForTests } from '../src/chrome-path.js';

const page = (url, controls = []) => ({
  url, finalUrl: url, status: 'visited', screenshot: 'screenshots/page.png',
  observation: { url, title: url, headings: [{ level: 'h1', text: url }], controls, text: 'Example' }
});

const completed = (url, controls = []) => ({ report: {
  status: 'completed', target: url, initialObservation: { url, controls }, steps: [], assets: [],
  assessment: { issues: [], observedFeatures: [], journeysExercised: [], limitations: [] }, limitations: []
} });

async function mockFleet(options) {
  const output = await mkdtemp(join(tmpdir(), 'astrahack-fleet-mock-'));
  try {
    return await runFleet({ url: 'https://site.test/', chrome: 'unused', output,
      crawl: async () => ({ report: { target: 'https://site.test/', pages: [page('https://site.test/')], observations: [] } }),
      agent: async ({ url }) => completed(url), request: async () => ({}), ...options });
  } finally { await rm(output, { recursive: true, force: true }); }
}

test('default parallelism scales with available memory, CPUs, and planned work', () => {
  const GiB = 1024 ** 3;
  assert.equal(defaultFleetConcurrency(40, { freeMemoryBytes: 128 * GiB, cpuCount: 64 }), 16);
  assert.equal(defaultFleetConcurrency(40, { freeMemoryBytes: 3 * GiB, cpuCount: 64 }), 4);
  assert.equal(defaultFleetConcurrency(40, { freeMemoryBytes: 128 * GiB, cpuCount: 8 }), 4);
  assert.equal(defaultFleetConcurrency(5, { freeMemoryBytes: 128 * GiB, cpuCount: 64 }), 5);
  assert.equal(defaultFleetConcurrency(40, { freeMemoryBytes: 100 * 1024 ** 2, cpuCount: 2 }), 3);
  assert.equal(defaultFleetConcurrency(0, { freeMemoryBytes: 0, cpuCount: 1 }), 3);
});

test('fleet launches separate real browser sessions for discovered pages', {
  skip: !findChromeForTests()
}, async () => {
  const output = await mkdtemp(join(tmpdir(), 'astrahack-fleet-browser-'));
  const chrome = findChromeForTests();
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
      chrome, output: join(output, 'run'), maxPages: 2, concurrency: 3,
      request });
    assert.equal(result.fleet.coverage.crawledPages, 2);
    assert.equal(result.fleet.coverage.completedAgents, 4);
    assert.equal(result.agent.steps.length, 4);
    assert.equal(result.agent.steps[0].workerId, 'A001');
    assert.equal(result.agent.steps[1].workerId, 'A002');
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('fleet starts distinct scouts and allocates additional missions to observed work', () => {
  const crawl = { pages: [page('https://site.test/'), page('https://site.test/a', [{ tag: 'button', label: 'Filter' }]), page('https://site.test/b')] };
  const plan = planFleet(crawl);
  assert.equal(plan.jobs.length, 5);
  assert.deepEqual(plan.jobs.slice(0, 3).map(job => job.mission), ['journey', 'feature_map', 'controls']);
  assert.equal(plan.jobs[2].url, 'https://site.test/a');
  assert.equal(plan.jobs.filter(job => job.mission === 'feature_map').length, 1);
  assert.equal(plan.jobs.filter(job => job.mission === 'journey').length, 3);
  assert.equal(new Set(plan.jobs.map(job => job.id)).size, 5);
  assert.deepEqual(planFleet(crawl, 3).unassigned, ['https://site.test/a', 'https://site.test/b']);
  assert.throws(() => planFleet(crawl, 2), /at least 3/);
});

test('one-page sites get three useful scouts without fabricated control work', () => {
  const plan = planFleet({ pages: [page('https://site.test/', [{ tag: 'a', href: 'https://site.test/' }])] });
  assert.deepEqual(plan.jobs.map(job => job.mission), ['journey', 'feature_map', 'navigation']);
  const controlled = planFleet({ pages: [page('https://site.test/', [{ tag: 'input', type: 'search' }])] });
  assert.deepEqual(controlled.jobs.map(job => job.mission), ['journey', 'feature_map', 'controls']);
});

test('adaptive plans preserve all 500 pages beyond the former 300-agent truncation', () => {
  const pages = Array.from({ length: 500 }, (_, index) => page(`https://site.test/${index}`));
  const plan = planFleet({ pages });
  assert.equal(plan.jobs.length, 502);
  assert.equal(new Set(plan.jobs.filter(job => job.mission === 'journey').map(job => job.url)).size, 500);
  assert.deepEqual(plan.unassigned, []);
  assert.equal(planFleet({ pages }, 700).jobs.length, 502);
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
      concurrency: 2, crawl, agent, request: async () => ({}) });
    assert.equal(peak, 2);
    assert.equal(result.fleet.coverage.totalAgents, 5);
    assert.equal(result.fleet.coverage.assignedPages, 3);
    assert.equal(result.fleet.coverage.completedAgents, 5);
    assert.equal(result.agent.steps.length, 5);
    assert.deepEqual(result.agent.steps.map(step => step.index), [1, 2, 3, 4, 5]);
    assert.equal(result.agent.assessment.issues[4].evidenceStep, 5);
    assert.equal(result.fleet.observations.length, 5);
    assert.equal(result.fleet.model, 'gpt-6-luna');
    assert.equal(result.agent.model, 'gpt-6-luna');
    assert.equal(result.fleet.limits.maxAgents, null);
    assert.ok(result.fleet.limits.maxRequests == null);
    assert.equal(result.fleet.limits.maxDurationMs, 900000);
    assert.equal(result.fleet.limits.maxOutputTokens, 8192);
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
      concurrency: 3, crawl, agent, request: async () => ({}) });
    assert.deepEqual(visited, ['https://site.test/', 'https://site.test/', 'https://site.test/', 'https://site.test/hidden']);
    assert.deepEqual(result.fleet.discoveredByAgents, ['https://site.test/hidden']);
    assert.equal(result.fleet.coverage.assignedPages, 2);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('all mission types can discover routes and newly observed controls receive their own worker', async () => {
  const assignments = [];
  const result = await mockFleet({ concurrency: 3,
    crawl: async () => ({ report: { target: 'https://site.test/', observations: [], pages: [
      page('https://site.test/', [{ tag: 'button', label: 'Menu' }])
    ] } }),
    agent: async ({ url, brief }) => {
      const mission = /Mission: ([a-z_]+)/.exec(brief)[1];
      assignments.push(`${mission}:${url}`);
      const controls = [];
      if (url === 'https://site.test/' && mission === 'feature_map') controls.push({ href: 'https://site.test/features' });
      if (url === 'https://site.test/' && mission === 'controls') controls.push({ href: 'https://site.test/search' });
      if (url === 'https://site.test/search') controls.push({ tag: 'input', type: 'search' });
      return completed(url, controls);
    }
  });
  assert.deepEqual(assignments.slice(0, 3), [
    'journey:https://site.test/', 'feature_map:https://site.test/', 'controls:https://site.test/'
  ]);
  assert.ok(assignments.includes('journey:https://site.test/features'));
  assert.ok(assignments.includes('journey:https://site.test/search'));
  assert.equal(assignments.filter(value => value === 'controls:https://site.test/search').length, 1);
  assert.equal(result.fleet.status, 'completed');
  assert.deepEqual(result.fleet.unassigned, []);
  assert.deepEqual(result.fleet.unscheduledMissions, []);
});

test('explicit parallelism supports 16 simultaneous agents without a fixed call or agent cap', async () => {
  const urls = Array.from({ length: 65 }, (_, index) => `https://site.test/${index}`);
  const visited = new Set();
  let active = 0;
  let peak = 0;
  const result = await mockFleet({
    concurrency: 16,
    crawl: async () => ({ report: { target: 'https://site.test/', pages: urls.map(url => page(url)), observations: [] } }),
    agent: async ({ url, runtime, model }) => {
      visited.add(url);
      active++;
      peak = Math.max(peak, active);
      await runtime.request({ model });
      await new Promise(resolve => setTimeout(resolve, 3));
      active--;
      return completed(url);
    }
  });
  assert.equal(visited.size, 65);
  assert.equal(result.fleet.coverage.totalAgents, 67);
  assert.equal(result.fleet.usage.requests, 67);
  assert.ok(result.fleet.limits.maxRequests == null);
  assert.equal(result.fleet.limits.concurrency, 16);
  assert.equal(peak, 16);
  assert.equal(result.fleet.status, 'completed');
});

test('a small site defaults to three simultaneous useful scouts', async () => {
  let active = 0;
  let peak = 0;
  const result = await mockFleet({ agent: async ({ url }) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 3));
    active--;
    return completed(url);
  } });
  assert.equal(result.fleet.limits.concurrency, 3);
  assert.equal(result.fleet.coverage.totalAgents, 3);
  assert.equal(peak, 3);
});

test('an explicit agent ceiling reports every remaining route and incomplete coverage', async () => {
  const result = await mockFleet({ maxAgents: 3,
    crawl: async () => ({ report: { target: 'https://site.test/', observations: [], pages: [
      page('https://site.test/'), page('https://site.test/a'), page('https://site.test/b')
    ] } })
  });
  assert.equal(result.fleet.coverage.totalAgents, 3);
  assert.deepEqual(result.fleet.unassigned, ['https://site.test/a', 'https://site.test/b']);
  assert.equal(result.fleet.status, 'partial');
  assert.equal(result.agent.status, 'partial');
});

test('adaptive scheduling obeys the shared request budget and reports unfinished work', async () => {
  const result = await mockFleet({ maxRequests: 3, concurrency: 3,
    crawl: async () => ({ report: { target: 'https://site.test/', observations: [], pages: [
      page('https://site.test/'), page('https://site.test/a'), page('https://site.test/b')
    ] } }),
    agent: async ({ url, runtime, model }) => { await runtime.request({ model }); return completed(url); }
  });
  assert.equal(result.fleet.coverage.totalAgents, 3);
  assert.equal(result.fleet.usage.requests, 3);
  assert.equal(result.fleet.status, 'partial');
  assert.match(result.fleet.stopReason, /request limit/);
  assert.deepEqual(result.fleet.unassigned, ['https://site.test/a', 'https://site.test/b']);
});

test('failed and unvisited crawl pages remain assigned work and failures stay visible', async () => {
  const visited = new Set();
  const result = await mockFleet({
    crawl: async () => ({ report: { target: 'https://site.test/', observations: [],
      pages: [page('https://site.test/'), { url: 'https://site.test/retry', status: 'error', error: 'Timed out' }],
      unvisited: ['https://site.test/deep']
    } }),
    agent: async ({ url }) => { visited.add(url); return completed(url); }
  });
  assert.ok(visited.has('https://site.test/retry'));
  assert.ok(visited.has('https://site.test/deep'));
  assert.deepEqual(result.fleet.coverage.crawlErrors, ['https://site.test/retry']);
  assert.equal(result.fleet.status, 'partial');
});

test('a fleet with no reachable work is an error, never completed coverage', async () => {
  const result = await mockFleet({
    crawl: async () => ({ report: { target: 'https://site.test/', observations: [], pages: [] } })
  });
  assert.equal(result.fleet.coverage.totalAgents, 0);
  assert.equal(result.fleet.status, 'error');
});

test('a recovered crawl failure receives three distinct scouts', async () => {
  const result = await mockFleet({
    crawl: async () => ({ report: { target: 'https://site.test/', observations: [], pages: [
      { url: 'https://site.test/', status: 'error', error: 'Initial timeout' }
    ] } }),
    agent: async ({ url }) => completed(url, [{ tag: 'button', label: 'Filter' }])
  });
  assert.deepEqual(result.fleet.jobs.map(job => job.mission), ['journey', 'feature_map', 'controls']);
  assert.equal(result.fleet.coverage.completedAgents, 3);
  assert.equal(result.fleet.status, 'partial');
});

test('merged fleet report keeps only functional issues with real evidence, and lists what it left out', () => {
  const issue = over => ({ summary: 'Add to cart does nothing', category: 'functional', severity: 'high', expected: 'Cart count rises', actual: 'No change', reproduction: ['Open product', 'Click Add'], evidenceStep: 1, evidence: 'screenshots/001.png', ...over });
  const worker = issues => ({ report: { status: 'completed', steps: [{ index: 1, type: 'click', status: 'passed', screenshot: 'screenshots/001.png' }],
    assets: [], assessment: { issues, excludedIssues: [{ summary: 'Earlier worker drop', category: 'visual', reasons: ['x'] }], observedFeatures: [], journeysExercised: [], limitations: [] }, limitations: [] } });
  const jobs = [{ id: 'A001', mission: 'journey', url: 'https://site.test/' }];
  const results = [worker([issue(), issue({ summary: 'Hero color looks off', category: 'visual', actual: 'Looks off' }), issue({ summary: 'Search fails', evidenceStep: 42 }), issue({ summary: 'Checkout errors', reproduction: [] })])];
  const combined = combineAgentReports({ target: 'https://site.test/' }, jobs, results);
  assert.deepEqual(combined.assessment.issues.map(i => i.summary), ['Add to cart does nothing']);
  assert.deepEqual(combined.assessment.excludedIssues.map(i => i.summary).sort(), ['Checkout errors', 'Earlier worker drop', 'Hero color looks off', 'Search fails']);
  const wide = combineAgentReports({ target: 'https://site.test/' }, jobs, results, undefined, { includeDesign: true });
  assert.deepEqual(wide.assessment.issues.map(i => [i.summary, i.severity]), [['Add to cart does nothing', 'high'], ['Hero color looks off', 'info']]);
});
