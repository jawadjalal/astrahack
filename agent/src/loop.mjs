// The teardown loop: observe -> model -> act -> log, streaming every step to the canvas,
// followed by a VERIFY pass that replays each finding from a fresh start.

import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { FindingStore, Coverage, boxAroundPoint } from './findings.mjs';
import { normalizeAction, substituteSecrets, describeAction, describeBatch, pointOf, MAX_ACTIONS_PER_BATCH } from './actions.mjs';
import { explorePrompt, exploreFunctionTools, VERIFY_PROMPT, VERIFY_FUNCTION_TOOLS, verifyTask } from './prompt.mjs';
import { StopError } from './stop.mjs';
import { LAYOUT, PITCH } from './canvas.mjs';
import { writeReports } from './report.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const dataUrl = shot => `data:${shot.mime || 'image/jpeg'};base64,${shot.buffer.toString('base64')}`;
const pad = (n, w = 3) => String(n).padStart(w, '0');
const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export function identityHint(env = process.env) {
  const have = ['AGENT_TEST_EMAIL', 'AGENT_TEST_PASSWORD'].every(k => env[k]);
  return have
    ? 'a throwaway test identity is configured. Type {{TEST_EMAIL}} and {{TEST_PASSWORD}} (also {{TEST_NAME}}, {{TEST_PHONE}} if configured) wherever the product asks; the harness substitutes the real values.'
    : 'none configured (AGENT_TEST_EMAIL / AGENT_TEST_PASSWORD are unset). You may still type the placeholders, but they will be empty: if signup or login is required, record it as unreachable coverage instead of inventing credentials.';
}

export async function runTeardown({
  target, brief = '', backend, canvas, stop, inbox, recorder, outDir, sessionFactory,
  maxSteps = 40, maxMinutes = 20, verify = { enabled: true, steps: 8, maxFindings: 6 },
  ackSafetyChecks = false, includeDesign = false, env = process.env, log = () => {}, model = 'unknown', backendName = backend.name
}) {
  await mkdir(join(outDir, 'screenshots'), { recursive: true });
  const eventsFile = join(outDir, 'events.jsonl');
  const emit = (type, data = {}) => appendFile(eventsFile, JSON.stringify({ t: new Date().toISOString(), type, ...data }) + '\n').catch(() => {});

  const findings = new FindingStore({ includeDesign });
  const coverage = new Coverage();
  const report = {
    schemaVersion: 1, kind: 'astrahack.teardown', target, brief, backend: backendName, model,
    startedAt: new Date().toISOString(), finishedAt: null, status: 'running', stopReason: null,
    coldOpen: null, summary: null, timeToValue: null, steps: [], stateTracking: [], humanSteers: [],
    limitations: [], usage: null, error: null
  };
  const deadline = Date.now() + maxMinutes * 60 * 1000;
  const state = { counter: 0, latest: null, thoughtSlots: new Map(), noteSlots: new Map(), batches: 0, actionsExecuted: 0, startUrl: null };
  const sessionsUsed = [];
  const makeSession = (kind, options) => { const s = sessionFactory(kind, options); sessionsUsed.push(s); return s; };

  const saveShot = async (shot, name) => {
    const path = join(outDir, 'screenshots', `${name}.jpg`);
    await writeFile(path, shot.buffer);
    return relative(outDir, path);
  };

  const seeing = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await backend.screenshot(); } catch (error) { if (attempt) throw error; await sleep(400); }
    }
  };

  // Record + stream one observed screen. ctx: {phase,row,key,n,label,arrowLabel,thought,pointer,prev}
  const registerStep = async (shot, c) => {
    const index = ++state.counter;
    const file = await saveShot(shot, `${c.phase === 'verify' ? `verify-${c.findingId}` : 'step'}-${pad(c.n)}`);
    const st = await backend.state?.() ?? {};
    const entry = {
      index, n: c.n, phase: c.phase, ...(c.findingId ? { findingId: c.findingId } : {}), canvasId: c.key,
      thought: c.thought || '', actions: c.actions || [], errors: c.errors || [], screenshot: file,
      url: st.url ?? null, title: st.title ?? null, timestamp: recorder?.now() ?? null, at: new Date().toISOString()
    };
    report.steps.push(entry);
    if (c.phase === 'explore' && st.url) coverage.noteUrl(st.url, c.n);
    state.latest = { n: c.n, key: c.key, row: c.row, shot, file, phase: c.phase, findingId: c.findingId, entry, url: st.url };
    canvas.addStep({
      n: c.n, row: c.row, key: c.key, shot,
      label: c.n === 0 ? `${c.phase === 'verify' ? 'Replay start' : 'Cold open'}${st.title ? ' · ' + st.title : ''}` : (st.title || st.url || ''),
      thought: c.thought, arrowLabel: c.arrowLabel, prev: c.prev, prevN: c.prevN, pointer: c.pointer, prevShot: c.prevShot
    });
    emit('step', { ...entry, size: { w: shot.width, h: shot.height } });
    log(`step ${c.phase === 'verify' ? c.findingId + ' ' : ''}${c.n}: ${c.actions?.length ? c.actions.join(', ') : 'initial view'}${c.errors?.length ? `  [! ${c.errors.join('; ')}]` : ''}`);
    return entry;
  };

  // ---------- executing one computer_call batch ----------
  const executeBatch = async (call, c) => {
    const before = state.latest;
    const scale = before.shot.scale ?? 1;
    const described = [];
    const errors = [];
    let pointer = null;
    const raws = call.actions.slice(0, MAX_ACTIONS_PER_BATCH);
    if (call.actions.length > MAX_ACTIONS_PER_BATCH) errors.push(`only the first ${MAX_ACTIONS_PER_BATCH} actions of the batch were run`);
    let executed = 0;
    for (const raw of raws) {
      stop.check();
      let action;
      try {
        action = normalizeAction(raw);
      } catch (error) { errors.push(`bad action: ${error.message}`); break; }
      described.push(describeAction(action));
      if (!pointer) pointer = pointOf(action);
      try {
        let toRun = action;
        if (action.type === 'type') {
          const sub = substituteSecrets(action.text, env);
          toRun = { ...action, text: sub.text };
        }
        await backend.execute(toRun, { scale });
        executed++; state.actionsExecuted++;
        await emit('action', { phase: c.phase, action: describeAction(action) });
      } catch (error) {
        if (error instanceof StopError) throw error;
        errors.push(`${describeAction(action)} failed: ${error.message}`);
        break;
      }
    }
    const settled = await backend.settle?.() ?? { notes: [] };
    const notes = [...(settled.notes || [])];
    if (errors.length) notes.push(`Harness notes: ${errors.join('; ')}.`);
    const shot = await seeing();
    const n = c.nextN();
    await registerStep(shot, {
      phase: c.phase, findingId: c.findingId, row: c.row, key: c.keyFor(n), n, thought: c.thought,
      arrowLabel: short(described.join(', ') || 'look', 48), actions: described, errors,
      prev: before.key, prevN: before.n, pointer, prevShot: before.shot
    });
    return { callId: call.callId, imageDataUrl: dataUrl(shot), note: notes.join(' ') || undefined, executed, notes };
  };

  // ---------- drive one model session until it finishes or the budget ends ----------
  const drive = async ({ session, first, budget, phase, findingId, row, handlers, steerable }) => {
    let n = 0;
    const phaseCtx = {
      phase, findingId, row, nextN: () => ++n,
      keyFor: k => (phase === 'verify' ? `${canvas.idPrefix}verify-${findingId}-${k}` : canvas.stepId(k)),
      thought: ''
    };
    let batches = 0;
    let executedHere = 0;
    let turn = await session.send(first);
    for (;;) {
      stop.check();
      if (Date.now() > deadline) { stop.trigger(`time limit (${maxMinutes} min)`); stop.check(); }
      phaseCtx.thought = turn.thoughts.join(' ');
      if (phaseCtx.thought) { emit('thought', { phase, text: phaseCtx.thought }); log(`  thought: ${short(phaseCtx.thought, 140)}`); }

      const functionOutputs = [];
      let done = null;
      for (const fc of turn.functionCalls) {
        const handler = handlers[fc.name];
        let output;
        if (!handler) output = { error: `unknown tool ${fc.name}` };
        else {
          try {
            const r = await handler(fc.args, phaseCtx);
            output = r.output;
            if (r.done) done = r;
          } catch (error) { output = { error: error.message }; }
        }
        functionOutputs.push({ callId: fc.callId, output });
      }
      if (done) return { reason: done.reason, data: done.data, executed: executedHere, usage: session.usage };

      const computerOutputs = [];
      let exhausted = false;
      const harnessNotes = [];
      for (const call of turn.computerCalls) {
        if (call.pendingSafetyChecks?.length && !ackSafetyChecks) {
          const msg = call.pendingSafetyChecks.map(s => s.message || s.code).join('; ');
          emit('safety_check', { checks: call.pendingSafetyChecks });
          stop.trigger(`OpenAI safety check needs a human: ${msg}`);
          stop.check();
        }
        if (batches >= budget) { exhausted = true; break; }
        const out = await executeBatch(call, phaseCtx);
        if (call.pendingSafetyChecks?.length) out.acknowledgedSafetyChecks = call.pendingSafetyChecks;
        batches++; executedHere += out.executed;
        if (phase === 'explore') state.batches++;
        computerOutputs.push({ ...out, viaFunction: call.viaFunction });
      }
      if (exhausted) return { reason: 'budget', executed: executedHere, usage: session.usage };

      const userTexts = [];
      if (steerable) {
        for (const text of inbox.drain()) {
          userTexts.push(text);
          report.humanSteers.push({ text: text.replace(/^HUMAN STEER: /, ''), atStep: state.latest?.n, at: new Date().toISOString() });
          const L = state.latest;
          const { x, y } = canvas.stepXY(L.n, L.row);
          canvas.addNote(`steer-${report.humanSteers.length}`, x, y - 260, text.replace(/^HUMAN STEER: /, 'HUMAN: '), 'violet');
          canvas.say(text.replace(/^HUMAN STEER: /, 'Human steer: '));
          emit('steer', { text });
        }
      }
      if (!turn.computerCalls.length && !turn.functionCalls.length) {
        if (turn.finalText) return { reason: 'model_ended', data: { text: turn.finalText }, executed: executedHere, usage: session.usage };
        userTexts.push('Continue: use the computer tool to keep going, or call the finishing tool if you are done.');
      }
      turn = await session.send({ computerOutputs, functionOutputs, userTexts });
    }
  };

  // ---------- explore-phase tool handlers ----------
  const exploreHandlers = {
    record_cold_open: async args => {
      report.coldOpen = { what_it_is: args.what_it_is, who_for: args.who_for, primary_action: args.primary_action, unclear: args.unclear };
      const { x, y } = canvas.stepXY(0, 0);
      const h = canvas.sizes.get(canvas.stepId(0))?.h ?? 325;
      canvas.addNote('coldopen', x, y + h + 40 + 230, `COLD OPEN: ${args.what_it_is} For: ${args.who_for}. Main CTA: ${args.primary_action}.${args.unclear ? ' Unclear: ' + args.unclear : ''}`, 'green');
      emit('cold_open', report.coldOpen);
      return { output: { ok: true } };
    },
    record_finding: async (args, c) => {
      const L = state.latest;
      const st = await backend.state?.() ?? {};
      const { finding, duplicate } = findings.add(args, {
        stepIndex: L.n, screenshot: L.file, timestamp: L.entry.timestamp ?? recorder?.now() ?? null,
        startUrl: state.startUrl, size: { width: L.shot.width, height: L.shot.height }
      });
      if (!duplicate) {
        canvas.addFinding(finding, { stepKey: L.key, row: L.row, n: L.n });
        emit('finding', finding);
        log(`  FINDING ${finding.id} [${finding.severity}] ${finding.title}`);
      }
      return { output: { id: finding.id, status: duplicate ? 'duplicate_of_existing' : 'recorded_unverified', note: 'Keep exploring; every finding is replayed from a fresh start in the verify pass.', current_url: st.url } };
    },
    track_state: async args => {
      const prior = [...report.stateTracking].reverse().find(s => s.label.toLowerCase() === String(args.label).toLowerCase());
      const entry = { label: String(args.label), value: String(args.value), context: String(args.context || ''), stepIndex: state.latest?.n ?? 0, previous: prior?.value ?? null, changed: prior ? prior.value !== String(args.value) : null };
      report.stateTracking.push(entry);
      const L = state.latest;
      const slot = state.noteSlots.get(L.key) ?? 0;
      state.noteSlots.set(L.key, slot + 1);
      const { x, y } = canvas.stepXY(L.n, L.row);
      const h = canvas.sizes.get(L.key)?.h ?? 325;
      canvas.addNote(`state-${report.stateTracking.length}`, x, y + h + 40 + 230 * (slot + 1) + 230, `${entry.label}: ${entry.value}${prior ? ` (was ${prior.value})` : ''} - ${short(entry.context, 80)}`, 'blue');
      emit('state', entry);
      return { output: { recorded: true, previous_value: prior?.value ?? null, changed: entry.changed, hint: prior ? (entry.changed ? 'Value changed: is that what the action should have caused?' : 'Value unchanged: did the action have an effect it should have?') : 'First reading.' } };
    },
    note_coverage: async args => {
      coverage.note({ screen: args.screen, status: args.status, detail: args.detail, stepIndex: state.latest?.n ?? null });
      return { output: { ok: true } };
    },
    finish: async args => {
      report.summary = args.summary; report.timeToValue = args.time_to_value;
      return { done: true, reason: 'finish', data: args, output: { ok: true } };
    }
  };

  // ======================================================================
  let finalizeError = null;
  try {
    await backend.open();
    const first = await seeing();
    const st0 = await backend.state?.() ?? {};
    state.startUrl = st0.url || backend.startUrl || null;
    report.target = report.target || state.startUrl;
    await recorder?.start();
    await registerStep(first, { phase: 'explore', row: 0, key: canvas.stepId(0), n: 0, thought: '', actions: [] });

    const sessionExplore = makeSession('explore', {
      instructions: explorePrompt({ target, brief, maxSteps, identityHint: identityHint(env), backend: backendName, includeDesign }),
      functionTools: exploreFunctionTools({ includeDesign })
    });
    emit('start', { target, backend: backendName, model, maxSteps });
    const explored = await drive({
      session: sessionExplore, budget: maxSteps, phase: 'explore', row: 0, steerable: true, handlers: exploreHandlers,
      first: { text: `Begin the teardown of ${target}. This is the current screen (step 0). ${brief ? 'Operator brief: ' + brief : ''} Start with the cold open.`, screenshotDataUrl: dataUrl(first) }
    });
    report.exploreEnded = explored.reason;
    if (explored.reason === 'model_ended') report.summary = report.summary || explored.data?.text || null;
    if (explored.reason === 'budget') report.limitations.push(`Step budget (${maxSteps}) reached before the model called finish.`);
    log(`explore phase ended: ${explored.reason} after ${state.batches} action batches, ${findings.items.length} findings`);

    // ---------- VERIFY pass ----------
    if (verify.enabled && findings.items.length && !stop.stopped) {
      const queue = findings.toVerify(verify.maxFindings);
      for (const f of findings.items) if (!queue.includes(f)) findings.markSkipped(f.id, `not replayed: over the --max-verify cap (${verify.maxFindings})`);
      let row = 0;
      for (const f of queue) {
        if (stop.stopped) { findings.markSkipped(f.id, `not replayed: run stopped (${stop.reason})`); continue; }
        row++;
        const key = n => `${canvas.idPrefix}verify-${f.id}-${n}`;
        log(`VERIFY ${f.id}: ${f.title}`);
        try {
          await backend.reset();
          await backend.settle?.();
          const start = await seeing();
          state.latest = null;
          const startEntry = await registerStep(start, { phase: 'verify', findingId: f.id, row, key: key(0), n: 0, thought: `Replaying ${f.id}: ${f.title}`, actions: [] });
          const session = makeSession('verify', { instructions: VERIFY_PROMPT, functionTools: VERIFY_FUNCTION_TOOLS });
          let confirm = null;
          const result = await drive({
            session, budget: verify.steps, phase: 'verify', findingId: f.id, row, steerable: false,
            handlers: {
              confirm_finding: async args => {
                confirm = args;
                return { done: true, reason: 'confirmed', data: args, output: { ok: true } };
              }
            },
            first: { text: verifyTask(f, state.startUrl), screenshotDataUrl: dataUrl(start) }
          });
          const last = state.latest;
          const replay = { actionsExecuted: result.executed, screenshot: last.file, screenshotUrl: null, stepIndex: last.n, timestamp: last.entry.timestamp };
          if (confirm) {
            findings.applyVerification(f.id, { reproduced: !!confirm.reproduced, observation: confirm.observation }, replay);
            f.verification.canvasId = last.key;
          } else {
            findings.applyVerification(f.id, { inconclusive: true, observation: `replay ended without a verdict (${result.reason})` }, replay);
            f.verification.canvasId = last.key;
          }
          canvas.updateFinding(f);
          canvas.linkFindingToReplay(f, last.key);
          log(`  ${f.id} verified=${f.verified} (${f.verification.status})`);
          emit('verify', { id: f.id, verified: f.verified, verification: f.verification });
        } catch (error) {
          if (error instanceof StopError) { findings.markSkipped(f.id, `verification interrupted: ${error.reason}`); break; }
          findings.markSkipped(f.id, `verification error: ${error.message}`);
          log(`  verify ${f.id} failed: ${error.message}`);
        }
      }
    } else if (!verify.enabled) {
      for (const f of findings.items) findings.markSkipped(f.id, 'verification disabled (--no-verify)');
    } else {
      for (const f of findings.items) findings.markSkipped(f.id, `not replayed: run stopped (${stop.reason})`);
    }
  } catch (error) {
    if (error instanceof StopError) {
      report.status = 'stopped'; report.stopReason = error.reason;
      for (const f of findings.items) findings.markSkipped(f.id, `not replayed: run stopped (${error.reason})`);
    } else {
      report.status = 'error'; report.error = error.message; finalizeError = error;
      log(`ERROR: ${error.message}`);
      for (const f of findings.items) findings.markSkipped(f.id, `not replayed: run errored`);
    }
  }

  // ---------- finalize ----------
  if (report.status === 'running') report.status = stop.stopped ? 'stopped' : 'completed';
  if (stop.stopped) { report.stopReason = stop.reason; if (report.status === 'completed') report.status = 'stopped'; }
  report.finishedAt = new Date().toISOString();
  const lastN = state.counter ? Math.max(...report.steps.filter(s => s.phase === 'explore').map(s => s.n), 0) : 0;
  const videoPath = await recorder?.stop().catch(() => null);
  report.video = videoPath ? { path: relative(outDir, videoPath) } : null;
  if (inbox.pending) report.limitations.push(`${inbox.pending} steering message(s) arrived after exploration ended and were not applied.`);
  report.findings = findings.sorted();
  report.rejectedFindings = findings.rejected;
  report.includeDesign = includeDesign;
  report.counts = findings.counts();
  report.coverage = coverage.toJSON();
  if (!report.coverage.unreachable.length) report.limitations.push('No screens were reported as unreachable; absence of an entry is not proof of full coverage.');

  const sumX = (lastN + 1) * PITCH;
  const c = report.counts;
  canvas.addNote('summary', sumX, 0, `TEARDOWN SUMMARY\n${report.summary ? short(report.summary, 260) : report.status}\nFindings: ${c.total} (${c.verified} verified, ${c.critical} critical, ${c.high} high)\nCoverage: ${report.coverage.visited.length} visited, ${report.coverage.unreachable.length} unreachable`, 'green');
  if (videoPath) await canvas.addVideo({ path: videoPath, x: sumX, y: 300, label: 'Screen recording of the run' });
  canvas.ops([{ type: 'focus' }], 'focus all');
  await canvas.flush();
  for (const f of report.findings) {
    f.screenshotUrl = canvas.urls.get(canvas.stepId(f.stepIndex)) ?? null;
    if (f.verification?.canvasId) f.verification.screenshotUrl = canvas.urls.get(f.verification.canvasId) ?? null;
  }
  report.canvas = { url: canvas.base, enabled: canvas.enabled && !canvas.dryRun, opsPosted: canvas.posted.length, errors: canvas.errors, video: canvas.videoUrl ?? null };
  report.usage = sessionsUsed.reduce((a, x) => ({ requests: a.requests + (x.usage?.requests || 0), input_tokens: a.input_tokens + (x.usage?.input || 0), output_tokens: a.output_tokens + (x.usage?.output || 0) }), { requests: 0, input_tokens: 0, output_tokens: 0 });
  await writeReports(outDir, report);
  emit('end', { status: report.status });
  report.outDir = outDir;
  if (finalizeError && !report.steps.length) throw finalizeError;
  return report;
}
