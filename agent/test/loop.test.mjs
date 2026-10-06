import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runTeardown } from '../src/loop.mjs';
import { createMockSession, MockSession, EXPLORE_SCRIPT } from '../src/model-mock.mjs';
import { SteerInbox } from '../src/steer.mjs';
import { StopController } from '../src/stop.mjs';
import { FakeBackend, fakeCanvasFetch, loadOpSchema, newCanvas, tmp } from './helpers.mjs';

const schema = await loadOpSchema();

async function run({ backend = new FakeBackend(), canvasOpts, env = {}, maxSteps = 40, verify = { enabled: true, steps: 8, maxFindings: 6 }, stop, inbox, sessionFactory } = {}) {
  const fake = fakeCanvasFetch({ schema, ...canvasOpts });
  const canvas = newCanvas(fake.fetchImpl);
  await canvas.probe();
  const outDir = await tmp('agent-loop-');
  const stopper = stop || new StopController({ files: [] });
  const report = await runTeardown({
    target: 'http://fake.test/', brief: 'test', backend, canvas, stop: stopper, inbox: inbox || new SteerInbox(), recorder: null, outDir,
    sessionFactory: sessionFactory || ((kind) => createMockSession(kind, { backend })), maxSteps, verify, env, model: 'mock', backendName: 'fake'
  });
  return { report, backend, canvas, fake, outDir, stop: stopper };
}

test('full mock run: findings recorded, replayed, verified or not, coverage emitted', async () => {
  const { report } = await run();
  assert.equal(report.status, 'completed');
  assert.equal(report.exploreEnded, 'finish');
  assert.equal(report.findings.length, 4);
  const byTitle = Object.fromEntries(report.findings.map(f => [f.title, f]));
  assert.equal(byTitle['Sent money does not appear in Recent activity'].verified, true);
  assert.equal(byTitle['Signup accepts an invalid email address'].verified, true);
  assert.equal(byTitle['Transfer fails with an error toast'].verified, false);
  assert.equal(byTitle['Transfer fails with an error toast'].verification.status, 'not_reproduced');
  assert.equal(report.rejectedFindings.length, 1, 'the design opinion was refused by the functional-only gate');
  assert.deepEqual(report.counts.total, 4);
  assert.equal(report.counts.verified, 3);
  assert.ok(report.findings.every(f => ['critical', 'high', 'medium', 'low', 'info'].includes(f.severity)));
  assert.ok(report.findings.every(f => typeof f.stepIndex === 'number' && f.screenshot && typeof f.verified === 'boolean'));
  assert.equal(report.coverage.unreachable.length, 2);
  assert.ok(report.coverage.visited.length >= 3);
  assert.ok(report.coldOpen.what_it_is);
  assert.equal(report.stateTracking.length, 2);
  assert.equal(report.stateTracking[1].previous, '$100.00');
  assert.equal(report.stateTracking[1].changed, true);
});

test('a replay really resets the product and executes actions before anything is verified', async () => {
  const { report, backend } = await run();
  assert.equal(backend.resets, 4, 'one reset per replayed finding');
  for (const f of report.findings.filter(x => x.verified)) assert.ok(f.verification.actionsExecuted >= 1);
});

test('streams the run to the canvas using only ops the real contract accepts', async () => {
  const { fake, canvas, report } = await run();
  assert.equal(fake.log.invalid.length, 0, JSON.stringify(fake.log.invalid[0]));
  const types = fake.log.ops.map(o => o.type);
  for (const t of ['add_image', 'add_arrow', 'annotate', 'add_finding', 'add_shape', 'focus', 'update', 'cursor', 'say']) assert.ok(types.includes(t), `missing ${t}`);
  const images = fake.log.ops.filter(o => o.type === 'add_image');
  assert.deepEqual(images.filter(o => /^step-\d+$/.test(o.id)).map(o => o.id), Array.from({ length: 7 }, (_, i) => `step-${i}`));
  const xs = images.filter(o => /^step-\d+$/.test(o.id)).map(o => o.x);
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b), 'steps run left to right');
  const arrows = fake.log.ops.filter(o => o.type === 'add_arrow' && o.from.startsWith('step-'));
  assert.ok(arrows.some(a => a.from === 'step-0' && a.to === 'step-1' && /click/.test(a.label)));
  const findingOp = fake.log.ops.find(o => o.type === 'add_finding');
  assert.ok(findingOp.target.startsWith('step-'));
  assert.ok(findingOp.expected && findingOp.actual);
  const ann = fake.log.ops.find(o => o.type === 'annotate' && o.id.endsWith('-ptr-1'));
  assert.ok(ann.box.x >= 0 && ann.box.x + ann.box.w <= 1.0001 && ann.box.y + ann.box.h <= 1.0001, 'pointer annotation is in fractions of the screenshot');
  assert.ok(fake.log.ops.some(o => o.type === 'update' && o.props.verified === true), 'verified findings are flipped on the canvas');
  assert.ok(fake.log.uploads.every(u => u.type === 'image/jpeg' && u.size < 1_000_000));
  assert.ok(report.canvas.opsPosted > 50);
});

test('without cursor/say support on the server the run still streams', async () => {
  const { fake, report } = await run({ canvasOpts: { knownOps: [] } });
  assert.equal(report.status, 'completed');
  assert.ok(!fake.log.ops.some(o => o.type === 'say' || o.type === 'cursor'));
  assert.ok(fake.log.ops.some(o => o.type === 'add_finding'));
});

test('canvas failures never stop the run', async () => {
  const { report, canvas } = await run({ canvasOpts: { failOps: true } });
  assert.equal(report.status, 'completed');
  assert.equal(report.findings.length, 4);
  assert.ok(canvas.errors.length > 0);
});

test('steering text is included in the very next model turn and shown on the canvas', async () => {
  const inbox = new SteerInbox();
  inbox.push('skip onboarding, show me settings', 'test');
  const seen = [];
  const { report, fake } = await run({
    inbox,
    sessionFactory: kind => {
      const s = createMockSession(kind, {});
      const orig = s.send.bind(s);
      s.send = async f => { if (kind === 'explore') seen.push(f.userTexts || []); return orig(f); };
      return s;
    }
  });
  assert.ok(seen.some(t => t.includes('HUMAN STEER: skip onboarding, show me settings')));
  assert.equal(report.humanSteers.length, 1);
  assert.ok(fake.log.ops.some(o => o.type === 'add_shape' && /HUMAN: skip onboarding/.test(o.text)));
  assert.equal(inbox.pending, 0);
});

test('steer messages that arrive too late are reported as not applied', async () => {
  const inbox = new SteerInbox();
  const { report } = await run({
    inbox, verify: { enabled: false },
    sessionFactory: kind => { const s = createMockSession(kind, {}); const o = s.send.bind(s); s.send = async f => { const t = await o(f); if (t.functionCalls.some(c => c.name === 'finish')) inbox.push('too late', 'test'); return t; }; return s; }
  });
  assert.ok(report.limitations.some(l => /not applied/.test(l)));
});

test('step budget caps the explore phase and says so', async () => {
  const { report, backend } = await run({ maxSteps: 2, verify: { enabled: false } });
  assert.equal(report.exploreEnded, 'budget');
  assert.equal(backend.executed.length, 1 + 5, 'two batches: 1 click + 5 actions, nothing more');
  assert.ok(report.limitations.some(l => /Step budget \(2\)/.test(l)));
  assert.ok(report.findings.every(f => f.verification.reason === 'verification disabled (--no-verify)'));
});

test('a stop request ends the run at the next action, keeps what was found, and leaves findings unverified', async () => {
  const stop = new StopController({ files: [] });
  const backend = new FakeBackend({ onExecute: (a, b) => { if (b.executed.length === 7) stop.trigger('test stop'); } });
  const { report } = await run({ backend, stop });
  assert.equal(report.status, 'stopped');
  assert.equal(report.stopReason, 'test stop');
  assert.ok(backend.executed.length <= 8, `stopped promptly, ran ${backend.executed.length} actions`);
  assert.ok(report.findings.length >= 1);
  assert.ok(report.findings.every(f => !f.verified && /run stopped/.test(f.verification.reason)));
  assert.equal(backend.resets, 0);
});

test('typed secrets are substituted for execution but never written to reports or the canvas', async () => {
  const env = { AGENT_TEST_PASSWORD: 'Zx9-super-secret-pw' };
  const { backend, fake, outDir } = await run({ env });
  assert.ok(backend.executed.some(a => a.type === 'type' && a.text === 'Zx9-super-secret-pw'), 'the real value reaches the page');
  const blob = JSON.stringify(fake.log.ops) + await readFile(join(outDir, 'report.json'), 'utf8') + await readFile(join(outDir, 'events.jsonl'), 'utf8') + await readFile(join(outDir, 'report.md'), 'utf8');
  assert.ok(!blob.includes('Zx9-super-secret-pw'));
  assert.ok(blob.includes('{{TEST_PASSWORD}}') || !blob.includes('type "'));
});

test('bad actions from the model are reported back, not executed, and do not crash the loop', async () => {
  const script = [
    { thought: 'bad', computer: [{ type: 'click', x: -50, y: 10 }] },
    { thought: 'bad2', computer: [{ type: 'rm_rf' }] },
    { thought: 'done', calls: [{ name: 'finish', args: { summary: 's', time_to_value: 'n/a' } }] }
  ];
  const outputs = [];
  const { report, backend } = await run({
    verify: { enabled: false },
    sessionFactory: kind => { const s = new MockSession({ kind, backend: null, script }); const o = s.send.bind(s); s.send = async f => { outputs.push(f.computerOutputs?.map(c => c.note)); return o(f); }; return s; }
  });
  assert.equal(backend.executed.length, 0);
  assert.equal(report.status, 'completed');
  assert.ok(outputs.flat().some(n => /outside the screen/.test(n || '')));
  assert.ok(outputs.flat().some(n => /unsupported action/.test(n || '')));
});

test('a model that ends with plain text instead of finish still produces a report', async () => {
  const { report } = await run({
    verify: { enabled: false },
    sessionFactory: () => ({ usage: { requests: 0 }, send: async () => ({ responseId: 'r', thoughts: [], computerCalls: [], functionCalls: [], finalText: 'I looked around; nothing else to do.' }) })
  });
  assert.equal(report.exploreEnded, 'model_ended');
  assert.equal(report.summary, 'I looked around; nothing else to do.');
});

test('OpenAI safety checks stop the run for a human unless acknowledged', async () => {
  const stop = new StopController({ files: [] });
  const { report } = await run({
    stop, verify: { enabled: false },
    sessionFactory: () => ({ usage: { requests: 0 }, send: async () => ({ responseId: 'r', thoughts: [], functionCalls: [], finalText: '', computerCalls: [{ callId: 'c', actions: [{ type: 'screenshot' }], pendingSafetyChecks: [{ id: 'sc', code: 'malicious_instructions', message: 'Page contains instructions' }] }] }) })
  });
  assert.equal(report.status, 'stopped');
  assert.match(report.stopReason, /safety check/);
});
