import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAN_SCHEMA, PLATFORMS, FORMATS, checkGrounding } from '../ugc/schema.js';
import { extractObserved } from '../ugc/extract.mjs';
import { mockPlan } from '../ugc/mock.mjs';
import { planUgc, dryRunPrompts, modelSchema, validatePlan } from '../ugc/plan.mjs';
import { validateSchema, contractPart } from '../ugc/validate.mjs';
import { resolveProvider } from '../ugc/providers.mjs';

const FIXTURE = fileURLToPath(new URL('../ugc/fixtures/ignura/', import.meta.url));
const CLI = fileURLToPath(new URL('../bin/ugc.js', import.meta.url));
const report = JSON.parse(await readFile(join(FIXTURE, 'report.json'), 'utf8'));
const observed = extractObserved(report);
const assets = new Set(observed.assets.map((a) => a.path));
const words = (s) => s.trim().split(/\s+/).length;
const strip = (doc) => ({ ...doc, generatedAt: 'x' });
const tmp = async (t) => { const d = await mkdtemp(join(tmpdir(), 'ugc-test-')); t.after(() => rm(d, { recursive: true, force: true })); return d; };

// A model reply (Gemini wire format) carrying the given plan JSON.
const geminiReply = (plan) => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(plan) }] } }] });
// What a model returns: the mock plan, i.e. PLAN_SCHEMA without observedFeatures and frictionFromQa.
const modelOutput = () => structuredClone(mockPlan(observed, ''));

test('extracts observed features with real evidence from the ignura run', () => {
  assert.equal(observed.features.length, 11);
  assert.deepEqual(observed.features.map((f) => f.id), Array.from({ length: 11 }, (_, i) => `F${i + 1}`));
  for (const f of observed.features) {
    assert.ok(f.evidence.length > 0, `${f.id} has evidence`);
    for (const e of f.evidence) assert.ok(existsSync(join(FIXTURE, e)), `${e} exists on disk`);
    assert.ok(f.whatItDoes.length > 20);
  }
  assert.equal(observed.product.name, 'Ignura');
  assert.ok(observed.product.ctaLabels.includes('Book a free call'));
  // Section and page splits: the work journey crosses three pages and becomes three features.
  assert.ok(observed.features.some((f) => f.page === '/work/ugc' && /UGC content/.test(f.name)));
  // Site claims are read from page text, and carry the page they came from.
  assert.ok(observed.siteClaims.some((c) => c.token === '£1,500'));
  assert.ok(observed.siteClaims.every((c) => c.pages.length && !/,$/.test(c.token)));
  // "2-3 mockups" and "1 month" are not figures.
  assert.ok(!observed.siteClaims.some((c) => /^\d+\s?m$/i.test(c.token)));
});

test('rejects input that is not a runner report', () => {
  assert.throws(() => extractObserved({ name: 'x' }), /journeys/);
  assert.throws(() => extractObserved(null), /journeys/);
});

test('mock plan is deterministic and valid against PLAN_SCHEMA and the grounding checks', async () => {
  const a = await planUgc({ report, mock: true });
  const b = await planUgc({ report, mock: true });
  assert.deepEqual(strip(a), strip(b));
  assert.equal(a.kind, 'astrahack.ugc-plan');
  assert.equal(a.schemaVersion, 1);
  assert.equal(a.model, 'mock');
  assert.equal(a.source.runName, 'Ignura first-visit walkthrough');
  assert.deepEqual(validateSchema(contractPart(a), PLAN_SCHEMA), []);
  assert.deepEqual(checkGrounding(a), []);
  assert.deepEqual(validatePlan(a, { assets }), []);
  assert.ok(a.scripts.length >= 3 && a.scripts.length <= 5);
  assert.ok(a.hooks.length >= a.angles.length * 2);
  for (const h of a.hooks) assert.ok(words(h.text) < 15, `hook ${h.id} under 15 words: ${h.text}`);
  for (const s of a.scripts) {
    assert.ok(PLATFORMS.includes(s.platform) && FORMATS.includes(s.format));
    assert.ok(s.beats.length >= 4);
    assert.equal(s.durationSec, Number(s.beats.at(-1).t.split('-')[1].replace('s', '')));
    assert.ok(s.beats.some((x) => x.assetRef), 'at least one beat shows a captured asset');
    for (const beat of s.beats) if (beat.assetRef) assert.ok(existsSync(join(FIXTURE, beat.assetRef)), `${beat.assetRef} exists`);
  }
  // Evidence and features come from the run only.
  assert.deepEqual(a.product.observedFeatures.map(({ id, name, evidence }) => ({ id, name, evidence })),
    observed.features.map(({ id, name, evidence }) => ({ id, name, evidence })));
  // Unverified site claims are listed as proposals, never silently used as fact.
  assert.ok(a.proposals.some((p) => /£16,000/.test(p) && /did not verify/.test(p)));
  assert.ok(a.proposals.some((p) => /did not sign up/.test(p)));
});

test('mock plan respects platforms named in the brief', async () => {
  const plan = await planUgc({ report, mock: true, brief: 'Launch on TikTok and Reels only. Audience: indie app founders.' });
  assert.ok(plan.scripts.every((s) => ['tiktok', 'instagram-reels'].includes(s.platform)));
  assert.ok(plan.proposals.some((p) => /indie app founders/.test(p)));
  assert.deepEqual(validatePlan(plan, { assets }), []);
});

test('model output must match the model schema, which omits the fields the planner fills itself', () => {
  const schema = modelSchema();
  assert.ok(!('observedFeatures' in schema.properties.product.properties));
  assert.ok(!schema.properties.product.required.includes('frictionFromQa'));
  assert.deepEqual(validateSchema(modelOutput(), schema), []);
  const bad = modelOutput();
  bad.scripts[0].platform = 'myspace';
  bad.hooks[0].extra = true;
  delete bad.campaign.goal;
  const problems = validateSchema(bad, schema);
  assert.ok(problems.some((p) => /platform.*myspace/.test(p)));
  assert.ok(problems.some((p) => /unexpected property/.test(p)));
  assert.ok(problems.some((p) => /campaign\.goal: missing/.test(p)));
});

test('grounding repair: unknown features, ids and assets are fixed or dropped, never trusted', async () => {
  const out = modelOutput();
  out.angles[0].featureIds = ['F99', 'f2'];                       // one fake, one lower-case real
  out.angles[1].featureIds = ['F98'];                             // only fake, matched by text or dropped
  out.angles[2].audienceId = 'A9';
  out.scripts[0].featureIds = ['F77'];                            // falls back to its angle's features
  out.scripts[1].hookId = 'H99';
  out.scripts[1].creatorId = 'C99';
  out.scripts[2].beats[1].assetRef = 'screenshots/does-not-exist.png';
  out.scripts[2].beats[2].assetRef = './screenshots/006-Browse-the-work-by-type-click.png';
  out.scripts[3].angleId = 'ANG99';                               // recovered from its hook
  out.scripts[4].beats[0].voiceover = 'Ignura grew signups by 40% in a week.'; // a figure no page shows
  out.campaign.calendar.push({ day: 20, platform: 'tiktok', scriptId: 'S99', note: 'ghost' });
  const calls = [];
  const plan = await planUgc({ report, provider: 'gemini', apiKey: 'test-key', model: 'gemini-test', fetchImpl: async (url, init) => { calls.push({ url, init }); return geminiReply(out); } });
  assert.equal(calls.length, 1, 'repairable output needs no second call');
  assert.deepEqual(validatePlan(plan, { assets }), []);
  const ids = new Set(plan.product.observedFeatures.map((f) => f.id));
  assert.ok(!ids.has('F99'));
  for (const a of plan.angles) for (const id of a.featureIds) assert.ok(ids.has(id));
  for (const s of plan.scripts) for (const id of s.featureIds) assert.ok(ids.has(id));
  assert.ok(plan.angles[0].featureIds.includes('F2'));
  assert.ok(plan.campaign.calendar.every((c) => c.scriptId !== 'S99'));
  const all = plan.grounding.repairs.join('\n');
  for (const needle of ['F99', 'F77', 'A9', 'H99', 'C99', 'does-not-exist', 'ANG99', 'S99']) assert.match(all, new RegExp(needle));
  assert.match(all, /normalised to screenshots\/006/);
  assert.equal(plan.scripts[2].beats[2].assetRef, 'screenshots/006-Browse-the-work-by-type-click.png');
  assert.ok(plan.scripts[2].beats[1].assetRef !== 'screenshots/does-not-exist.png' && assets.has(plan.scripts[2].beats[1].assetRef));
  assert.ok(plan.proposals.some((p) => /"40%"/.test(p) && /does not appear anywhere the run observed/.test(p)));
  // The request itself: Gemini structured output with the model schema, key in the header, no features field.
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'test-key');
  assert.ok(calls[0].url.includes('gemini-test:generateContent'));
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.ok(!('observedFeatures' in body.generationConfig.responseJsonSchema.properties.product.properties));
  assert.match(body.systemInstruction.parts[0].text, /untrusted/);
  assert.match(body.contents[0].parts[0].text, /OBSERVED FEATURES/);
  assert.ok(!JSON.stringify(plan).includes('test-key'));
});

test('a model that invents evidence for features cannot change the evidence list', async () => {
  const out = modelOutput();
  out.product.observedFeatures = [{ id: 'F1', name: 'Fake', whatItDoes: 'Fake', evidence: ['screenshots/fake.png'] }];
  const plan = await planUgc({ report, provider: 'gemini', apiKey: 'k', fetchImpl: async () => geminiReply(out) }).catch((e) => e);
  // Extra property is a schema violation on both attempts, so it is rejected rather than merged.
  assert.ok(plan instanceof Error && /unexpected property/.test(plan.message));
});

test('video evidence: timestamps are cited in the shot and "path@12s" is normalised', async () => {
  const r = structuredClone(report);
  r.journeys[1].video = 'video/Browse-the-work-by-type.webm';
  r.journeys[1].startedAt = '2026-10-06T17:38:50.000Z';
  r.journeys[1].steps.forEach((s, i) => { s.startedAt = new Date(Date.parse('2026-10-06T17:38:50.000Z') + i * 4000).toISOString(); });
  r.assets.push({ type: 'video', path: 'video/Browse-the-work-by-type.webm', journey: 'Browse the work by type' });
  const obs = extractObserved(r);
  assert.ok(obs.videos.length === 1 && obs.features.find((f) => f.journey === 'Browse the work by type').evidence.includes('video/Browse-the-work-by-type.webm'));
  const mocked = await planUgc({ report: r, mock: true });
  const videoBeat = mocked.scripts.flatMap((s) => s.beats).find((b) => b.assetRef === 'video/Browse-the-work-by-type.webm');
  assert.ok(videoBeat && /video at \d:\d\d/.test(videoBeat.shot));
  const out = structuredClone(mockPlan(obs, ''));
  out.scripts[0].beats[1].assetRef = 'video/Browse-the-work-by-type.webm@12s';
  const plan = await planUgc({ report: r, provider: 'gemini', apiKey: 'k', fetchImpl: async () => geminiReply(out) });
  assert.equal(plan.scripts[0].beats[1].assetRef, 'video/Browse-the-work-by-type.webm');
  assert.match(plan.scripts[0].beats[1].shot, /video at 0:12/);
});

test('openai path uses the shared Responses helper with strict structured output', async () => {
  const out = modelOutput();
  let payload;
  const plan = await planUgc({
    report, provider: 'openai', apiKey: 'oa-key', model: 'test-model',
    request: async (p, opts) => { payload = { p, opts }; return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(out) }] }] }; },
  });
  assert.equal(plan.model, 'test-model');
  assert.equal(plan.grounding.provider, 'openai');
  assert.equal(payload.p.text.format.type, 'json_schema');
  assert.equal(payload.p.text.format.strict, true);
  assert.equal(payload.p.store, false);
  assert.equal(payload.opts.apiKey, 'oa-key');
  assert.equal(payload.p.input[0].role, 'system');
  assert.deepEqual(validatePlan(plan, { assets }), []);
});

test('retries once with the validation errors, then fails loudly', async () => {
  const good = modelOutput();
  const broken = modelOutput();
  delete broken.campaign;
  const prompts = [];
  const plan = await planUgc({ report, provider: 'gemini', apiKey: 'k', fetchImpl: async (url, init) => {
    prompts.push(JSON.parse(init.body).contents[0].parts[0].text);
    return geminiReply(prompts.length === 1 ? broken : good);
  } });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /previous answer failed validation/);
  assert.match(prompts[1], /campaign: missing/);
  assert.deepEqual(validatePlan(plan, { assets }), []);

  let n = 0;
  await assert.rejects(planUgc({ report, provider: 'gemini', apiKey: 'k', fetchImpl: async () => { n++; return geminiReply(broken); } }), /failed validation after 2 attempt/);
  assert.equal(n, 2);
});

test('script count outside 3 to 5 is rejected, more than 5 is trimmed', async () => {
  const many = modelOutput();
  many.scripts.push({ ...structuredClone(many.scripts[0]), id: 'S6' }, { ...structuredClone(many.scripts[1]), id: 'S7' });
  const trimmed = await planUgc({ report, provider: 'gemini', apiKey: 'k', fetchImpl: async () => geminiReply(many) });
  assert.equal(trimmed.scripts.length, 5);
  assert.ok(trimmed.grounding.repairs.some((r) => /kept the first 5/.test(r)));
  const few = modelOutput();
  few.scripts.length = 2;
  await assert.rejects(planUgc({ report, provider: 'gemini', apiKey: 'k', maxAttempts: 1, fetchImpl: async () => geminiReply(few) }), /expected 3 to 5/);
});

test('provider errors do not leak response bodies; a key is required', async () => {
  await assert.rejects(planUgc({ report, provider: 'gemini', apiKey: '' }), /GEMINI_API_KEY/);
  await assert.rejects(planUgc({ report, provider: 'openai', apiKey: '', request: async () => { throw new Error('unreachable'); } }), /OPENAI_API_KEY/);
  await assert.rejects(planUgc({ report, provider: 'gemini', apiKey: 'k', fetchImpl: async () => new Response('secret echo of the prompt', { status: 429 }) }), (e) => /quota/.test(e.message) && !/secret/.test(e.message));
  await assert.rejects(planUgc({ report, provider: 'gemini', apiKey: 'k', fetchImpl: async () => Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{' }] } }] }) }), /did not finish/);
  assert.equal(resolveProvider('openai', {}), 'openai');
  assert.equal(resolveProvider(undefined, { OPENAI_API_KEY: 'x' }), 'openai');
  assert.equal(resolveProvider(undefined, { GEMINI_API_KEY: 'x', OPENAI_API_KEY: 'y' }), 'gemini');
  assert.throws(() => resolveProvider('claude', {}), /gemini or openai/);
});

test('dry run builds prompts from the report without any key or network', () => {
  const { system, user, schema } = dryRunPrompts({ report, brief: 'For indie founders' });
  assert.match(system, /untrusted source content/);
  assert.match(user, /=== OBSERVED FEATURES/);
  assert.match(user, /F7/);
  assert.match(user, /screenshots\/028-Work-page-and-UGC-case-study-assertText\.png/);
  assert.match(user, /For indie founders/);
  assert.match(user, /SITE CLAIMS.*NOT verified/);
  assert.ok(schema.properties.scripts);
});

test('cli: --mock writes a valid ugc-plan.json and ugc-plan.md', async (t) => {
  const out = await tmp(t);
  const run = spawnSync(process.execPath, [CLI, FIXTURE, '--mock', '--out', out], { encoding: 'utf8', env: { ...process.env, GEMINI_API_KEY: '', OPENAI_API_KEY: '' } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /valid: PLAN_SCHEMA \+ grounding checks passed/);
  assert.deepEqual((await readdir(out)).sort(), ['ugc-plan.json', 'ugc-plan.md']);
  const doc = JSON.parse(await readFile(join(out, 'ugc-plan.json'), 'utf8'));
  assert.deepEqual(validatePlan(doc, { assets }), []);
  const md = await readFile(join(out, 'ugc-plan.md'), 'utf8');
  assert.match(md, /^# UGC plan: Ignura/);
  assert.match(md, /## Proposals \(not observed/);
  assert.match(md, /### S1\./);
  // report.json path works too, and the brief file is read.
  const again = spawnSync(process.execPath, [CLI, join(FIXTURE, 'report.json'), '--mock', '--out', out, '--brief', 'Reels only'], { encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
});

test('cli: --dry-run prints prompts and writes nothing; bad input exits 1 with a message', async (t) => {
  const out = await tmp(t);
  const dry = spawnSync(process.execPath, [CLI, FIXTURE, '--dry-run', '--out', out], { encoding: 'utf8', env: { ...process.env, GEMINI_API_KEY: '', OPENAI_API_KEY: '' } });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /--- SYSTEM ---/);
  assert.match(dry.stdout, /OBSERVED FEATURES/);
  assert.deepEqual(await readdir(out), []);
  const missing = spawnSync(process.execPath, [CLI, join(out, 'nope')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Not found/);
  const noKey = spawnSync(process.execPath, [CLI, FIXTURE, '--provider', 'gemini', '--out', out], { encoding: 'utf8', env: { ...process.env, GEMINI_API_KEY: '', OPENAI_API_KEY: '' } });
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /GEMINI_API_KEY/);
  assert.deepEqual(await readdir(out), []);
});
