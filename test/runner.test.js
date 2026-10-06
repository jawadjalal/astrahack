import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../src/runner.js';
import { launchBrowser } from '../src/cdp.js';

const chrome = process.env.ASTRAHACK_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('website journey produces observations, evidence, and reproducible QA finding', { skip: !existsSync(chrome) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astrahack-test-'));
  const fixture = join(directory, 'fixture.html');
  await writeFile(fixture, `<!doctype html><html><head><title>Fixture App</title><meta name="description" content="A small test product"></head><body>
      <h1>Fixture App</h1><p>Test a simple journey.</p>
      <input id="name" aria-label="Your name"><button id="go" onclick="document.querySelector('#result').textContent='Hello, '+document.querySelector('#name').value">Go</button>
      <p id="result"></p></body></html>`);
  try {
    const url = pathToFileURL(fixture).href;
    const { out, report } = await run({
      name: 'Fixture walkthrough', target: { type: 'website', url },
      journeys: [
        { name: 'Happy path', video: !!process.env.ASTRAHACK_FFMPEG, steps: [
          { action: 'fill', selector: '#name', value: 'Ada' },
          { action: 'click', selector: '#go' },
          { action: 'assertText', text: 'Hello, Ada' }
        ] },
        { name: 'Reported failure', steps: [
          { action: 'assertText', text: 'Impossible text', expected: 'Confirmation should be visible', severity: 'high' }
        ] }
      ]
    }, { output: directory, chrome, ffmpeg: process.env.ASTRAHACK_FFMPEG });
    assert.equal(out, directory);
    assert.equal(report.status, 'findings', report.error);
    assert.equal(report.product.title, 'Fixture App');
    assert.equal(report.journeys[0].status, 'passed');
    assert.equal(report.journeys[1].status, 'failed');
    assert.equal(report.findings[0].severity, 'high');
    assert.match(report.findings[0].actual, /Impossible text/);
    assert.equal(report.findings[0].stepsToReproduce[0].action, 'assertText');
    assert.ok((await stat(join(out, report.findings[0].evidence))).size > 100);
    const saved = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
    assert.equal(saved.findings[0].id, 'QA-001');
    assert.equal(saved.journeys[0].steps[0].value, '[redacted]');
    if (process.env.ASTRAHACK_FFMPEG) {
      const video = saved.assets.find(asset => asset.type === 'video');
      assert.ok(video, saved.journeys[0].videoError);
      assert.ok((await stat(join(out, video.path))).size > 100);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Electron CDP attach mode records a renderer journey', { skip: !existsSync(chrome) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astrahack-electron-test-'));
  const browser = await launchBrowser({ executable: chrome });
  try {
    const fixture = join(directory, 'app.html');
    await writeFile(fixture, '<title>App fixture</title><h1>Desktop renderer</h1>');
    const { report } = await run({
      name: 'Renderer check', target: { type: 'electron', cdpPort: browser.port },
      journeys: [{ name: 'Open app', steps: [
        { action: 'goto', url: pathToFileURL(fixture).href },
        { action: 'assertText', text: 'Desktop renderer' }
      ] }]
    }, { output: join(directory, 'run') });
    assert.equal(report.status, 'passed', report.error);
    assert.equal(report.journeys[0].status, 'passed');
    assert.match(report.limitations[0], /Native menus/);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
