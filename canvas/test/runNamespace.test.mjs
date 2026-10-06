import assert from 'node:assert/strict';
import test from 'node:test';
import { runToOps } from '../src/lib/runToOps.ts';

test('separate runs preserve all references while keeping ids unique and within contract length', () => {
  const report = { status: 'completed', steps: [
    { index: 1, screenshot: 'one.png', action: { type: 'click' }, status: 'passed' },
    { index: 2, screenshot: 'two.png', action: { type: 'scroll' }, status: 'passed' },
  ], assessment: { issues: [{ id: 'a'.repeat(64), title: 'Observed issue', expected: 'A panel opens', actual: 'Nothing happens after the click', reproduction: ['Click the button'], evidenceStep: 1,
    region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, severity: 'low' }] } };
  const a = runToOps(report, { idPrefix: 'run-a', origin: { x: 80, y: 1000 } });
  const b = runToOps(report, { idPrefix: 'run-b' });
  const ids = new Set(a.filter(o => o.id).map(o => o.id));
  assert.equal([...ids].some(id => b.some(o => o.id === id)), false);
  assert.ok([...ids].every(id => id.length <= 64));
  for (const op of a) {
    for (const ref of [op.from, op.to, op.target, ...(op.ids ?? [])].filter(Boolean)) assert.ok(ids.has(ref), ref);
  }
  const image = a.find(o => o.type === 'add_image');
  assert.equal(image.x, 80);
  assert.equal(image.y, 1000);
  assert.deepEqual(a.find(o => o.type === 'annotate').box, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
});

test('crawl and agent connectors remain distinct when their local step numbers overlap', () => {
  const ops = runToOps({
    crawl: { pages: [{ screenshot: 'crawl-1.png' }, { screenshot: 'crawl-2.png' }] },
    report: { steps: [{ index: 1, screenshot: 'step-1.png' }, { index: 2, screenshot: 'step-2.png' }] },
  }, { idPrefix: 'mixed' });
  const arrows = ops.filter(o => o.type === 'add_arrow');
  assert.equal(arrows.length, 2);
  assert.equal(new Set(arrows.map(o => o.id)).size, 2);
  assert.notEqual(arrows[0].to, arrows[1].to);
});
