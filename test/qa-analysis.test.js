import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeQa, buildSchema, evidenceCatalog, systemPrompt } from '../src/qa-analysis.js';
import { FUNCTIONAL_DEFINITION } from '../src/findings-filter.js';

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
        candidateFindings: [{ summary: 'Start a project link goes nowhere', category: 'functional', severity: 'low', expected: 'The project form opens', actual: 'The page does not change after the click', reproduction: ['Open home', 'Click Start a project'], evidenceRefs: ['C001', 'FAKE'], uncertainty: 'Visual interpretation only' },
          { summary: 'Possible unclear CTA', category: 'functional', severity: 'low', expected: 'Clear action', actual: 'Ambiguous wording', reproduction: ['Open home'], evidenceRefs: ['C001'], uncertainty: 'Taste' },
          { summary: 'Hero font looks dated', category: 'visual', severity: 'high', expected: 'Modern type', actual: 'Looks dated', reproduction: ['Open home'], evidenceRefs: ['C001'], uncertainty: 'Taste' },
          { summary: 'Checkout fails', category: 'functional', severity: 'high', expected: 'Order placed', actual: 'An error banner', reproduction: [], evidenceRefs: ['C001'], uncertainty: 'No steps' },
          { summary: 'Invented', category: 'functional', severity: 'critical', expected: 'X', actual: 'Y', reproduction: [], evidenceRefs: ['FAKE'], uncertainty: 'Unknown' }], limitations: ['No mobile view']
      }) }] }] };
    };
    const { report } = await analyzeQa(dir, { request, includeImages: false });
    assert.equal(payload.model, 'gpt-6-luna');
    assert.equal(payload.store, false);
    assert.equal(report.findings.length, 3);
    assert.deepEqual(report.findings.map(f => f.verification), ['recorded', 'agent_reported', 'hypothesis']);
    assert.deepEqual(report.findings.map(f => f.category), ['functional', 'functional', 'functional']);
    // design opinions, speculation, and candidates without steps or evidence are left out and listed
    assert.deepEqual(report.excludedFindings.map(f => f.summary).sort(), ['Checkout fails', 'Hero font looks dated', 'Possible unclear CTA']);
    assert.match(report.excludedFindings.find(f => f.summary === 'Checkout fails').reasons.join(), /reproduction steps/);
    assert.equal(payload.text.format.schema.properties.candidateFindings.items.properties.category.enum.length, 1);
    assert.match(await readFile(join(dir, 'qa-analysis.md'), 'utf8'), /3 candidate finding\(s\) were left out/);
    assert.deepEqual(report.findings[2].evidenceRefs, ['C001']);
    assert.deepEqual(report.observedFeatures[0].evidenceRefs, ['C001']);
    assert.match(await readFile(join(dir, 'qa-analysis.md'), 'utf8'), /CF001: crawl\.json/);
    assert.equal(JSON.parse(await readFile(join(dir, 'qa-analysis.json'))).findings.length, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('fleet report keeps global action evidence tied to the correct worker and mission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'astrahack-fleet-analysis-'));
  try {
    const agent = {
      target: 'https://example.test/', status: 'partial',
      workers: [
        { id: 'A001', mission: 'journey', url: 'https://example.test/', status: 'completed', path: 'workers/A001/qa-agent.json' },
        { id: 'A002', mission: 'controls', url: 'https://example.test/settings', status: 'error', error: 'Navigation failed', path: 'workers/A002/qa-agent.json' }
      ],
      assets: [{ workerId: 'A001', path: 'workers/A001/screenshots/000-initial.png' }],
      steps: [
        { index: 1, workerId: 'A001', type: 'click', status: 'passed', screenshot: 'workers/A001/screenshots/001-click.png', observation: { url: 'https://example.test/' } },
        { index: 2, workerId: 'A002', type: 'click', status: 'blocked_or_failed', screenshot: 'workers/A002/screenshots/001-click.png', observation: { url: 'https://example.test/settings' } }
      ],
      assessment: { issues: [
        { summary: 'Missing panel', severity: 'medium', expected: 'Panel appears', actual: 'No panel', reproduction: ['Click settings'], workerId: 'A001', evidenceStep: 1, evidence: 'workers/A001/screenshots/001-click.png' },
        { summary: 'Wrong worker', severity: 'high', expected: 'Works', actual: 'Failed', reproduction: [], workerId: 'A001', evidenceStep: 2, evidence: 'workers/A002/screenshots/001-click.png' },
        { summary: 'Wrong screenshot', severity: 'low', expected: 'Works', actual: 'Failed', reproduction: [], workerId: 'A002', evidenceStep: 2, evidence: 'workers/A001/screenshots/001-click.png' }
      ], limitations: [] }
    };
    await writeFile(join(dir, 'qa-agent.json'), JSON.stringify(agent));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'workers/A001/screenshots'), { recursive: true });
    await writeFile(join(dir, 'workers/A001/screenshots/000-initial.png'), 'image');
    await writeFile(join(dir, 'workers/A001/screenshots/001-click.png'), 'image');
    const request = async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ productSummary: 'Demo', observedFeatures: [], candidateFindings: [], limitations: [] }) }] }] });
    const { report } = await analyzeQa(dir, { request, includeImages: false });
    assert.deepEqual(report.findings.map(f => f.verification), ['unverified', 'agent_reported', 'unverified']);
    assert.deepEqual(report.findings.find(f => f.summary === 'Missing panel').evidenceRefs, ['Q001']);
    assert.equal(report.evidence.find(e => e.id === 'Q002').detail.mission, 'controls');
    assert.equal(report.evidence.find(e => e.id === 'Q002').screenshot, null);
    assert.equal(report.coverage.completedWorkers, 1);
    assert.equal(report.coverage.missions.controls, 1);
    assert.match(report.limitations.join(' '), /Worker A002.*Navigation failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('analysis model can be configured through environment and overridden explicitly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'astrahack-model-analysis-'));
  const old = process.env.OPENAI_QA_ANALYSIS_MODEL;
  try {
    await writeFile(join(dir, 'crawl.json'), JSON.stringify({ target: 'https://example.test/', pages: [], findings: [] }));
    process.env.OPENAI_QA_ANALYSIS_MODEL = 'gpt-6-sol';
    const models = [];
    const request = async payload => { models.push(payload.model); return { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ productSummary: '', observedFeatures: [], candidateFindings: [], limitations: [] }) }] }] }; };
    await analyzeQa(dir, { request, includeImages: false });
    await analyzeQa(dir, { request, model: 'gpt-6-luna', includeImages: false });
    assert.deepEqual(models, ['gpt-6-sol', 'gpt-6-luna']);
  } finally {
    if (old === undefined) delete process.env.OPENAI_QA_ANALYSIS_MODEL;
    else process.env.OPENAI_QA_ANALYSIS_MODEL = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test('large fleet keeps every recorded issue while bounding model evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'astrahack-large-fleet-'));
  try {
    const pages = Array.from({ length: 80 }, (_, i) => ({ url: `https://example.test/p${i}`, status: 'visited', observation: { title: `Page ${i}` } }));
    const steps = Array.from({ length: 300 }, (_, i) => ({ index: i + 1, workerId: `A${String(Math.floor(i / 5) + 1).padStart(3, '0')}`, type: 'click', status: 'passed', observation: { url: `https://example.test/p${i % 80}` } }));
    const workers = Array.from({ length: 60 }, (_, i) => ({ id: `A${String(i + 1).padStart(3, '0')}`, mission: 'journey', url: `https://example.test/p${i}`, status: 'completed' }));
    await writeFile(join(dir, 'crawl.json'), JSON.stringify({ target: 'https://example.test/', pages, findings: [{ type: 'http_error', severity: 'high', url: 'https://example.test/bad', actual: 'HTTP 404' }] }));
    await writeFile(join(dir, 'qa-agent.json'), JSON.stringify({ target: 'https://example.test/', status: 'completed', workers, steps, assessment: { issues: [{ summary: 'No response', severity: 'medium', expected: 'Opens', actual: 'Nothing', reproduction: [], workerId: 'A060', evidenceStep: 300 }] } }));
    let sent;
    const request = async payload => { sent = JSON.parse(payload.input[1].content[0].text); return { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ productSummary: '', observedFeatures: [], candidateFindings: [], limitations: [] }) }] }] }; };
    const { report } = await analyzeQa(dir, { request, includeImages: false });
    assert.equal(report.coverage.totalEvidence, 441);
    assert.equal(report.coverage.modelEvidenceIncluded, 120);
    assert.equal(sent.evidence.length, 120);
    assert.equal(sent.evidence.some(e => e.id === 'Q300'), true);
    assert.deepEqual(report.findings.map(f => f.evidenceRefs), [['CF001'], ['Q300']]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('HTML heading checks on linked media assets are excluded from QA findings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'astrahack-media-analysis-'));
  try {
    await writeFile(join(dir, 'crawl.json'), JSON.stringify({ target: 'https://example.test/', pages: [], findings: [
      { type: 'missing_title', severity: 'low', url: 'https://example.test/demo.mp4', actual: 'Document title is empty' },
      { type: 'missing_h1', severity: 'low', url: 'https://example.test/demo.mp4', actual: 'No visible H1 heading' },
      { type: 'missing_h1', severity: 'low', url: 'https://example.test/about', actual: 'No visible H1 heading' }
    ] }));
    let evidence;
    const request = async payload => { evidence = JSON.parse(payload.input[1].content[0].text).evidence; return { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ productSummary: '', observedFeatures: [], candidateFindings: [], limitations: [] }) }] }] }; };
    const { report } = await analyzeQa(dir, { request, includeImages: false });
    assert.equal(report.findings.length, 1);
    assert.deepEqual(report.findings[0].evidenceRefs, ['CF003']);
    assert.deepEqual(evidence.map(item => item.id), ['CF003']);
    assert.match(report.limitations.join(' '), /Ignored 2 HTML title\/heading check/);
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

test('the analysis prompt and schema require the functional definition; --include-design widens them', () => {
  const strict = buildSchema().properties.candidateFindings.items;
  assert.deepEqual(strict.properties.category.enum, ['functional']);
  assert.ok(!strict.properties.severity.enum.includes('info'));
  for (const key of ['category', 'expected', 'actual', 'reproduction', 'evidenceRefs']) assert.ok(strict.required.includes(key), key);
  const wide = buildSchema({ includeDesign: true }).properties.candidateFindings.items;
  assert.deepEqual(wide.properties.category.enum, ['functional', 'usability', 'visual']);
  assert.ok(wide.properties.severity.enum.includes('info'));
  assert.ok(systemPrompt().includes(FUNCTIONAL_DEFINITION));
  assert.match(systemPrompt(), /Do not report design or usability opinions/);
  assert.match(systemPrompt({ includeDesign: true }), /severity "info"/);
});

test('--include-design keeps design findings at severity info, after the functional ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'astrahack-analysis-'));
  try {
    const crawl = { target: 'https://example.test/', pages: [{ url: 'https://example.test/', status: 'visited', observation: { title: 'Demo' } }],
      findings: [{ type: 'missing_h1', category: 'usability', severity: 'info', url: 'https://example.test/', actual: 'No visible H1 heading', evidence: null },
        { type: 'http_error', severity: 'high', url: 'https://example.test/missing', actual: 'HTTP 404', evidence: null }] };
    await writeFile(join(dir, 'crawl.json'), JSON.stringify(crawl));
    const draft = { productSummary: 'x', observedFeatures: [], candidateFindings: [], limitations: [] };
    const request = async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(draft) }] }] });
    const strict = await analyzeQa(dir, { request, includeImages: false });
    assert.deepEqual(strict.report.findings.map(f => f.summary), ['http error']);
    assert.equal(strict.report.excludedFindings.length, 1);
    const wide = await analyzeQa(dir, { request, includeImages: false, includeDesign: true });
    assert.deepEqual(wide.report.findings.map(f => [f.summary, f.category, f.severity]), [['http error', 'functional', 'high'], ['missing h1', 'usability', 'info']]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
