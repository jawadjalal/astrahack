import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crawlSite, normalizeLink } from '../src/crawl.js';
import { runQaAgent, executeComputerAction } from '../src/qa-agent.js';
import { findChrome } from '../src/chrome-path.js';

const chrome = findChrome() || '';

test('same-origin link normalization excludes external and fragment duplicates', () => {
  assert.equal(normalizeLink('/features#top', 'https://site.test/', 'https://site.test'), 'https://site.test/features');
  assert.equal(normalizeLink('https://other.test/', 'https://site.test/', 'https://site.test'), null);
  assert.equal(normalizeLink('mailto:hi@site.test', 'https://site.test/', 'https://site.test'), null);
  assert.equal(normalizeLink('/demo.mp4', 'https://site.test/', 'https://site.test'), null);
});

test('bounded crawler inventories linked pages and writes evidence', { skip: !existsSync(chrome) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astrahack-crawl-test-'));
  try {
    const home = join(directory, 'home.html');
    await writeFile(home, '<title>Home</title><h1>Home</h1><a href="features.html">Features</a><a href="https://other.test/">External</a>');
    await writeFile(join(directory, 'features.html'), '<h2>Feature details</h2><p>Useful feature.</p>');
    const { out, report } = await crawlSite({ url: pathToFileURL(home).href, output: join(directory, 'run'), chrome, maxPages: 2 });
    assert.equal(report.pages.length, 2);
    assert.equal(report.pages[1].depth, 1);
    assert.ok(report.findings.some(finding => finding.type === 'missing_h1'));
    assert.ok((await stat(join(out, report.pages[1].screenshot))).size > 100);
    assert.equal(JSON.parse(await readFile(join(out, 'crawl.json'), 'utf8')).pages.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Astra computer loop records actions and verifies evidence references', { skip: !existsSync(chrome) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astrahack-agent-test-'));
  try {
    const fixture = join(directory, 'app.html');
    await writeFile(fixture, '<title>Fixture</title><h1>Fixture product</h1>');
    const calls = [];
    const request = async payload => {
      calls.push(payload);
      if (calls.length === 1) return { id: 'resp-1', status: 'completed', output: [
        { type: 'computer_call', call_id: 'call-1', actions: [{ type: 'screenshot' }] }
      ] };
      return { id: 'resp-2', status: 'completed', output: [{ type: 'message', content: [{
        type: 'output_text', text: JSON.stringify({
          productUnderstanding: 'Fixture product', observedFeatures: ['Home'], journeysExercised: ['Initial view'],
          issues: [{ summary: 'Example issue', severity: 'low', expected: 'Expected', actual: 'Actual', reproduction: ['Open fixture'], evidenceStep: 1 }], limitations: []
        })
      }] }] };
    };
    const { out, report } = await runQaAgent({ url: pathToFileURL(fixture).href, output: join(directory, 'run'), chrome, request });
    assert.equal(report.status, 'completed', report.error);
    assert.equal(report.steps.length, 1);
    assert.equal(report.assessment.issues[0].evidence, report.steps[0].screenshot);
    assert.equal(calls[0].model, 'gpt-6-astra');
    assert.equal(calls[1].previous_response_id, 'resp-1');
    assert.equal(calls[1].input[0].call_id, 'call-1');
    assert.ok((await stat(join(out, report.steps[0].screenshot))).size > 100);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('QA action guard blocks external links and consequential buttons', async () => {
  const external = { eval: async () => ({ href: 'https://other.test/', label: '' }) };
  await assert.rejects(executeComputerAction(external, { type: 'click', x: 10, y: 10 }, 'https://site.test'), /External link blocked/);
  const dangerous = { eval: async () => ({ href: null, label: 'Delete account' }) };
  await assert.rejects(executeComputerAction(dangerous, { type: 'click', x: 10, y: 10 }, 'https://site.test'), /Consequential action blocked/);
});
