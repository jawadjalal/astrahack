import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgePlan, formatTable } from '../judge/loop.mjs';
import { judgeOps, findUgcLane } from '../judge/canvas.mjs';
import { productFacts, scoreHook, words, HOOK_MAX_WORDS } from '../judge/heuristic.mjs';
import { checkGrounding } from '../ugc/schema.js';
import { validatePlan, contractPart } from '../ugc/validate.mjs';

const FIXTURE = fileURLToPath(new URL('../ugc/fixtures/ignura/', import.meta.url));
const CLI = fileURLToPath(new URL('../bin/judge.js', import.meta.url));
const plan = JSON.parse(await readFile(join(FIXTURE, 'ugc-plan.json'), 'utf8'));
const fresh = () => structuredClone(plan);

test('heuristic judge flags ad-speak, long hooks and invented figures', () => {
  const facts = productFacts(plan);
  const good = scoreHook({ angleId: 'ANG2', text: 'Why does Ignura\'s FAQ say "Things founders ask us"?' }, facts);
  const adspeak = scoreHook({ angleId: 'ANG2', text: 'Ignura is a revolutionary game-changer that will unlock your launch.' }, facts);
  const long = scoreHook({ angleId: 'ANG2', text: 'This is a very long hook about Ignura that just keeps going and going past the limit, honestly.' }, facts);
  const fake = scoreHook({ angleId: 'ANG2', text: 'Why did 9,731 founders pick Ignura\'s FAQ?' }, facts);
  assert.ok(good.overall >= 8, good.rationale);
  assert.match(adspeak.rationale, /ad-speak/);
  assert.ok(long.overall <= 4 && /max 15/.test(long.rationale));
  assert.match(fake.rationale, /unsupported figure: 9,731/);
});

test('mock loop improves the ignura plan and keeps it valid and grounded', async () => {
  const { plan: out, report } = await judgePlan(fresh(), { mock: true, rounds: 2, threshold: 8 });
  const { summary } = report;
  assert.ok(summary.hooks.after > summary.hooks.before + 1, JSON.stringify(summary.hooks));
  assert.ok(summary.scripts.after > summary.scripts.before, JSON.stringify(summary.scripts));
  assert.deepEqual(checkGrounding(contractPart(out)), []);
  assert.deepEqual(validatePlan(out), []);
  for (const h of out.hooks) assert.ok(words(h.text) <= HOOK_MAX_WORDS, h.text);
  for (const s of out.scripts) assert.equal(s.beats[0].voiceover, out.hooks.find((h) => h.id === s.hookId).text);
  for (const r of report.items) assert.ok(r.after >= r.before, `${r.id} got worse`);
  const rewritten = report.items.find((r) => r.rewritten);
  assert.ok(rewritten.versions.length >= 2 && rewritten.versions.every((v) => v.rationale));
  assert.match(formatTable(report), /H\d+\s+\d\.\d → \d+\.\d/);
  // deterministic
  const again = await judgePlan(fresh(), { mock: true });
  assert.deepEqual(again.plan.hooks, out.hooks);
});

test('model path: gpt-6-astra structured outputs via a stubbed fetch, key never leaks', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, auth: init.headers.Authorization });
    const name = body.text.format.name;
    let out;
    if (name === 'ugc_judge_scores') {
      const ids = [...body.input[1].content.matchAll(/^\[(\w+)\] \((hook|script)\) (.*)$/gm)];
      out = { items: ids.map(([, id, , text]) => {
        const fixed = /Nobody explains/.test(text);
        const v = fixed ? 9 : 6;
        return { id, scores: { scrollStop: v, specificity: v, native: v, clarity: v, grounding: v, compliance: v }, rationale: fixed ? 'tension + feature' : 'generic' };
      }) };
    } else {
      out = { hooks: [{ id: 'H1', text: 'Nobody explains "What does a launch cost?" Ignura\'s FAQ does.', visualOpener: 'FAQ on screen' }], scripts: [] };
    }
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(out) }] }] });
  };
  const { plan: out, report } = await judgePlan(fresh(), { apiKey: 'sk-test-secret', fetchImpl, rounds: 1, threshold: 8 });
  assert.equal(calls[0].body.model, 'gpt-6-astra');
  assert.equal(calls[0].body.text.format.type, 'json_schema');
  assert.ok(calls.every((c) => c.url.endsWith('/v1/responses') && c.auth === 'Bearer sk-test-secret'));
  assert.ok(!JSON.stringify(report).includes('sk-test-secret'));
  assert.equal(report.summary.judge, 'gpt-6-astra');
  assert.match(out.hooks[0].text, /Nobody explains/);
  assert.equal(report.items.find((r) => r.id === 'H1').after, 9);
  assert.deepEqual(validatePlan(out), []);
});

test('canvas ops sit under the UGC lane and arrow to the matching hook cards', async () => {
  const { report } = await judgePlan(fresh(), { mock: true });
  // push-kit layout (canvas/src/lib/kitToOps.ts): one card per script (ugc-S1, text carries HOOK: "...") + lone hooks (ugc-H2)
  const used = new Set(plan.scripts.map((x) => x.hookId));
  const cardsSpec = [...plan.scripts.map((x) => ({ id: `ugc-${x.id}`, text: `TikTok\n${x.id}\nHOOK: "${plan.hooks.find((h) => h.id === x.hookId).text}"` })),
    ...plan.hooks.filter((h) => !used.has(h.id)).map((h) => ({ id: `ugc-${h.id}`, text: `HOOK  ·  pov\n${h.id}\n"${h.text}"` }))];
  const envs = cardsSpec.map((c, i) => ({ seq: i, ts: 0, op: { type: 'add_shape', id: c.id, kind: 'rectangle', x: 4000 + i * 420, y: 900, w: 380, h: 140, text: c.text } }));
  assert.equal(findUgcLane(envs).cards.length, 10);
  const { ops, say } = judgeOps(report, plan, envs, { tag: 't1' });
  for (const o of ops) if (o.id) { assert.ok(o.id.startsWith('judge-t1-') && o.id.length <= 64, o.id); }
  const arrows = ops.filter((o) => o.type === 'arrow_to');
  assert.ok(arrows.length >= 1);
  for (const a of arrows) assert.ok(envs.some((e) => e.op.id === a.to));
  assert.ok(ops.find((o) => o.id === 'judge-t1-title').y > 900);
  assert.match(say, /^Judge: \d+ hooks rewritten, avg \d\.\d → \d+\.\d/);
  assert.ok(ops.some((o) => o.type === 'say'));
  assert.equal(arrows.length, report.items.filter((r) => r.kind === 'hook' && r.rewritten).length);
  assert.ok(arrows.some((a) => a.to === 'ugc-S1') && arrows.some((a) => a.to === 'ugc-H2'));
  // the older kit lane ids still resolve
  const legacy = [{ op: { type: 'add_shape', id: 'kitab12-ugc-hook-1', kind: 'note', x: 10, y: 10, text: `PROPOSED HOOK\n"${plan.hooks[0].text}"` } }];
  assert.ok(judgeOps(report, plan, legacy, { tag: 't3' }).ops.some((o) => o.type === 'arrow_to' && o.to === 'kitab12-ugc-hook-1'));
  const lone = judgeOps(report, plan, [], { tag: 't2' });
  assert.equal(lone.ops.filter((o) => o.type === 'arrow_to').length, 0);
});

test('CLI --mock writes judge.json and ugc-plan.judged.json', async (t) => {
  const out = await mkdtemp(join(tmpdir(), 'judge-test-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [CLI, FIXTURE, '--mock', '--out', out], { encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /AVERAGE\s+hooks \d\.\d → \d+\.\d/);
  const judged = JSON.parse(await readFile(join(out, 'ugc-plan.judged.json'), 'utf8'));
  const report = JSON.parse(await readFile(join(out, 'judge.json'), 'utf8'));
  assert.deepEqual(validatePlan(judged), []);
  assert.equal(report.kind, 'astrahack.ugc-judge');
});
