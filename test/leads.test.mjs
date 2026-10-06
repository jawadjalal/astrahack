import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateLeads, loadInput, mockPlan, validatePlan, assemble, renderLeads } from '../leads/index.mjs';
import { DRAFTING_KEYS, ICP_KEYS, MORE_KEYS, RESEARCH_KEYS, PLAN_SCHEMA } from '../leads/schema.js';
import { describeUrl, discoverLeads, pickQueries, readGrounding, resolveRedirect } from '../leads/discover.mjs';

const FIXTURE = new URL('../ugc/fixtures/ignura/report.json', import.meta.url).pathname;
const NOW = new Date('2026-10-06T12:00:00Z');
const noNetwork = async () => { throw new Error('network must not be used'); };
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'leads-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const mockRun = async (t, extra = {}) => generateLeads({ input: FIXTURE, mock: true, outputDir: await temp(t), now: NOW, fetchImpl: noNetwork, ...extra });

test('input: a run report becomes observed features with evidence; nothing is invented', async () => {
  const u = await loadInput({ input: FIXTURE });
  assert.equal(u.name, 'Ignura');
  assert.equal(u.kind, 'run');
  assert.equal(u.features.length, 7);
  assert.ok(u.features.every((f) => f.evidence.length > 0 && f.evidence.every((e) => e.startsWith('screenshots/'))));
  assert.match(u.features[0].whatItDoes, /Homepage hero/);
});

test('input: brief, ugc plan and bad input', async (t) => {
  const b = await loadInput({ brief: 'Fernly is a plant-care app that reminds you when to water, for busy city renters. https://fernly.example' });
  assert.equal(b.kind, 'brief'); assert.equal(b.name, 'Fernly'); assert.equal(b.url, 'https://fernly.example');
  assert.equal(b.features[0].evidence.length, 0);
  const dir = await temp(t);
  const plan = { kind: 'astrahack.ugc-plan', source: { target: 'https://x.example' }, product: { name: 'Zed', oneLiner: 'Tracks sleep', category: 'sleep tracker', whoItsFor: 'shift workers', observedFeatures: [{ id: 'F1', name: 'Log sleep', whatItDoes: 'logs it', evidence: ['screenshots/a.png'] }], frictionFromQa: [] }, audiences: [] };
  await writeFile(join(dir, 'ugc-plan.json'), JSON.stringify(plan));
  const u = await loadInput({ input: dir });
  assert.equal(u.kind, 'ugc-plan'); assert.equal(u.name, 'Zed'); assert.equal(u.category, 'sleep tracker');
  await assert.rejects(loadInput({}), /Supply --input/);
  await assert.rejects(loadInput({ brief: 'a', input: FIXTURE }), /not both/);
  await assert.rejects(loadInput({ input: join(dir, 'missing.json') }), /Not found/);
  await writeFile(join(dir, 'other.json'), '{"hello":1}');
  await assert.rejects(loadInput({ input: join(dir, 'other.json') }), /neither a run report/);
});

test('mock: no key, no network, valid plan, grounded in observed feature ids', async (t) => {
  const { doc, dir } = await mockRun(t, { apiKey: '' });
  assert.deepEqual((await readdir(dir)).sort(), ['leads.json', 'leads.md']);
  assert.equal(doc.mode, 'mock');
  const ids = new Set(doc.product.observedFeatures.map((f) => f.id));
  for (const s of doc.icp.segments) assert.ok(s.featureIds.every((i) => ids.has(i)));
  assert.equal(validatePlan(mockPlan(await loadInput({ input: FIXTURE })), { featureIds: [...ids] }).length, 0);
  assert.equal(doc.shortlist.leads.length, 0, 'the mock never claims a live lead');
  assert.equal(doc.discovery.enabled, false);
});

test('mock: deterministic from the input', async (t) => {
  const a = (await mockRun(t)).doc, b = (await mockRun(t)).doc;
  assert.deepEqual(a, b);
  const c = (await mockRun(t, { input: undefined, brief: 'Fernly is a plant-care app for busy city renters.' })).doc;
  assert.notDeepEqual(a.sources, c.sources);
});

test('recipes: sources cover every required type with clickable platform search urls only', async (t) => {
  const { doc } = await mockRun(t);
  const types = new Set(doc.sources.map((s) => s.type));
  for (const need of ['reddit', 'x', 'hn', 'producthunt', 'indiehackers', 'community', 'newsletter', 'creator', 'intent', 'competitor']) assert.ok(types.has(need), `missing ${need}`);
  const hosts = new Set();
  for (const s of doc.sources) {
    assert.equal(s.status, 'recipe'); assert.equal(s.verified, false);
    for (const l of [...s.links, ...s.queries.flatMap((q) => q.urls)]) { const u = new URL(l.url); assert.equal(u.protocol, 'https:'); hosts.add(u.hostname); }
  }
  const allowed = ['www.reddit.com', 'x.com', 'hn.algolia.com', 'www.producthunt.com', 'www.indiehackers.com', 'www.google.com', 'www.tiktok.com', 'www.youtube.com', 'www.linkedin.com', 'www.instagram.com'];
  for (const h of hosts) assert.ok(allowed.includes(h), `unexpected host ${h}`);
  const reddit = doc.sources.find((s) => s.type === 'reddit');
  assert.match(reddit.queries[0].urls[0].url, /^https:\/\/www\.reddit\.com\/r\/\w+\/search\/\?q=/);
  assert.ok(doc.sources.find((s) => s.type === 'intent').queries.some((q) => /^(looking for|I wish)/.test(q.q)));
});

test('outreach: every draft has the evidence placeholder and a real evidence slot; none is publishable as-is', async (t) => {
  const { doc } = await mockRun(t);
  assert.deepEqual([...new Set(doc.outreach.map((o) => o.sourceType))].sort(), ['cold-email', 'dm', 'reddit-comment', 'x-reply']);
  for (const o of doc.outreach) {
    assert.ok(o.draft.includes('{{EVIDENCE}}'));
    assert.match(o.evidenceSlot, /Feature F\d/);
    assert.equal(o.evidenceRequired, true);
    assert.ok(o.etiquette.length > 0);
    assert.ok(!/guarantee|#1|proven/i.test(o.draft));
  }
  assert.ok(!/https?:\/\//.test(doc.outreach.find((o) => o.sourceType === 'reddit-comment').draft), 'first reddit reply carries no link');
  assert.equal(doc.cadence.length, 7);
  assert.deepEqual(doc.cadence.map((d) => d.day), [1, 2, 3, 4, 5, 6, 7]);
});

test('validatePlan rejects bad structure, bad subreddit names, missing placeholder, bad cadence', async () => {
  const good = mockPlan(await loadInput({ input: FIXTURE }));
  const clone = () => structuredClone(good);
  let p = clone(); p.reddit[0].subreddit = 'r/startups'; assert.match(validatePlan(p).join(), /bare name/);
  p = clone(); p.outreach[0].draft = 'no token'; assert.match(validatePlan(p).join(), /EVIDENCE/);
  p = clone(); p.cadence[1].day = 1; assert.match(validatePlan(p).join(), /cadence/);
  p = clone(); p.icp.segments[0].featureIds = ['F99']; assert.match(validatePlan(p, { featureIds: ['F1'] }).join(), /unknown feature/);
  p = clone(); delete p.icp; assert.ok(validatePlan(p).length > 0);
  p = clone(); p.extra = 1; assert.match(validatePlan(p).join(), /unexpected field/);
  assert.equal(validatePlan(good, { keys: RESEARCH_KEYS.concat(DRAFTING_KEYS) }).length, 0);
});

test('dry-run needs no key and no network, and writes prompts only', async (t) => {
  const dir = await temp(t);
  const r = await generateLeads({ input: FIXTURE, dryRun: true, apiKey: '', outputDir: dir, fetchImpl: noNetwork, now: NOW, search: true });
  assert.deepEqual(await readdir(dir), ['prompts.json']);
  assert.equal(r.doc, null);
  const prompts = JSON.parse(await readFile(join(dir, 'prompts.json'), 'utf8'));
  assert.match(prompts.plan.prompts.research, /Ignura/);
  assert.match(prompts.plan.prompts.research, /Never output URLs/);
  assert.ok(prompts.plan.prompts.more && prompts.plan.prompts.drafting);
  await assert.rejects(generateLeads({ input: FIXTURE, mock: true, dryRun: true, outputDir: dir }), /not both/);
});

test('mode guards: model mode and --search require a key; nothing is written first', async (t) => {
  const dir = await temp(t);
  await assert.rejects(generateLeads({ input: FIXTURE, apiKey: '', outputDir: dir }), /GEMINI_API_KEY/);
  await assert.rejects(generateLeads({ input: FIXTURE, mock: true, search: true, apiKey: '', outputDir: dir }), /--search needs GEMINI_API_KEY/);
  await assert.rejects(generateLeads({ input: FIXTURE, mock: true, search: true, apiKey: 'k', maxQueries: 99, outputDir: dir }), /between 1 and 20/);
  assert.deepEqual(await readdir(dir), []);
});

// ---- model path with a fake provider -------------------------------------------------------------------------
function planParts(plan) {
  const pick = (keys) => Object.fromEntries(keys.map((k) => [k, plan[k]]));
  return { research: pick(ICP_KEYS), more: pick(MORE_KEYS), drafting: pick(DRAFTING_KEYS) };
}
const ok = (obj) => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(obj) }] } }] });

test('model mode: three authenticated structured requests, schema in the body, key never persisted', async (t) => {
  const u = await loadInput({ input: FIXTURE });
  const parts = planParts(mockPlan(u));
  const calls = [];
  const { doc, dir } = await generateLeads({ input: FIXTURE, apiKey: 'test-secret', model: 'gemini-test', outputDir: await temp(t), now: NOW, fetchImpl: async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return ok([parts.research, parts.more, parts.drafting][calls.length - 1]);
  } });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.url.includes('gemini-test:generateContent') && c.init.headers['x-goog-api-key'] === 'test-secret'));
  assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(Object.keys(calls[0].body.generationConfig.responseJsonSchema.properties), ICP_KEYS);
  assert.deepEqual(Object.keys(calls[1].body.generationConfig.responseJsonSchema.properties), MORE_KEYS);
  assert.match(calls[1].body.contents[0].parts[0].text, /ICP already decided/);
  assert.match(calls[2].body.contents[0].parts[0].text, /ICP already decided/);
  assert.equal(doc.mode, 'model'); assert.equal(doc.model, 'gemini-test');
  for (const f of ['leads.json', 'leads.md']) assert.ok(!(await readFile(join(dir, f), 'utf8')).includes('test-secret'));
});

test('model mode: one repair pass on invalid output, then a clear failure', async (t) => {
  const u = await loadInput({ input: FIXTURE });
  const parts = planParts(mockPlan(u));
  const bad = structuredClone(parts.research); bad.reddit[0].subreddit = 'r/startups';
  const prompts = [];
  const { doc } = await generateLeads({ input: FIXTURE, apiKey: 'k', outputDir: await temp(t), now: NOW, fetchImpl: async (_u, init) => {
    prompts.push(JSON.parse(init.body).contents[0].parts[0].text);
    return ok([bad, parts.research, parts.more, parts.drafting][prompts.length - 1]);
  } });
  assert.equal(prompts.length, 4);
  assert.match(prompts[1], /previous answer had these problems/);
  assert.match(prompts[1], /bare name/); assert.equal(doc.sources.find((s) => s.type === 'reddit').name !== 'r/r/startups', true);
  await assert.rejects(generateLeads({ input: FIXTURE, apiKey: 'k', outputDir: await temp(t), fetchImpl: async () => ok(bad) }), /invalid plan-icp response/);
});

test('model mode: HTTP 429 and truncation surface without leaking bodies', async (t) => {
  await assert.rejects(generateLeads({ input: FIXTURE, apiKey: 'k', outputDir: await temp(t), fetchImpl: async () => new Response('secret body', { status: 429 }) }), (e) => /HTTP 429/.test(e.message) && !/secret body/.test(e.message));
  await assert.rejects(generateLeads({ input: FIXTURE, apiKey: 'k', outputDir: await temp(t), fetchImpl: async () => Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{' }] } }] }) }), /did not finish/);
});

// ---- live discovery with a fake grounded provider -----------------------------------------------------------
const REDIRECT = (id) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`;
const DEST = { a: 'https://www.reddit.com/r/startups/comments/abc123/looking_for_someone_to_launch_my_app/?utm_source=share&context=3', b: 'https://x.com/someFounder/status/1844?ref_src=twsrc', c: 'https://www.reddit.com/', d: 'https://old.reddit.com/r/startups/comments/abc123/looking_for_someone_to_launch_my_app' };
const redirectFetch = async (uri) => {
  const id = uri.split('/').pop();
  return new Response(null, { status: 302, headers: { location: DEST[id] } });
};

function groundedResponse() {
  const text = 'A founder asks who can launch their app. Another asks for UGC creators. Visit https://made-up.example/profile for more.';
  return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] }, groundingMetadata: {
    webSearchQueries: ['q'],
    groundingChunks: [{ web: { uri: REDIRECT('a'), title: 'reddit.com' } }, { web: { uri: REDIRECT('b'), title: 'x.com' } }, { web: { uri: REDIRECT('c'), title: 'reddit.com' } }, { web: { uri: REDIRECT('d'), title: 'reddit.com' } }],
    groundingSupports: [
      { segment: { startIndex: 0, endIndex: 41, text: 'A founder asks who can launch their app.' }, groundingChunkIndices: [0, 3] },
      { segment: { startIndex: 42, endIndex: 74, text: 'Another asks for UGC creators.' }, groundingChunkIndices: [1] },
    ] } }] });
}

test('discovery: leads come only from grounding chunks; urls are cleaned, deduped, handles parsed from the url', async (t) => {
  const doc = (await mockRun(t)).doc;
  const searchCalls = [];
  let scoreCall;
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://vertexaisearch')) return redirectFetch(url);
    const body = JSON.parse(init.body);
    if (body.tools) { searchCalls.push(body); return groundedResponse(); }
    scoreCall = body;
    const prompt = body.contents[0].parts[0].text;
    assert.ok(!prompt.includes('made-up.example'), 'model prose never reaches the scorer as a url');
    return ok({ leads: [
      { i: 0, fit: 3, intent: 3, reach: 1, whyTheyFit: 'Asks who can launch their app.', intentSignal: 'Explicit ask', outreachId: 'o-1', firstMessage: 'Happy to help. {{EVIDENCE}}' },
      { i: 1, fit: 1, intent: 1, reach: 1, whyTheyFit: 'Related', intentSignal: 'Mentions UGC', outreachId: 'bogus', firstMessage: 'No token here' },
    ] });
  };
  const r = await discoverLeads({ doc, apiKey: 'k', model: 'm', fetchImpl, maxQueries: 2, delayMs: 0 });
  assert.equal(searchCalls.length, 2);
  assert.equal(searchCalls[0].tools[0].google_search !== undefined, true);
  assert.deepEqual(r.leads.map((l) => l.url), [
    'https://www.reddit.com/r/startups/comments/abc123/looking_for_someone_to_launch_my_app',
    'https://x.com/someFounder/status/1844',
  ]);
  assert.deepEqual(r.leads.map((l) => l.handle), ['r/startups', '@someFounder']);
  assert.ok(r.leads.every((l) => l.backing === 'search-result' && l.status === 'unreviewed'));
  assert.ok(!JSON.stringify(r).includes('made-up.example'));
  assert.equal(r.leads[0].score.total, 7); assert.equal(r.leads[0].score.recency, null);
  assert.equal(r.leads[0].outreachId, 'o-1');
  assert.equal(r.leads[1].outreachId, doc.outreach.find((o) => o.sourceType === 'x-reply').id, 'unknown outreach id falls back to a real draft');
  assert.ok(r.leads[1].suggestedFirstMessage.includes('{{EVIDENCE}}'), 'placeholder is forced back in');
  assert.ok(scoreCall.generationConfig.responseJsonSchema);
  assert.equal(r.discovery.queriesRun, 2); assert.equal(r.discovery.results, 2);
});

test('discovery: quota error stops early, records it, and produces no fabricated leads; files still written', async (t) => {
  const dir = await temp(t);
  let calls = 0;
  const { doc } = await generateLeads({ input: FIXTURE, mock: true, search: true, apiKey: 'k', outputDir: dir, now: NOW, maxQueries: 5, delayMs: 0, fetchImpl: async () => { calls++; return new Response('quota', { status: 429 }); } });
  assert.equal(calls, 1, 'stops at the first 429');
  assert.equal(doc.shortlist.leads.length, 0);
  assert.equal(doc.discovery.stoppedEarly, true);
  assert.match(doc.discovery.errors[0], /429/);
  assert.equal(doc.discovery.queries[0].status, 'quota');
  const md = await readFile(join(dir, 'leads.md'), 'utf8');
  assert.match(md, /stopped early \(quota\)/);
  assert.match(md, /No leads came back/);
});

test('discovery: a response with no grounding returns no leads, however confident its prose', async (t) => {
  const doc = (await mockRun(t)).doc;
  const fetchImpl = async () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Here is a thread: https://reddit.com/r/startups/comments/zzz and @fakehandle said it.' }] } }] });
  const r = await discoverLeads({ doc, apiKey: 'k', model: 'm', fetchImpl, maxQueries: 2, delayMs: 0 });
  assert.equal(r.leads.length, 0);
  assert.equal(r.discovery.queries[0].status, 'no-grounded-results');
});

test('discovery: scoring failure keeps the leads, unscored, and says so', async (t) => {
  const doc = (await mockRun(t)).doc;
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://vertexaisearch')) return redirectFetch(url);
    return JSON.parse(init.body).tools ? groundedResponse() : new Response('x', { status: 429 });
  };
  const r = await discoverLeads({ doc, apiKey: 'k', model: 'm', fetchImpl, maxQueries: 1, delayMs: 0 });
  assert.equal(r.leads.length, 2);
  assert.ok(r.leads.every((l) => l.score === null && /Not scored/.test(l.whyTheyFit)));
  assert.match(r.discovery.errors.join(), /scoring/);
});

test('discovery helpers: describeUrl, readGrounding, resolveRedirect, pickQueries', async (t) => {
  assert.equal(describeUrl('https://example.com/'), null);
  assert.equal(describeUrl('not a url'), null);
  assert.equal(describeUrl('javascript:alert(1)'), null);
  assert.equal(describeUrl('https://news.ycombinator.com/item?id=42&utm_source=x').handle, 'HN item 42');
  assert.equal(describeUrl('https://www.reddit.com/user/someone/comments/1/x').handle, 'u/someone');
  assert.equal(describeUrl('https://twitter.com/search?q=x').handle, 'twitter.com');
  const g = readGrounding(await groundedResponse().json());
  assert.equal(g.results.length, 4); assert.deepEqual(g.results[0].snippets, ['A founder asks who can launch their app.']);
  assert.equal(await resolveRedirect('https://example.com/x', noNetwork), 'https://example.com/x', 'non-redirect urls are not fetched');
  assert.equal(await resolveRedirect(REDIRECT('zz'), async () => new Response(null, { status: 200 })), null);
  const doc = (await mockRun(t)).doc;
  const picks = pickQueries(doc, 6);
  assert.equal(picks.length, 6);
  assert.ok(new Set(picks.map((p) => p.source.type)).size >= 4, 'a small budget still spans platforms');
});

test('markdown: clickable links, evidence slots, honesty notes', async (t) => {
  const { dir } = await mockRun(t);
  const md = await readFile(join(dir, 'leads.md'), 'utf8');
  assert.match(md, /^# Lead generation: Ignura/);
  assert.match(md, /\]\(https:\/\/www\.reddit\.com\/r\/\w+\/search\//);
  assert.match(md, /\{\{EVIDENCE\}\}/);
  assert.match(md, /Nothing here posts, messages or emails anyone/);
  assert.match(md, /## 5\. Seven-day cadence/);
  const doc = assemble({ understanding: await loadInput({ input: FIXTURE }), plan: mockPlan(await loadInput({ input: FIXTURE })), mode: 'mock', model: 'mock', now: NOW });
  assert.equal(renderLeads(doc), renderLeads(structuredClone(doc)));
  assert.ok(PLAN_SCHEMA.properties.outreach);
});

test('lint flags invented experience, overclaims, and missing affiliation without rejecting', async () => {
  const { lintDraft } = await import('../leads/recipes.mjs');
  const bad = lintDraft({ sourceType: 'reddit-comment', draft: 'When I was building my app I ran into this. We guarantee 10x installs. https://x.example {{EVIDENCE}}', disclosure: 'none' });
  assert.ok(bad.some((w) => /invented experience/.test(w)));
  assert.ok(bad.some((w) => /overclaim/.test(w)));
  assert.ok(bad.some((w) => /no clear affiliation/.test(w)));
  assert.ok(bad.some((w) => /link/.test(w)));
  const good = lintDraft({ sourceType: 'x-reply', draft: 'One tip. I work with Ignura. {{EVIDENCE}}', disclosure: 'I work with Ignura' });
  assert.deepEqual(good, []);
  assert.ok(lintDraft({ sourceType: 'dm', draft: 'Hi [first name], here is what we saw {{EVIDENCE}}', disclosure: 'I work with Ignura' }).some((w) => /no clear affiliation/.test(w)), 'the draft itself must state the affiliation, not just the disclosure note');
});
