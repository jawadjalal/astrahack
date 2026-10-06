import test from 'node:test';
import assert from 'node:assert/strict';
import { FindingStore, Coverage, normalizeSeverity, boxAroundPoint } from '../src/findings.mjs';

const raw = (over = {}) => ({ title: 'Signup accepts bad email', severity: 'high', expected: 'rejected', actual: 'accepted', repro_steps: ['open', 'submit'], ...over });
const ctx = { stepIndex: 3, screenshot: 'screenshots/step-003.jpg', timestamp: 12.34, size: { width: 1000, height: 500 } };

test('findings carry the full schema and start unverified', () => {
  const store = new FindingStore();
  const { finding } = store.add(raw({ box: { x: 100, y: 50, w: 200, h: 100 } }), ctx);
  assert.equal(finding.id, 'F1');
  assert.equal(finding.severity, 'high');
  assert.equal(finding.stepIndex, 3);
  assert.equal(finding.screenshot, 'screenshots/step-003.jpg');
  assert.equal(finding.timestamp, 12.3);
  assert.equal(finding.verified, false);
  assert.equal(finding.verification.status, 'not_attempted');
  assert.deepEqual(finding.box, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, 'pixel boxes become fractions of the screenshot');
  assert.deepEqual(finding.repro, ['open', 'submit']);
});

test('findings need a title, expected and actual', () => {
  const store = new FindingStore();
  assert.throws(() => store.add(raw({ title: ' ' })), /title/);
  assert.throws(() => store.add(raw({ expected: '' })), /expected and actual/);
  assert.throws(() => store.add(raw({ actual: undefined })), /expected and actual/);
});

test('severity is normalized to the five allowed values', () => {
  for (const s of ['critical', 'high', 'medium', 'low', 'info']) assert.equal(normalizeSeverity(s), s);
  assert.equal(normalizeSeverity('MAJOR'), 'high');
  assert.equal(normalizeSeverity('blocker'), 'critical');
  assert.equal(normalizeSeverity('nonsense'), 'medium');
  assert.equal(normalizeSeverity(undefined), 'medium');
});

test('the same issue reported twice is merged and keeps the worse severity', () => {
  const store = new FindingStore();
  store.add(raw({ severity: 'low' }), ctx);
  const again = store.add(raw({ title: 'SIGNUP accepts bad email!', severity: 'critical' }), ctx);
  assert.equal(again.duplicate, true);
  assert.equal(store.items.length, 1);
  assert.equal(store.items[0].severity, 'critical');
});

test('verified only when the replay executed actions AND produced a screenshot AND the model saw it again', () => {
  const store = new FindingStore();
  const { finding } = store.add(raw(), ctx);
  const replay = { actionsExecuted: 3, screenshot: 'screenshots/verify-F1-002.jpg', stepIndex: 2, timestamp: 5 };
  store.applyVerification('F1', { reproduced: true, observation: 'saw it' }, replay);
  assert.equal(finding.verified, true);
  assert.equal(finding.verification.status, 'reproduced');
  assert.equal(finding.verification.actionsExecuted, 3);
});

test('a claim of reproduction without any replayed action is rejected', () => {
  const store = new FindingStore();
  const { finding } = store.add(raw(), ctx);
  store.applyVerification('F1', { reproduced: true, observation: 'trust me' }, { actionsExecuted: 0, screenshot: 'x.jpg' });
  assert.equal(finding.verified, false);
  assert.equal(finding.verification.status, 'rejected');
  assert.match(finding.verification.reason, /without replaying/);
});

test('a claim of reproduction without a fresh screenshot is rejected', () => {
  const store = new FindingStore();
  const { finding } = store.add(raw(), ctx);
  store.applyVerification('F1', { reproduced: true, observation: 'saw it' }, { actionsExecuted: 2 });
  assert.equal(finding.verified, false);
  assert.equal(finding.verification.status, 'rejected');
});

test('not reproduced and inconclusive replays stay unverified with a reason', () => {
  const store = new FindingStore();
  store.add(raw(), ctx);
  store.add(raw({ title: 'Other' }), ctx);
  store.applyVerification('F1', { reproduced: false, observation: 'worked fine' }, { actionsExecuted: 2, screenshot: 'a.jpg' });
  assert.equal(store.get('F1').verified, false);
  assert.equal(store.get('F1').verification.status, 'not_reproduced');
  store.applyVerification('F2', { inconclusive: true, observation: 'ran out of steps' }, { actionsExecuted: 8, screenshot: 'b.jpg' });
  assert.equal(store.get('F2').verified, false);
  assert.equal(store.get('F2').verification.status, 'inconclusive');
  assert.throws(() => store.applyVerification('F9', { reproduced: true }, {}), /unknown finding/);
});

test('toVerify returns the worst unverified findings first and respects the cap', () => {
  const store = new FindingStore();
  store.add(raw({ title: 'low one', severity: 'low' }), { ...ctx, stepIndex: 1 });
  store.add(raw({ title: 'critical one', severity: 'critical' }), { ...ctx, stepIndex: 5 });
  store.add(raw({ title: 'high early', severity: 'high' }), { ...ctx, stepIndex: 2 });
  store.add(raw({ title: 'high late', severity: 'high' }), { ...ctx, stepIndex: 4 });
  assert.deepEqual(store.toVerify(3).map(f => f.title), ['critical one', 'high early', 'high late']);
  store.applyVerification('F2', { reproduced: true }, { actionsExecuted: 1, screenshot: 's.jpg' });
  assert.ok(!store.toVerify(10).some(f => f.title === 'critical one'), 'already verified findings are not replayed');
});

test('counts and canvas shape', () => {
  const store = new FindingStore();
  store.add(raw(), ctx);
  store.add(raw({ title: 'b', severity: 'info' }), ctx);
  store.applyVerification('F1', { reproduced: true }, { actionsExecuted: 1, screenshot: 's.jpg' });
  assert.deepEqual(store.counts(), { total: 2, verified: 1, unverified: 1, critical: 0, high: 1, medium: 0, low: 0, info: 1 });
  const c = store.toCanvas(store.get('F1'));
  assert.equal(c.verified, true);
  assert.equal(c.timestamp, 12.3);
  assert.deepEqual(Object.keys(c).sort(), ['actual', 'expected', 'severity', 'timestamp', 'title', 'verified']);
});

test('boxAroundPoint returns fractions clipped to the image', () => {
  const b = boxAroundPoint({ x: 10, y: 10 }, { width: 1000, height: 500 }, 36);
  assert.equal(b.x, 0);
  assert.equal(b.y, 0);
  assert.ok(Math.abs(b.w - 0.046) < 1e-9);
  assert.ok(b.h <= 1 && b.w <= 1);
});

test('coverage lists visited and unreachable screens without double counting', () => {
  const cov = new Coverage();
  cov.note({ screen: 'Settings', status: 'visited', detail: 'via menu' });
  cov.note({ screen: 'Settings', status: 'unreachable', detail: '404' });
  cov.note({ screen: 'Home', status: 'visited', detail: 'cold open' });
  cov.noteUrl('http://x.test/home#top', 1);
  cov.noteUrl('about:blank', 1);
  const j = cov.toJSON();
  assert.deepEqual(j.unreachable.map(u => u.screen), ['Settings']);
  assert.deepEqual(j.visited.map(v => v.screen).sort(), ['Home', 'http://x.test/home']);
  assert.throws(() => cov.note({ screen: ' ', status: 'visited' }), /screen name/);
});

test('design opinions are refused with a reason and listed in rejected, never stored', () => {
  const store = new FindingStore();
  assert.throws(() => store.add(raw({ title: 'Landing headline might have a typo', expected: 'Flawless copy', actual: 'I thought instantly looked odd' }), ctx), /design or taste opinion/);
  assert.throws(() => store.add(raw({ title: 'Button color is off-brand', actual: 'Looks green', category: 'visual' }), ctx), /design observation/);
  assert.equal(store.items.length, 0);
  assert.equal(store.rejected.length, 2);
  assert.equal(store.rejected[0].category, 'visual');
});

test('a finding without repro steps is refused', () => {
  const store = new FindingStore();
  assert.throws(() => store.add(raw({ repro_steps: [] }), ctx), /reproduction steps/);
  assert.equal(store.items.length, 0);
});

test('functional findings carry category functional; includeDesign keeps design ones at severity info', () => {
  const strict = new FindingStore();
  assert.equal(strict.add(raw({ category: 'functional' }), ctx).finding.category, 'functional');
  const wide = new FindingStore({ includeDesign: true });
  const { finding } = wide.add(raw({ title: 'Heading font looks dated', category: 'visual', severity: 'high', actual: 'Looks dated' }), ctx);
  assert.equal(finding.category, 'visual');
  assert.equal(finding.severity, 'info');
});
