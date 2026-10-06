import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeQa, evidenceCatalog } from '../src/qa-analysis.js';

test('report prioritizes recorded failures and labels model ideas as hypotheses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'astrahack-analysis-'));
  try {
    const crawl = { target: 'https://example.test/', pages: [{ url: 'https://example.test/', finalUrl: 'https://example.test/', status: 'visited', screenshot: 'screen.png', observation: { title: 'Demo', headings: [{ level: 'h1', text: 'Demo' }], controls: [], text: 'Start a project' } }],
      findings: [{ type: 'http_error', severity: 'high', url: 'https://example.test/missing', actual: 'HTTP 404', evidence: null }], unvisited: ['https://example.test/next'] };
    const agent = { target: 'https://example.test/', status: 'completed', assets: [{ path: 'screen.png' }], steps: [{ index: 1, type: 'click', status: 'passed', screenshot: 'screen.png', observation: { url: 'https://example.test/', title: 'Demo' } }],
      assessment: { issues: [{ summary: 'Button failed', severity: 'medium', expected: 'Panel opens', actual: 'Nothing changed', reproduction: ['Open home', 'Click button'], evidenceStep: 1 }], limitations: [] } };
    await writeFile(join(dir, 'crawl.json'), JSON.stringify(crawl));
    await writeFile(join(dir, 'qa-agent.json'), JSON.stringify(agent));
    await writeFile(join(dir, 'screen.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    let payload;
    const request = async value => {
      payload = value;
      return { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
        productSummary: 'A project tool', observedFeatures: [{ name: 'Projects', evidenceRefs: ['C001', 'FAKE'] }],
        candidateFindings: [{ summary: 'Possible unclear CTA', severity: 'low', expected: 'Clear action', actual: 'Ambiguous wording', reproduction: ['Open home'], evidenceRefs: ['C001', 'FAKE'], uncertainty: 'Visual interpretation only' },
          { summary: 'Invented', severity: 'critical', expected: 'X', actual: 'Y', reproduction: [], evidenceRefs: ['FAKE'], uncertainty: 'Unknown' }], limitations: ['No mobile view']
      }) }] }] };
    };
    const { report } = await analyzeQa(dir, { request, includeImages: false });
    assert.equal(payload.model, 'gpt-6-astra');
    assert.equal(payload.store, false);
    assert.equal(report.findings.length, 3);
    assert.deepEqual(report.findings.map(f => f.verification), ['recorded', 'agent_reported', 'hypothesis']);
    assert.deepEqual(report.findings[2].evidenceRefs, ['C001']);
    assert.deepEqual(report.observedFeatures[0].evidenceRefs, ['C001']);
    assert.match(await readFile(join(dir, 'qa-analysis.md'), 'utf8'), /CF001: crawl\.json/);
    assert.equal(JSON.parse(await readFile(join(dir, 'qa-analysis.json'))).findings.length, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('catalog discards traversal screenshot references', () => {
  const catalog = evidenceCatalog({ pages: [{ url: 'https://example.test', screenshot: '../secret.png' }] });
  assert.equal(catalog[0].screenshot, null);
});

test('requires at least one evidence file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'astrahack-analysis-'));
  try { await assert.rejects(analyzeQa(dir), /needs crawl\.json or qa-agent\.json/); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
