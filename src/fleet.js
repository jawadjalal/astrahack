import { mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism, freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { crawlSite, normalizeLink } from './crawl.js';
import { runQaAgent } from './qa-agent.js';
import { createResponse } from './openai.js';
import { createRunBudget, integerLimit, qaModel } from './qa-runtime.js';

const saveJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');

export function defaultFleetConcurrency(plannedJobs, {
  freeMemoryBytes = freemem(), cpuCount = availableParallelism()
} = {}) {
  const memorySlots = Math.max(3, Math.floor(freeMemoryBytes / (768 * 1024 * 1024)));
  const cpuSlots = Math.max(3, Math.floor(cpuCount / 2));
  return Math.max(3, Math.min(16, plannedJobs, memorySlots, cpuSlots));
}

function validateAgentCeiling(maxAgents) {
  if (maxAgents !== undefined && (!Number.isSafeInteger(maxAgents) || maxAgents < 3)) {
    throw new Error('maxAgents must be an integer of at least 3, or omitted for adaptive allocation');
  }
}

const hasControls = observation => (observation?.controls || []).some(control => !control.href && (
  ['button', 'input', 'textarea', 'select'].includes(control.tag?.toLowerCase()) || control.role === 'button'
));

function pageJob(page, mission) {
  return {
    mission, url: page.finalUrl || page.url,
    title: page.observation?.title || '',
    screenshot: page.screenshot,
    headings: page.observation?.headings?.map(item => item.text).filter(Boolean).slice(0, 8) || [],
    discoveredFrom: page.discoveredFrom || null
  };
}

export function planFleet(crawl, maxAgents) {
  validateAgentCeiling(maxAgents);
  const pages = [...new Map((crawl.pages || [])
    .filter(page => page.status === 'visited' && page.observation && page.screenshot)
    .map(page => [page.finalUrl || page.url, page])).values()];
  const jobs = [];
  if (pages.length) {
    const controls = pages.filter(page => hasControls(page.observation));
    // Three different scouts start useful work immediately, even on a one-page site.
    jobs.push(pageJob(pages[0], 'journey'), pageJob(pages[0], 'feature_map'));
    jobs.push(pageJob(controls[0] || pages[0], controls.length ? 'controls' : 'navigation'));
    jobs.push(...pages.slice(1).map(page => pageJob(page, 'journey')));
    jobs.push(...controls.slice(1).map(page => pageJob(page, 'controls')));
  }
  const selected = jobs.slice(0, maxAgents);
  const covered = new Set(selected.filter(job => job.mission === 'journey').map(job => job.url));
  return {
    jobs: selected.map((job, index) => ({ ...job, id: `A${String(index + 1).padStart(3, '0')}` })),
    unassigned: pages.filter(page => !covered.has(page.finalUrl || page.url)).map(page => page.finalUrl || page.url),
    unscheduledMissions: jobs.slice(selected.length).filter(job => job.mission !== 'journey')
      .map(({ url, mission }) => ({ url, mission }))
  };
}

export function combineAgentReports(crawl, jobs, results, model = qaModel()) {
  const combined = {
    schemaVersion: 1, target: crawl.target, model,
    status: jobs.length ? 'completed' : 'error', initialObservation: crawl.product || null,
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
  url, chrome, output, brief = '', model,
  maxPages = 50, maxDepth = 4, maxAgents, concurrency,
  maxTurns = 20, maxActions = 100, headless = true,
  maxRequests, maxDurationMs = 900000, maxOutputTokens = 8192, signal,
  request = createResponse, crawl = crawlSite, agent = runQaAgent, onProgress
}) {
  if (!url || !chrome || !output) throw new Error('url, chrome, and output are required');
  if (concurrency !== undefined) integerLimit('concurrency', concurrency, 1, 16);
  validateAgentCeiling(maxAgents);
  const agentCeiling = maxAgents ?? Infinity;
  integerLimit('maxTurns', maxTurns, 1, 50);
  integerLimit('maxActions', maxActions, 1, 500);
  model = qaModel(model);
  if (request === createResponse && !process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required before starting the QA fleet');
  const runtime = createRunBudget(request, { maxRequests, maxDurationMs, maxOutputTokens, signal });
  const out = resolve(output);
  await mkdir(out, { recursive: true });
  const startedAt = new Date().toISOString();
  await onProgress?.({ phase: 'crawl', status: 'started' });
  const { report: crawlReport } = await crawl({ url, chrome, output: out, maxPages, maxDepth, headless });
  const fullPlan = planFleet(crawlReport);
  concurrency ??= defaultFleetConcurrency(fullPlan.jobs.length);
  const queue = [...fullPlan.jobs];
  const jobs = [];
  const results = [];
  const origin = new URL(url).origin;
  const knownUrls = new Set(queue.map(job => job.url));
  const knownMissions = new Set(queue.map(job => `${job.mission}:${job.url}`));
  let scoutingPlanned = fullPlan.jobs.some(job => job.mission === 'feature_map');
  const fleet = {
    schemaVersion: 1, target: url, model, startedAt, finishedAt: null,
    limits: { maxPages, maxDepth, maxAgents: maxAgents ?? null, concurrency, maxTurns, maxActions, ...runtime.limits },
    status: 'running', jobs: [], usage: runtime.usage,
    unassigned: [], discoveredByAgents: [], crawlReport: 'crawl.json', agentReport: 'qa-agent.json',
    observations: [...(crawlReport.observations || [])]
  };
  let saveQueue = Promise.resolve();
  const save = () => { saveQueue = saveQueue.then(() => saveJson(join(out, 'fleet.json'), fleet)); return saveQueue; };
  const enqueue = (raw, source, discovered = false) => {
    const link = normalizeLink(raw, source || url, origin);
    if (!link || knownUrls.has(link)) return;
    knownUrls.add(link);
    queue.push({ url: link, title: '', headings: [], discoveredFrom: source || url, mission: 'journey' });
    knownMissions.add(`journey:${link}`);
    if (discovered) fleet.discoveredByAgents.push(link);
  };
  // Discovered-but-unvisited and failed crawl pages remain work, not implied passes.
  for (const link of crawlReport.unvisited || []) enqueue(link, url);
  for (const page of crawlReport.pages || []) if (page.status === 'error') enqueue(page.url, page.discoveredFrom);
  const addDiscovered = report => {
    for (const observation of [report.initialObservation, ...(report.steps || []).map(step => step.observation)].filter(Boolean)) {
      for (const raw of [observation.url, ...(observation.controls || []).map(control => control.href)].filter(Boolean)) enqueue(raw, observation.url, true);
      const observedUrl = normalizeLink(observation.url, url, origin);
      // A failed seed crawl can recover in a journey worker; give that first usable
      // page the same three-scout coverage as a page found by the crawler.
      if (observedUrl && !scoutingPlanned) {
        scoutingPlanned = true;
        for (const mission of ['feature_map', hasControls(observation) ? 'controls' : 'navigation']) {
          knownMissions.add(`${mission}:${observedUrl}`);
          queue.push(pageJob({ url: observedUrl, observation }, mission));
        }
      }
      if (observedUrl && hasControls(observation) && !knownMissions.has(`controls:${observedUrl}`)) {
        knownMissions.add(`controls:${observedUrl}`);
        queue.push(pageJob({ url: observedUrl, observation }, 'controls'));
      }
    }
  };
  const executeJob = async (job, index) => {
    const record = fleet.jobs[index];
    record.status = 'running';
    await onProgress?.({ phase: 'agent', status: 'started', job });
    const missionBrief = {
      journey: 'Exercise the main read-only user journey reachable from this page. Verify observable outcomes.',
      feature_map: 'Scroll through the entire page, inspect sections and reveals, and identify meaningful feature screens for the screenshot team.',
      controls: 'Exercise visible tabs, filters, search, accordions, and other safe controls. Check whether their behavior matches labels and instructions.',
      navigation: 'Audit the site navigation through the UI: inspect menus, header and footer links, open important destinations, and check that navigation labels match the resulting pages. Report discovered routes and broken navigation.'
    }[job.mission];
    try {
      const result = await agent({
        url: job.url, chrome, output: join(out, 'workers', job.id), model, maxTurns, maxActions, headless, request, runtime,
        brief: `${brief}\nAssigned page: ${job.url}\nMission: ${job.mission}. ${missionBrief}\nObserved title: ${job.title}\nObserved headings: ${job.headings.join(' | ')}\nStay focused on this assignment; other workers cover other pages and missions.`
      });
      result.relativeReport = `workers/${job.id}/qa-agent.json`;
      results[index] = result;
      record.status = result.report.status;
      record.error = result.report.error || null;
      record.report = result.relativeReport;
      record.actionCount = result.report.steps?.length || 0;
      if (result.report.initialObservation) fleet.observations.push({
        screenshot: `workers/${job.id}/screenshots/000-initial.png`, observation: result.report.initialObservation,
        worker: job.id, step: 0, url: result.report.initialObservation.url
      });
      for (const step of result.report.steps || []) if (step.screenshot && step.observation) fleet.observations.push({
        screenshot: `workers/${job.id}/${step.screenshot}`, observation: step.observation,
        worker: job.id, step: step.index, url: step.observation.url
      });
      addDiscovered(result.report);
    } catch (error) {
      record.status = 'error';
      record.error = error.message;
      results[index] = { error: error.message };
    }
    await save();
    await onProgress?.({ phase: 'agent', status: record.status, job, error: record.error });
    return index;
  };
  await save();
  // Refill each free slot immediately; every mission can add routes to the shared frontier.
  const active = new Map();
  let stopped = false;
  while (active.size || (!stopped && jobs.length < agentCeiling && queue.length)) {
    while (!stopped && active.size < concurrency && jobs.length < agentCeiling && queue.length) {
      try { runtime.check(); } catch (error) { fleet.stopReason = error.message; stopped = true; break; }
      const next = queue.shift();
      const index = jobs.length;
      const job = { ...next, id: `A${String(index + 1).padStart(3, '0')}` };
      jobs.push(job);
      fleet.jobs.push({ ...job, status: 'queued' });
      active.set(index, executeJob(job, index).catch(error => {
        fleet.jobs[index].status = 'error'; results[index] = { error: error.message }; return index;
      }));
    }
    if (!active.size) break;
    const finished = await Promise.race(active.values());
    active.delete(finished);
  }
  fleet.unassigned = [...new Set(queue.filter(job => job.mission === 'journey').map(job => job.url))];
  fleet.unscheduledMissions = queue.filter(job => job.mission !== 'journey').map(({ url: pageUrl, mission }) => ({ url: pageUrl, mission }));
  const combined = combineAgentReports(crawlReport, jobs, results, model);
  const crawlErrors = (crawlReport.pages || []).filter(page => page.status === 'error').map(page => page.url);
  const hasGaps = fleet.unassigned.length || fleet.unscheduledMissions.length || crawlErrors.length || fleet.stopReason;
  fleet.status = combined.status === 'completed' && hasGaps ? 'partial' : combined.status;
  combined.status = fleet.status;
  combined.usage = runtime.usage;
  if (hasGaps) combined.limitations.push('Fleet coverage is incomplete; see fleet.json for unassigned routes, unscheduled missions, and crawl errors.');
  fleet.finishedAt = new Date().toISOString();
  fleet.coverage = {
    crawledPages: (crawlReport.pages || []).filter(page => page.status === 'visited').length,
    assignedPages: new Set(jobs.map(job => job.url)).size,
    totalAgents: jobs.length,
    completedAgents: combined.workers.filter(worker => worker.status === 'completed').length,
    unassignedPages: fleet.unassigned.length,
    unscheduledMissions: fleet.unscheduledMissions.length,
    crawlErrors,
    agentDiscoveredPages: fleet.discoveredByAgents.length
  };
  await saveJson(join(out, 'qa-agent.json'), combined);
  await save();
  return { out, fleet, crawl: crawlReport, agent: combined };
}
