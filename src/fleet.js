import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { crawlSite, normalizeLink } from './crawl.js';
import { runQaAgent } from './qa-agent.js';
import { createResponse } from './openai.js';

const saveJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');

export function planFleet(crawl, maxAgents = 60) {
  if (!Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > 300) throw new Error('maxAgents must be 1–300');
  const pages = (crawl.pages || []).filter(page => page.status === 'visited' && page.observation && page.screenshot);
  const jobs = [];
  const add = (page, mission) => jobs.push({
    id: `A${String(jobs.length + 1).padStart(3, '0')}`,
    mission, url: page.finalUrl || page.url,
    title: page.observation.title || '',
    screenshot: page.screenshot,
    headings: page.observation.headings?.map(item => item.text).filter(Boolean).slice(0, 8) || [],
    discoveredFrom: page.discoveredFrom || null
  });
  for (const page of pages.slice(0, maxAgents)) add(page, 'journey');
  for (const page of pages) {
    if (jobs.length >= maxAgents) break;
    add(page, 'feature_map');
  }
  for (const page of pages) {
    if (jobs.length >= maxAgents) break;
    if ((page.observation.controls || []).some(control => !control.href)) add(page, 'controls');
  }
  return {
    jobs,
    unassigned: pages.slice(maxAgents).map(page => page.finalUrl || page.url)
  };
}

async function pool(items, concurrency, task) {
  let next = 0;
  const results = new Array(items.length);
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = await task(items[index], index); }
      catch (error) { results[index] = { error: error.message }; }
    }
  });
  await Promise.all(workers);
  return results;
}

export function combineAgentReports(crawl, jobs, results) {
  const combined = {
    schemaVersion: 1, target: crawl.target, model: 'gpt-6-astra',
    status: 'completed', initialObservation: crawl.product || null,
    steps: [], assets: [], assessment: {
      productUnderstanding: '', observedFeatures: [], journeysExercised: [], issues: [], limitations: []
    }, limitations: [], workers: []
  };
  let globalIndex = 0;
  for (const [index, job] of jobs.entries()) {
    const result = results[index];
    const report = result?.report;
    combined.workers.push({ id: job.id, mission: job.mission, url: job.url, status: report?.status || 'error', error: result?.error || report?.error || null, path: result?.relativeReport || null });
    if (!report) { combined.status = 'partial'; continue; }
    if (report.status !== 'completed') combined.status = 'partial';
    const indexMap = new Map();
    for (const step of report.steps || []) {
      const newIndex = ++globalIndex;
      indexMap.set(step.index, newIndex);
      combined.steps.push({ ...step, index: newIndex, workerId: job.id,
        screenshot: step.screenshot ? `workers/${job.id}/${step.screenshot}` : null });
    }
    for (const asset of report.assets || []) {
      combined.assets.push({ ...asset, workerId: job.id, path: `workers/${job.id}/${asset.path}` });
    }
    const assessment = report.assessment;
    if (assessment) {
      combined.assessment.productUnderstanding ||= assessment.productUnderstanding || '';
      combined.assessment.observedFeatures.push(...(assessment.observedFeatures || []));
      combined.assessment.journeysExercised.push(...(assessment.journeysExercised || []));
      for (const issue of assessment.issues || []) {
        const mapped = indexMap.get(issue.evidenceStep);
        const localEvidence = issue.evidence || report.steps.find(step => step.index === issue.evidenceStep)?.screenshot;
        combined.assessment.issues.push({ ...issue, workerId: job.id, evidenceStep: mapped ?? -1,
          evidence: mapped && localEvidence ? `workers/${job.id}/${localEvidence}` : null,
          verification: mapped ? issue.verification : 'unverified evidence reference' });
      }
      combined.assessment.limitations.push(...(assessment.limitations || []));
    }
    combined.limitations.push(...(report.limitations || []));
  }
  combined.assessment.observedFeatures = [...new Set(combined.assessment.observedFeatures)];
  combined.assessment.journeysExercised = [...new Set(combined.assessment.journeysExercised)];
  combined.assessment.limitations = [...new Set(combined.assessment.limitations)];
  combined.limitations = [...new Set(combined.limitations)];
  return combined;
}

export async function runFleet({
  url, chrome, output, brief = '', model = 'gpt-6-astra',
  maxPages = 50, maxDepth = 4, maxAgents = 60, concurrency = 8,
  maxTurns = 8, maxActions = 25, headless = true,
  request = createResponse, crawl = crawlSite, agent = runQaAgent, onProgress
}) {
  if (!url || !chrome || !output) throw new Error('url, chrome, and output are required');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('concurrency must be 1–16');
  if (request === createResponse && !process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required before starting the Astra QA fleet');
  const out = resolve(output);
  await mkdir(out, { recursive: true });
  const startedAt = new Date().toISOString();
  await onProgress?.({ phase: 'crawl', status: 'started' });
  const crawled = await crawl({ url, chrome, output: out, maxPages, maxDepth, headless });
  const crawlReport = crawled.report;
  const crawledPages = (crawlReport.pages || []).filter(page => page.status === 'visited' && page.observation && page.screenshot);
  const initialPlan = planFleet(crawlReport, Math.min(maxAgents, Math.max(1, crawledPages.length)));
  const jobs = [];
  const results = [];
  const knownUrls = new Set(crawledPages.map(page => page.finalUrl || page.url));
  const frontier = [];
  const fleet = {
    schemaVersion: 1, target: url, model, startedAt, finishedAt: null,
    limits: { maxPages, maxDepth, maxAgents, concurrency, maxTurns, maxActions },
    status: 'running', jobs: [],
    unassigned: initialPlan.unassigned, discoveredByAgents: [], crawlReport: 'crawl.json', agentReport: 'qa-agent.json',
    observations: [...(crawlReport.observations || [])]
  };
  let saveQueue = Promise.resolve();
  const save = () => { saveQueue = saveQueue.then(() => saveJson(join(out, 'fleet.json'), fleet)); return saveQueue; };
  await save();
  const addDiscovered = report => {
    const observations = [report.initialObservation, ...(report.steps || []).map(step => step.observation)].filter(Boolean);
    for (const observation of observations) {
      const links = [observation.url, ...(observation.controls || []).map(control => control.href)].filter(Boolean);
      for (const raw of links) {
        const link = normalizeLink(raw, observation.url || url, new URL(url).origin);
        if (link && !knownUrls.has(link)) {
          knownUrls.add(link);
          frontier.push({ url: link, title: '', headings: [], discoveredFrom: observation.url || url, mission: 'journey' });
          fleet.discoveredByAgents.push(link);
        }
      }
    }
  };
  const runBatch = async batch => {
    const offset = jobs.length;
    const assigned = batch.map((job, index) => ({ ...job, id: `A${String(offset + index + 1).padStart(3, '0')}` }));
    jobs.push(...assigned);
    fleet.jobs.push(...assigned.map(job => ({ ...job, status: 'queued' })));
    await save();
    const batchResults = await pool(assigned, concurrency, async (job, localIndex) => {
      const index = offset + localIndex;
      fleet.jobs[index].status = 'running';
      await onProgress?.({ phase: 'agent', status: 'started', job });
      const workerDir = join(out, 'workers', job.id);
      const missionBrief = {
        journey: 'Exercise the main read-only user journey reachable from this page. Verify observable outcomes.',
        feature_map: 'Scroll through the entire page, inspect sections and reveals, and identify meaningful feature screens for the screenshot team.',
        controls: 'Exercise visible tabs, filters, search, accordions, and other safe controls. Check whether their behavior matches labels and instructions.'
      }[job.mission];
      let result;
      try {
        result = await agent({
          url: job.url, chrome, output: workerDir, model, maxTurns, maxActions, headless, request,
          brief: `${brief}\nAssigned page: ${job.url}\nMission: ${job.mission}. ${missionBrief}\nObserved title: ${job.title}\nObserved headings: ${job.headings.join(' | ')}\nStay focused on this assignment; other workers cover other pages and missions.`
        });
      } catch (error) {
        fleet.jobs[index].status = 'error';
        fleet.jobs[index].error = error.message;
        await save();
        await onProgress?.({ phase: 'agent', status: 'error', job, error: error.message });
        return { error: error.message };
      }
      result.relativeReport = `workers/${job.id}/qa-agent.json`;
      fleet.jobs[index].status = result.report.status;
      fleet.jobs[index].report = result.relativeReport;
      fleet.jobs[index].actionCount = result.report.steps?.length || 0;
      if (result.report.initialObservation) fleet.observations.push({
        screenshot: `workers/${job.id}/screenshots/000-initial.png`, observation: result.report.initialObservation,
        worker: job.id, step: 0, url: result.report.initialObservation.url
      });
      for (const step of result.report.steps || []) {
        if (step.screenshot && step.observation) fleet.observations.push({
          screenshot: `workers/${job.id}/${step.screenshot}`, observation: step.observation,
          worker: job.id, step: step.index, url: step.observation.url
        });
      }
      addDiscovered(result.report);
      await save();
      await onProgress?.({ phase: 'agent', status: result.report.status, job });
      return result;
    });
    results.push(...batchResults);
  };
  if (initialPlan.jobs.length) await runBatch(initialPlan.jobs);
  while (frontier.length && jobs.length < maxAgents) {
    const batch = frontier.splice(0, Math.min(concurrency * 2, maxAgents - jobs.length));
    await runBatch(batch);
  }
  fleet.unassigned.push(...frontier.map(item => item.url));
  const extraPlan = planFleet(crawlReport, maxAgents);
  const extras = extraPlan.jobs.filter(job => job.mission !== 'journey').slice(0, maxAgents - jobs.length);
  if (extras.length) await runBatch(extras);
  const combined = combineAgentReports(crawlReport, jobs, results);
  await saveJson(join(out, 'qa-agent.json'), combined);
  fleet.status = combined.status;
  fleet.finishedAt = new Date().toISOString();
  fleet.coverage = {
    crawledPages: (crawlReport.pages || []).filter(page => page.status === 'visited').length,
    assignedPages: new Set(jobs.map(job => job.url)).size,
    totalAgents: jobs.length,
    completedAgents: combined.workers.filter(worker => worker.status === 'completed').length,
    unassignedPages: fleet.unassigned.length,
    agentDiscoveredPages: fleet.discoveredByAgents.length
  };
  await save();
  return { out, fleet, crawl: crawlReport, agent: combined };
}
