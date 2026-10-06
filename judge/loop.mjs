// The judge loop: score every hook and script, rewrite whatever is under the threshold, re-score, repeat.
// A rewrite only lands if it scores higher AND the plan still passes checkGrounding + validatePlan.
import { checkGrounding } from '../ugc/schema.js';
import { validatePlan, contractPart } from '../ugc/validate.mjs';
import { CRITERIA, productFacts, scoreHook, scoreScript, rewriteHook, rewriteScript, HOOK_MAX_WORDS, words } from './heuristic.mjs';
import { modelScore, modelRewrite, MODEL } from './model.mjs';

const r1 = (n) => Math.round(n * 10) / 10;
const avg = (xs) => r1(xs.reduce((a, b) => a + b, 0) / (xs.length || 1));
const scriptText = (s) => s.beats.map((b) => b.voiceover).join(' / ');
const valid = (plan) => [...checkGrounding(contractPart(plan)), ...validatePlan(plan)];

function heuristicScorer(facts) {
  return async (plan, items) => new Map(items.map((i) => {
    const r = i.kind === 'hook' ? scoreHook(i.item, facts) : scoreScript(i.item, facts, plan.hooks.find((h) => h.id === i.item.hookId)?.text);
    return [i.id, r];
  }));
}
function modelScorer(opts) {
  return async (plan, items) => {
    const got = await modelScore(plan, items.map((i) => ({ id: i.id, kind: i.kind, text: i.kind === 'hook' ? i.item.text : scriptText(i.item) })), opts);
    return new Map(items.map((i) => {
      const g = got.get(i.id);
      const scores = Object.fromEntries(CRITERIA.map((k) => [k, Math.max(0, Math.min(10, Number(g?.scores?.[k] ?? 0)))]));
      let overall = r1(CRITERIA.reduce((a, k) => a + scores[k], 0) / CRITERIA.length);
      if (i.kind === 'hook' && words(i.item.text) > HOOK_MAX_WORDS) overall = Math.min(overall, 4); // hard rule, not the model's call
      return [i.id, { scores, overall, rationale: g?.rationale || 'no rationale returned' }];
    }));
  };
}

/**
 * @param {object} plan  wrapped ugc-plan.json
 * @param {{rounds?:number, threshold?:number, mock?:boolean, apiKey?:string, request?:Function, fetchImpl?:Function, log?:Function}} opts
 */
export async function judgePlan(plan, { rounds = 2, threshold = 8, mock = false, apiKey, request, fetchImpl, log = () => {} } = {}) {
  const startProblems = valid(plan);
  if (startProblems.length) throw new Error(`input plan is not valid: ${startProblems.slice(0, 3).join('; ')}`);
  const useModel = !mock && Boolean(apiKey || request);
  const facts = productFacts(plan);
  const score = useModel ? modelScorer({ apiKey, request, fetchImpl }) : heuristicScorer(facts);
  let cur = structuredClone(plan);
  const items = () => [...cur.hooks.map((h) => ({ id: h.id, kind: 'hook', item: h })), ...cur.scripts.map((s) => ({ id: s.id, kind: 'script', item: s }))];
  const history = new Map(); // id -> versions [{round, text, overall, scores, rationale}]
  const record = (i, r, round) => {
    const list = history.get(i.id) || [];
    list.push({ round, text: i.kind === 'hook' ? i.item.text : scriptText(i.item), overall: r.overall, scores: r.scores, rationale: r.rationale });
    history.set(i.id, list);
  };
  let scores = await score(cur, items());
  for (const i of items()) record(i, scores.get(i.id), 0);

  const tried = new Map();
  const templates = new Map();
  let roundsRun = 0;
  for (let round = 1; round <= rounds; round++) {
    const low = items().filter((i) => scores.get(i.id).overall < threshold);
    if (!low.length) break;
    roundsRun = round;
    log(`round ${round}: rewriting ${low.length} item(s) under ${threshold}`);
    const next = structuredClone(cur);
    let modelOut = null;
    if (useModel) {
      try { modelOut = await modelRewrite(cur, low.map((i) => ({ id: i.id, kind: i.kind, text: i.kind === 'hook' ? i.item.text : scriptText(i.item), rationale: scores.get(i.id).rationale })), { apiKey, request, fetchImpl }); }
      catch (e) { log(`model rewrite failed (${e.message}); using the heuristic rewriter this round`); }
    }
    const used = new Set(next.hooks.map((h) => h.text));
    for (const i of low.filter((x) => x.kind === 'hook')) {
      const avoid = tried.get(i.id) || new Set([i.item.text]);
      const m = modelOut?.hooks?.find((h) => h.id === i.id);
      const cand = m && words(m.text) <= HOOK_MAX_WORDS ? { ...i.item, text: m.text, visualOpener: m.visualOpener || i.item.visualOpener } : rewriteHook(i.item, facts, { avoid, used, templates });
      if (!cand) continue;
      avoid.add(cand.text); tried.set(i.id, avoid); used.add(cand.text);
      Object.assign(next.hooks.find((h) => h.id === i.id), cand);
    }
    // scripts follow their hook, then fix their own beats
    for (const s of next.scripts) {
      const hook = next.hooks.find((h) => h.id === s.hookId);
      const isLow = low.some((x) => x.id === s.id);
      const hookChanged = hook && hook.text !== cur.hooks.find((h) => h.id === s.hookId)?.text;
      if (!isLow && !hookChanged) continue;
      const m = modelOut?.scripts?.find((x) => x.id === s.id);
      const base = m && m.beats.length === s.beats.length ? { ...s, beats: s.beats.map((b, k) => ({ ...b, ...m.beats[k] })) } : s;
      Object.assign(s, m && m.beats.length === s.beats.length ? base : rewriteScript(s, facts, hook?.text));
      if (hook && s.beats[0]) { s.beats[0].voiceover = hook.text; s.beats[0].onScreenText = hook.text; }
    }
    const problems = valid(next);
    if (problems.length) { log(`round ${round}: rewrite broke the plan (${problems[0]}), keeping the previous version`); continue; }
    const nextScores = await score(next, items().map((i) => ({ ...i, item: (i.kind === 'hook' ? next.hooks : next.scripts).find((x) => x.id === i.id) })));
    // keep each change only if it scored higher (a hook's script rides along with it)
    for (const h of next.hooks) {
      const before = scores.get(h.id), after = nextScores.get(h.id);
      const same = h.text === cur.hooks.find((x) => x.id === h.id).text;
      if (same) continue;
      if (after.overall > before.overall) record({ id: h.id, kind: 'hook', item: h }, after, round);
      else Object.assign(h, cur.hooks.find((x) => x.id === h.id));
    }
    for (const s of next.scripts) {
      const prev = cur.scripts.find((x) => x.id === s.id);
      if (JSON.stringify(prev) === JSON.stringify(s)) continue;
      const hookKept = next.hooks.find((h) => h.id === s.hookId)?.text === s.beats[0]?.voiceover;
      if (hookKept && nextScores.get(s.id).overall > scores.get(s.id).overall) record({ id: s.id, kind: 'script', item: s }, nextScores.get(s.id), round);
      else Object.assign(s, prev);
    }
    if (valid(next).length) continue;
    cur = next;
    scores = await score(cur, items());
  }

  const versions = Object.fromEntries(history);
  const rows = items().map((i) => {
    const v = versions[i.id];
    return { id: i.id, kind: i.kind, before: v[0].overall, after: v[v.length - 1].overall, rewritten: v.length > 1, versions: v };
  });
  const hooks = rows.filter((r) => r.kind === 'hook'), scripts = rows.filter((r) => r.kind === 'script');
  cur.judge = { judge: useModel ? MODEL : 'heuristic', rounds: roundsRun, threshold, at: new Date().toISOString() };
  const summary = {
    judge: useModel ? MODEL : 'heuristic', threshold, roundsRun,
    hooks: { before: avg(hooks.map((r) => r.before)), after: avg(hooks.map((r) => r.after)), rewritten: hooks.filter((r) => r.rewritten).length },
    scripts: { before: avg(scripts.map((r) => r.before)), after: avg(scripts.map((r) => r.after)), rewritten: scripts.filter((r) => r.rewritten).length },
    stillBelow: rows.filter((r) => r.after < threshold).map((r) => r.id),
    valid: valid(cur).length === 0,
  };
  return { plan: cur, report: { kind: 'astrahack.ugc-judge', rubric: CRITERIA, summary, items: rows } };
}

export function formatTable({ summary, items }) {
  const line = (r) => {
    const delta = r.after - r.before;
    const mark = r.rewritten ? `  +${delta.toFixed(1)}  rewritten x${r.versions.length - 1}` : r.after >= summary.threshold ? '  kept' : '  kept (no better rewrite)';
    return `  ${r.id.padEnd(4)} ${r.before.toFixed(1).padStart(4)} → ${r.after.toFixed(1).padEnd(4)}${mark}`;
  };
  const out = [`Judge (${summary.judge}, threshold ${summary.threshold}, ${summary.roundsRun} round(s))`, 'HOOKS'];
  for (const r of items.filter((x) => x.kind === 'hook')) {
    out.push(line(r));
    if (r.rewritten) out.push(`         "${r.versions[0].text}"\n      →  "${r.versions[r.versions.length - 1].text}"`);
  }
  out.push('SCRIPTS');
  for (const r of items.filter((x) => x.kind === 'script')) out.push(line(r));
  out.push(`AVERAGE  hooks ${summary.hooks.before.toFixed(1)} → ${summary.hooks.after.toFixed(1)} (${summary.hooks.rewritten} rewritten)   scripts ${summary.scripts.before.toFixed(1)} → ${summary.scripts.after.toFixed(1)} (${summary.scripts.rewritten} rewritten)`);
  out.push(`plan still valid (checkGrounding + validatePlan): ${summary.valid ? 'yes' : 'NO'}${summary.stillBelow.length ? `   still under ${summary.threshold}: ${summary.stillBelow.join(', ')}` : ''}`);
  return out.join('\n');
}
