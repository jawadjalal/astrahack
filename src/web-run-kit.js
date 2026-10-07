import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { boardApi } from '../canvas/src/lib/board.mjs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateCreatives } from '../lib/generate.mjs';
import { generateCampaigns } from '../lib/campaigns.mjs';
import { planUgc } from '../ugc/plan.mjs';
import { renderPlan } from '../ugc/render.mjs';
import { streamResponse } from '../lib/responses-stream.mjs';
import { readCanvasJson } from './canvas-response.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const hash = value => createHash('sha256').update(value).digest('hex');
const readOptional = async file => {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const bounded = (signal, fetchImpl = fetch, timeoutMs = 300000) => (url, init = {}) => fetchImpl(url, {
  ...init, signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...[signal, init.signal].filter(Boolean)])
});

/** Preserve actual actions and screenshot paths while adapting the fleet to the existing UGC contract. */
export function marketingReport({ agent, crawl, url, runId }) {
  const groups = new Map();
  for (const step of agent?.steps || []) {
    const worker = (agent.workers || []).find(item => item.id === step.workerId);
    const name = worker ? `${worker.id}: ${worker.mission} — ${worker.url}` : 'Observed UI journey';
    if (!groups.has(name)) groups.set(name, { name, status: worker?.status || agent.status, steps: [] });
    groups.get(name).steps.push({ ...step, action: step.type || (typeof step.action === 'string' ? step.action : step.action?.type) || 'observe' });
  }
  let index = Math.max(0, ...(agent?.steps || []).map(step => step.index || 0));
  for (const page of crawl?.pages || []) if (page.observation && page.screenshot) {
    const name = `Recorded page: ${page.finalUrl || page.url}`;
    groups.set(name, { name, status: page.status, steps: [{ index: ++index, action: 'observe',
      status: page.status === 'visited' ? 'passed' : 'failed', observation: page.observation, screenshot: page.screenshot }] });
  }
  return { schemaVersion: 1, name: `Website exploration ${runId}`, target: { type: 'website', url },
    status: agent?.status || 'partial', product: crawl?.product || agent?.initialObservation || {},
    journeys: [...groups.values()], assets: [...(agent?.assets || []), ...(crawl?.assets || [])],
    findings: [...(agent?.assessment?.issues || []), ...(crawl?.findings || [])], limitations: agent?.limitations || [] };
}

export async function generateWebKit(output, { url, runId, signal, onProgress = async () => {},
  ads = generateCreatives, campaigns = generateCampaigns, ugc = planUgc, env = process.env,
  fetchImpl = fetch, render = renderPlan } = {}) {
  const [agent, crawl] = await Promise.all(['qa-agent.json', 'crawl.json'].map(name => readOptional(join(output, name))));
  const report = marketingReport({ agent, crawl, url, runId });
  if (!report.journeys.length) throw new Error('No observed website evidence is available for a launch kit.');
  const brief = [
    `Create launch drafts for ${url}. Use the recorded website evidence below as source data.`,
    'Site statements are observed claims, not independently verified results. Do not invent features, customers, prices, guarantees, or testimonials. Mark audience and campaign ideas as proposals.',
    JSON.stringify({ product: report.product, pages: report.journeys.map(journey => ({ name: journey.name,
      observations: journey.steps.filter(step => step.observation).slice(0, 2).map(step => ({
        title: step.observation.title, headings: step.observation.headings,
        text: String(step.observation.text || '').slice(0, 1000), url: step.observation.url
      })) })) }).slice(0, 22000)
  ].join('\n\n');
  const reportPath = join(output, 'marketing-report.json');
  await Promise.all([json(reportPath, report), writeFile(join(output, 'marketing-brief.txt'), brief)]);
  const directory = join(output, 'launch-kit');
  await mkdir(directory, { recursive: true });
  const result = { status: 'complete', ads: null, campaigns: null, ugc: null, failures: [] };
  const safeFetch = bounded(signal, fetchImpl, 600000);
  const run = async (name, work) => {
    if (signal?.aborted) { result.failures.push(name); return; }
    await onProgress({ stage: `generating_${name}`, message: `Generating ${name === 'ads' ? 'five ad images' : name === 'campaigns' ? 'X and Reddit campaign drafts' : 'UGC hooks and scripts'} from observed evidence.` });
    try {
      result[name] = await work();
      if (name !== 'ugc' && result[name]?.manifest?.status !== 'complete') result.failures.push(name);
    } catch { result.failures.push(name); }
  };
  await Promise.all([
    run('ads', () => ads({ prompt: brief, outputDir: directory, provider: env.IMAGE_PROVIDER || 'openai',
      openaiApi: 'responses', responseModel: env.OPENAI_IMAGE_RESPONSE_MODEL || 'gpt-6-luna',
      quality: env.OPENAI_IMAGE_QUALITY || 'low', fetchImpl: safeFetch, signal, requestTimeoutMs: 600000 })),
    run('campaigns', () => campaigns({ prompt: brief, outputDir: directory, provider: env.CAMPAIGN_PROVIDER || 'openai',
      model: env.CAMPAIGN_PROVIDER === 'gemini' ? env.GEMINI_TEXT_MODEL : env.OPENAI_TEXT_MODEL || 'gpt-6-luna',
      channels: ['x', 'reddit'], fetchImpl: safeFetch, signal, requestTimeoutMs: 600000 })),
    run('ugc', async () => {
      const document = await ugc({ report, brief, provider: env.UGC_PROVIDER || 'openai',
        model: env.UGC_PROVIDER === 'gemini' ? env.GEMINI_TEXT_MODEL : env.OPENAI_TEXT_MODEL || 'gpt-6-luna',
        reportPath, runDir: output, fetchImpl: safeFetch,
        request: (payload, options = {}) => streamResponse(payload, { ...options, signal, timeoutMs: 600000 }) });
      const path = join(output, 'ugc-plan.json');
      await Promise.all([json(path, document), writeFile(join(output, 'ugc-plan.md'), render(document))]);
      return { path, document };
    })
  ]);
  const usable = Boolean(result.ugc?.document?.scripts?.length) ||
    result.ads?.manifest?.creatives?.some(item => item.status === 'complete') ||
    result.campaigns?.manifest?.campaigns?.some(item => item.status === 'complete');
  result.status = !result.failures.length ? 'complete' : usable ? 'partial' : 'failed';
  await json(join(output, 'launch-kit.json'), { status: result.status, failures: result.failures,
    ads: result.ads?.runDir || null, campaigns: result.campaigns?.runDir || null, ugc: result.ugc?.path || null });
  return result;
}

/** Namespace only generated IDs; external screenshot references must keep the teardown's IDs. */
export function namespaceKitOps(ops, runId) {
  const prefix = `run-${hash(runId).slice(0, 12)}-kit-`;
  const ids = new Map(ops.filter(op => op.id).map(op => [op.id, `${prefix}${hash(op.id).slice(0, 14)}`]));
  return ops.map(op => {
    const next = { ...op };
    for (const key of ['id', 'from', 'to', 'target']) if (ids.has(next[key])) next[key] = ids.get(next[key]);
    if (Array.isArray(next.ids)) next.ids = next.ids.map(id => ids.get(id) || id);
    return next;
  });
}

/** Uses the same renderer and upload contract as canvas/scripts/push-kit.mjs, with per-run IDs. */
export async function publishWebKit(kit, { output, canvasUrl, runId, board, signal, fetchImpl = fetch } = {}) {
  const layout = await import('../canvas/src/lib/kitToOps.ts');
  const { OpSchema } = await import('../canvas/src/lib/ops.ts');
  const request = bounded(signal, fetchImpl);
  const base = canvasUrl.replace(/\/+$/, '');
  const call = async (path, init) => {
    const response = await request(boardApi(base, board)(path), { ...init, redirect: 'manual' });
    const body = await readCanvasJson(response);
    if (!response.ok) {
      const error = new Error(`Canvas request failed (HTTP ${response.status}).`);
      error.status = response.status;
      // Locally validated optional ops can be rejected by an older deployed schema.
      error.unsupportedOp = response.status === 400 && (body.error === 'invalid op(s)' || /unsupported|unknown.*(?:op|type)/i.test(String(body.error || '')));
      throw error;
    }
    return body;
  };
  const state = await call('/state');
  if (!Array.isArray(state.ops)) throw new Error('Canvas state response is missing its ops array.');
  const { box, ids } = layout.stateBounds(state.ops || []);
  const srcMap = {}, sizes = {};
  for (const creative of kit.ads?.manifest?.creatives || []) if (creative.status === 'complete') {
    const file = resolve(kit.ads.runDir, creative.filename);
    const rel = relative(resolve(kit.ads.runDir), file);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || rel.startsWith(sep)) throw new Error('Invalid ad image path.');
    const bytes = await readFile(file);
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Ad image is not PNG.');
    sizes[creative.filename] = { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
    if (bytes.length > 4_000_000) {
      const require = createRequire(join(root, 'canvas/package.json'));
      const { upload } = await import(pathToFileURL(require.resolve('@vercel/blob/client')).href);
      const blob = await upload(`kits/${hash(runId).slice(0, 12)}/${creative.filename}`, new Blob([bytes], { type: 'image/png' }),
        { access: 'public', handleUploadUrl: `${base}/api/upload/token` });
      srcMap[creative.filename] = blob.url;
    } else {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'image/png' }), creative.filename);
      const uploaded = await call('/upload', { method: 'POST', body: form });
      if (!uploaded.url) throw new Error('Canvas returned no uploaded image URL.');
      srcMap[creative.filename] = uploaded.url;
    }
  }
  const campaigns = {};
  for (const channel of ['x', 'reddit']) if (kit.campaigns?.runDir) {
    const campaign = await readOptional(join(kit.campaigns.runDir, `${channel}-campaign.json`));
    if (campaign) campaigns[channel] = campaign;
  }
  const report = await readOptional(join(output, 'qa-agent.json'));
  const stepPrefix = `run-${hash(runId).slice(0, 12)}-`;
  const byPath = new Map((report?.steps || []).filter(step => step.screenshot).map(step => [step.screenshot, `${stepPrefix}step-${step.index}`]));
  const rendered = layout.kitToOpsDetailed({ ads: kit.ads?.manifest, campaigns, ugcPlan: kit.ugc?.document }, {
    origin: layout.originBelow(box), srcMap, sizes, stepIds: ids, stepPrefix,
    stepIdFor: path => byPath.get(path) || null, say: layout.detectSayOp(OpSchema), group: layout.supportsGroup(OpSchema)
  });
  const ops = namespaceKitOps(rendered.ops, runId);
  if (!ops.length) throw new Error('No generated launch-kit artifacts are available to publish.');
  for (const op of ops) OpSchema.parse(op);
  const required = ops.filter(op => !['say', 'group'].includes(op.type));
  for (let offset = 0; offset < required.length; offset += 40) await call('/ops', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(required.slice(offset, offset + 40))
  });
  let postedCount = required.length;
  const warnings = [];
  for (const op of ops.filter(op => ['say', 'group'].includes(op.type))) {
    try {
      await call('/ops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(op) });
      postedCount++;
    } catch (error) {
      if (!error.unsupportedOp) throw error;
      warnings.push(`Canvas does not support the optional ${op.type} decoration; required artifacts were published.`);
    }
  }
  return { counts: rendered.counts, postedCount, optionalSkipped: warnings.length, warnings };
}
