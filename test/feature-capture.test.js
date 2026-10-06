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
        features: [{ name: 'Project editor', whyMajor: 'Core workflow', screenshotIds: ['S0001', 'S9999'] }],
        gaps: [{ feature: 'Export', reason: 'No export view observed' }]
      }) }] }] }) };
    };
    const { outputDir, manifest } = await captureMajorFeatures(reportPath, { apiKey: 'test-key', fetchImpl: fakeFetch });
    assert.equal(requested.model, 'gpt-6-astra');
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

test('candidate contract accepts crawler observations and rejects paths outside the run', () => {
  const candidates = screenshotCandidates({ observations: [
    { screenshot: 'screenshots/a.png', observation: { title: 'A' } },
    { screenshot: '../outside.png', observation: { title: 'Outside' } }
  ] }, '/tmp/run');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].title, 'A');
});
