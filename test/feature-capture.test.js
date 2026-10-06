import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureMajorFeatures, screenshotCandidates } from '../src/feature-capture.js';

test('selects observed features, copies screenshots, and records missing coverage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'astrahack-features-'));
  try {
    const image = join(dir, 'screen.png');
    await writeFile(image, Buffer.from('89504e470d0a1a0a', 'hex'));
    const report = {
      product: { title: 'Fixture', description: 'Creates projects' },
      assets: [{ type: 'screenshot', path: 'screen.png' }],
      journeys: [{ name: 'Create project', steps: [{ index: 1, screenshot: 'screen.png', observation: { title: 'Project editor' } }] }]
    };
    const reportPath = join(dir, 'report.json');
    await writeFile(reportPath, JSON.stringify(report));
    let requested;
    const fakeFetch = async (_url, init) => {
      requested = JSON.parse(init.body);
      return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
        features: [{ name: 'Project editor', whyMajor: 'Core workflow', screenshotIds: ['S0001', 'S9999'], reportedFeatureNames: [] }],
        gaps: [{ feature: 'Export', reason: 'No export view observed' }]
      }) }] }] }) };
    };
    const { outputDir, manifest } = await captureMajorFeatures(reportPath, { apiKey: 'test-key', fetchImpl: fakeFetch });
    assert.equal(requested.model, 'gpt-6-luna');
    assert.equal(requested.reasoning.effort, 'low');
    assert.equal(requested.store, false);
    assert.equal(requested.input[1].content.includes('S0001'), true);
    assert.equal(manifest.features.length, 1);
    assert.equal(manifest.features[0].screenshots.length, 1);
    assert.equal(manifest.gaps[0].feature, 'Export');
    assert.equal((await stat(join(outputDir, manifest.features[0].screenshots[0].path))).size, 8);
    assert.equal(JSON.parse(await readFile(join(outputDir, 'manifest.json'))).features[0].name, 'Project editor');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('honestly reports fleet gaps and supports a model override', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'astrahack-fleet-features-'));
  try {
    await writeFile(join(dir, 'screen.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    await writeFile(join(dir, 'qa-agent.json'), JSON.stringify({ assessment: { observedFeatures: ['Search', 'Export'] } }));
    const reportPath = join(dir, 'fleet.json');
    await writeFile(reportPath, JSON.stringify({
      status: 'partial', product: { title: 'Fixture' },
      observations: [
        { screenshot: 'screen.png', observation: { title: 'Search', text: 'Search items' } },
        { screenshot: 'missing.png', observation: { title: 'Export', text: 'Export items' } }
      ],
      jobs: [{ id: 'A001', url: 'https://fixture.test/search', status: 'completed' }, { id: 'A002', url: 'https://fixture.test/export', status: 'error' }],
      unassigned: ['https://fixture.test/settings']
    }));
    let requested;
    const fakeFetch = async (_url, init) => {
      requested = JSON.parse(init.body);
      return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
        features: [{ name: 'Search', whyMajor: 'Core workflow', screenshotIds: ['S0001'], reportedFeatureNames: ['Search'] }], gaps: []
      }) }] }] }) };
    };
    const { manifest } = await captureMajorFeatures(reportPath, { apiKey: 'test-key', fetchImpl: fakeFetch, model: 'gpt-6-sol' });
    assert.equal(requested.model, 'gpt-6-sol');
    assert.equal(manifest.model, 'gpt-6-sol');
    assert.equal(manifest.coverage.scope, 'observed screens only');
    assert.equal(manifest.coverage.screenshotsAvailable, 1);
    assert.equal(manifest.coverage.incompleteWorkers, 1);
    assert.deepEqual(manifest.features[0].reportedFeatureNames, ['Search']);
    assert.ok(manifest.gaps.some(gap => gap.feature === 'Export' && gap.reason.includes('no selected screenshot')));
    assert.ok(manifest.gaps.some(gap => gap.reason.includes('Screenshot unavailable')));
    assert.ok(manifest.gaps.some(gap => gap.feature.includes('settings')));
    assert.ok(manifest.gaps.some(gap => gap.feature.includes('export') && gap.reason.includes('did not complete')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writes an explicit gap when no screenshot observations exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'astrahack-empty-features-'));
  try {
    const reportPath = join(dir, 'fleet.json');
    await writeFile(reportPath, JSON.stringify({ status: 'partial', observations: [], unassigned: ['https://fixture.test/feature'] }));
    const { manifest } = await captureMajorFeatures(reportPath);
    assert.equal(manifest.candidateCount, 0);
    assert.equal(manifest.features.length, 0);
    assert.ok(manifest.gaps.some(gap => gap.feature === 'Screenshot coverage'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('model precedence is CLI option, environment, then Luna', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'astrahack-model-features-'));
  const previous = process.env.OPENAI_SCREENSHOT_MODEL;
  try {
    const reportPath = join(dir, 'fleet.json');
    await writeFile(reportPath, JSON.stringify({ observations: [] }));
    process.env.OPENAI_SCREENSHOT_MODEL = 'gpt-6-sol';
    assert.equal((await captureMajorFeatures(reportPath)).manifest.model, 'gpt-6-sol');
    assert.equal((await captureMajorFeatures(reportPath, { model: 'gpt-6-luna' })).manifest.model, 'gpt-6-luna');
    await assert.rejects(captureMajorFeatures(reportPath, { model: ' ' }), /nonempty/);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_SCREENSHOT_MODEL;
    else process.env.OPENAI_SCREENSHOT_MODEL = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('candidate contract accepts crawler observations and rejects paths outside the run', () => {
  const candidates = screenshotCandidates({ observations: [
    { screenshot: 'screenshots/a.png', observation: { title: 'A' } },
    { screenshot: '../outside.png', observation: { title: 'Outside' } }
  ] }, '/tmp/run');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].title, 'A');
});

test('candidate contract accepts QA exploration steps', () => {
  const candidates = screenshotCandidates({
    initialObservation: { title: 'Start' },
    assets: [{ type: 'screenshot', path: 'screenshots/start.png' }],
    steps: [{ index: 1, screenshot: 'screenshots/feature.png', observation: { title: 'Feature' } }]
  }, '/tmp/run');
  assert.deepEqual(candidates.map(item => item.title), ['Feature', 'Start']);
});
