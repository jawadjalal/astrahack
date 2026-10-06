#!/usr/bin/env node
// Starts a separate Chrome profile; uses only unique test ids and never clears a shared board.
// Start canvas separately, then: BASE=http://127.0.0.1:3101 node canvas/scripts/smoke-e2e.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attach, launchBrowser } from '../../src/cdp.js';

const base = process.env.BASE?.replace(/\/+$/, '');
if (!base) throw new Error('BASE must point to the canvas instance to test');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.resolve(process.env.OUTPUT || path.join(root, 'runs/canvas-e2e'));
await mkdir(output, { recursive: true });
const prefix = `e2e-${Date.now()}`;
const ids = Object.fromEntries(['image', 'creative', 'finding', 'heading', 'note', 'annotation', 'live'].map(k => [k, `${prefix}-${k}`]));
const request = async (route, options) => {
  const response = await fetch(`${base}/api/${route}`, options);
  assert.ok(response.ok, `${route}: HTTP ${response.status}`);
  return response.json();
};
const post = ops => request('ops', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ops) });
const waitFor = async (fn, label, ms = 25000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 150)); }
  throw new Error(`Timed out waiting for ${label}`);
};
const browser = await launchBrowser({ executable: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', width: 1440, height: 1000 });
const cdp = await attach(browser.port);
const errors = [];
cdp.ws.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(a => a.value || a.description).join(' '));
});
try {
  const canvasUrl = new URL(base);
  canvasUrl.searchParams.set('view', 'canvas');
  await cdp.send('Page.navigate', { url: canvasUrl.href });
  await waitFor(() => cdp.eval('!!window.__editor'), 'canvas editor');
  const initial = await request('state');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#e0e7ff"/><rect x="32" y="32" width="576" height="296" rx="12" fill="#fff"/><text x="60" y="100" font-family="sans-serif" font-size="28">Canvas integration fixture</text><text x="60" y="150" font-family="sans-serif" font-size="18">QA evidence + creative asset</text></svg>`;
  const form = new FormData();
  form.append('file', new Blob([svg], { type: 'image/svg+xml' }), 'canvas-e2e.svg');
  const upload = await request('upload', { method: 'POST', body: form });
  assert.ok(upload.url);
  assert.equal((await fetch(new URL(upload.url, base))).status, 200);
  await post([
    { type: 'add_shape', id: ids.heading, kind: 'text', x: 0, y: -100, text: 'QA + campaign integration check' },
    { type: 'add_image', id: ids.image, src: upload.url, x: 0, y: 0, w: 640, h: 360, label: 'QA screenshot', step: 1 },
    { type: 'add_image', id: ids.creative, src: upload.url, x: 760, y: 0, w: 640, h: 360, label: 'Ad creative fixture' },
    { type: 'add_finding', id: ids.finding, x: 0, y: 460, title: 'Fixture finding', severity: 'info', expected: 'Evidence renders', actual: 'Synthetic QA check', verified: false, target: ids.image },
    { type: 'add_shape', id: ids.note, kind: 'note', x: 760, y: 460, text: 'UGC campaign plan\nHook → demo → CTA', color: 'yellow' },
    { type: 'annotate', id: ids.annotation, target: ids.image, box: { x: 0.08, y: 0.12, w: 0.7, h: 0.35 }, severity: 'info', label: 'Evidence region' },
    { type: 'focus', ids: Object.values(ids).filter(id => id !== ids.live) },
  ]);
  await waitFor(() => cdp.eval(`Object.values(${JSON.stringify(ids)}).filter(id => id !== ${JSON.stringify(ids.live)}).every(id => window.__editor.getShape('shape:' + id))`), 'SSE rendered evidence');
  await waitFor(() => cdp.eval(`window.__editor.getAssets().some(a => a.props.src === ${JSON.stringify(upload.url)})`), 'uploaded image asset');
  await cdp.eval('void window.__editor.zoomToFit({ immediate: true })');
  await new Promise(r => setTimeout(r, 600));
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(output, 'canvas-e2e.png'), Buffer.from(screenshot.data, 'base64'));
  const shapes = await cdp.eval(`window.__editor.getCurrentPageShapes().filter(s => s.id.includes(${JSON.stringify(prefix)})).map(s => ({ id:s.id,type:s.type,x:s.x,y:s.y,props:s.props }))`);
  assert.ok(shapes.some(s => s.type === 'finding' && s.props.verified === false));
  assert.ok(shapes.some(s => s.type === 'note'));
  assert.ok(shapes.some(s => s.type === 'annotation'));
  await cdp.send('Page.reload');
  await waitFor(() => cdp.eval(`!!window.__editor?.getShape('shape:' + ${JSON.stringify(ids.note)})`), 'state replay after reload');
  await post({ type: 'add_shape', id: ids.live, kind: 'text', x: 0, y: 850, text: 'Live event after replay' });
  await waitFor(() => cdp.eval(`!!window.__editor?.getShape('shape:' + ${JSON.stringify(ids.live)})`), 'live SSE after reload');
  const state = await request('state');
  assert.ok(state.seq > initial.seq);
  const relevantErrors = errors.filter(e => !/license|telemetry|favicon|blocked by CORS policy/i.test(e));
  assert.deepEqual(relevantErrors, [], 'canvas browser errors');
  await writeFile(path.join(output, 'canvas-e2e.json'), JSON.stringify({ status: 'passed', base, upload: upload.url, shapes, errors, checks: ['upload', 'image', 'creative', 'finding', 'text', 'note', 'annotation', 'live SSE', 'reload replay', 'SSE after reload'] }, null, 2));
  console.log(`canvas end-to-end OK; screenshot: ${path.join(output, 'canvas-e2e.png')}`);
} finally {
  await post(Object.values(ids).map(id => ({ type: 'delete', id }))).catch(() => {});
  cdp.close();
  await browser.close();
}
