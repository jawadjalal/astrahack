// Grounding enforcement. The model is asked to cite only observed feature ids and captured assets,
// but nothing is trusted: this stage rewrites or drops anything that points at something the run
// did not observe, records each change, and flags figures that no page ever showed.
import { FIGURE_RE, normFigure } from './extract.mjs';

const tokens = (text) => new Set(String(text).toLowerCase().match(/[a-z0-9£$€]{4,}/g) || []);
const overlap = (a, b) => { let n = 0; for (const t of a) if (b.has(t)) n++; return n; };
const hms = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

/** Combine the model's creative output with the evidence the planner extracted itself. */
export function assemble(modelOut, observed) {
  const { name, oneLiner, category, whoItsFor } = modelOut.product;
  return {
    ...modelOut,
    product: {
      name, oneLiner, category, whoItsFor,
      observedFeatures: observed.features.map(({ id, name: n, whatItDoes, evidence }) => ({ id, name: n, whatItDoes, evidence: [...evidence] })),
      frictionFromQa: [...observed.friction],
    },
  };
}

/**
 * Repair claims that reference unknown ids or assets.
 * @returns {{ plan: object, repairs: string[], flaggedFigures: number }}
 */
export function repairPlan(input, observed, { maxScripts = 5 } = {}) {
  const plan = structuredClone(input);
  const repairs = [];
  const note = (m) => repairs.push(m);
  const featureById = new Map(observed.features.map((f) => [f.id, f]));
  const assetPaths = new Set(observed.assets.map((a) => a.path));
  const assetByName = new Map();
  for (const a of observed.assets) { const b = a.path.split('/').pop(); assetByName.set(b, assetByName.has(b) ? null : a.path); }

  const normId = (id) => { const m = String(id).trim().match(/^F\d+/i); return m ? m[0].toUpperCase() : id; };
  const cleanIds = (ids, label) => {
    const mapped = [...new Set(ids.map(normId))];
    const dropped = mapped.filter((id) => !featureById.has(id));
    if (dropped.length) note(`${label}: removed feature id(s) the run never observed: ${dropped.join(', ')}.`);
    return mapped.filter((id) => featureById.has(id));
  };
  const bestFeature = (text) => {
    const t = tokens(text);
    let best = null, score = 0;
    for (const f of observed.features) {
      const s = overlap(t, tokens([f.name, ...f.facts.map((x) => x.text), f.headings.join(' ')].join(' ')));
      if (s > score) { best = f; score = s; }
    }
    return best;
  };

  // Angles
  const audienceIds = new Set(plan.audiences.map((a) => a.id));
  plan.angles = plan.angles.filter((angle) => {
    if (!audienceIds.has(angle.audienceId) && plan.audiences.length) {
      note(`angle ${angle.id}: unknown audience ${angle.audienceId}, reassigned to ${plan.audiences[0].id}.`);
      angle.audienceId = plan.audiences[0].id;
    }
    angle.featureIds = cleanIds(angle.featureIds, `angle ${angle.id}`);
    if (!angle.featureIds.length) {
      const guess = bestFeature(`${angle.name} ${angle.insight} ${angle.whyItWorks}`);
      if (!guess) { note(`angle ${angle.id}: cited no observed feature and matched none by text, so it was dropped.`); return false; }
      note(`angle ${angle.id}: cited no observed feature, attached the closest match ${guess.id} (${guess.name}).`);
      angle.featureIds = [guess.id];
    }
    return true;
  });
  const angleIds = new Set(plan.angles.map((a) => a.id));

  // Hooks
  plan.hooks = plan.hooks.filter((h) => {
    if (angleIds.has(h.angleId)) return true;
    note(`hook ${h.id}: unknown angle ${h.angleId}, dropped.`);
    return false;
  });
  const hookById = new Map(plan.hooks.map((h) => [h.id, h]));

  // Scripts
  const creatorIds = new Set(plan.creators.map((c) => c.id));
  plan.scripts = plan.scripts.filter((s) => {
    if (!angleIds.has(s.angleId)) {
      const viaHook = hookById.get(s.hookId);
      if (viaHook) { note(`script ${s.id}: unknown angle ${s.angleId}, took ${viaHook.angleId} from its hook.`); s.angleId = viaHook.angleId; }
      else { note(`script ${s.id}: unknown angle ${s.angleId} and no valid hook, dropped.`); return false; }
    }
    if (!hookById.has(s.hookId)) {
      const alt = plan.hooks.find((h) => h.angleId === s.angleId);
      if (!alt) { note(`script ${s.id}: unknown hook ${s.hookId} and no hook for its angle, dropped.`); return false; }
      note(`script ${s.id}: unknown hook ${s.hookId}, used ${alt.id}.`);
      s.hookId = alt.id;
    }
    const angle = plan.angles.find((a) => a.id === s.angleId);
    if (!creatorIds.has(s.creatorId) && plan.creators.length) {
      const alt = plan.creators.find((c) => c.audienceId === angle.audienceId) || plan.creators[0];
      note(`script ${s.id}: unknown creator ${s.creatorId}, used ${alt.id}.`);
      s.creatorId = alt.id;
    }
    s.featureIds = cleanIds(s.featureIds, `script ${s.id}`);
    if (!s.featureIds.length) {
      note(`script ${s.id}: cited no observed feature, used the angle's features (${angle.featureIds.join(', ')}).`);
      s.featureIds = [...angle.featureIds];
    }
    return true;
  });
  if (plan.scripts.length > maxScripts) {
    note(`scripts: kept the first ${maxScripts} of ${plan.scripts.length}.`);
    plan.scripts.length = maxScripts;
  }

  // Beats must show something the run captured.
  const evidenceFor = (s) => s.featureIds.flatMap((id) => featureById.get(id).evidence);
  for (const s of plan.scripts) {
    s.beats.forEach((beat, i) => {
      const ref = beat.assetRef;
      if (ref == null) return;
      const m = String(ref).trim().replace(/^\.\//, '').match(/^(.*?)(?:@(\d+)s?|#t=(\d+)s?|\?t=(\d+)s?)?$/);
      const path = m[1], sec = m[2] ?? m[3] ?? m[4];
      const resolved = assetPaths.has(path) ? path : assetByName.get(path.split('/').pop()) || null;
      if (resolved) {
        if (resolved !== ref) note(`script ${s.id} beat ${beat.t}: asset reference "${ref}" normalised to ${resolved}.`);
        beat.assetRef = resolved;
        if (sec != null && /\.(webm|mp4|mov)$/i.test(resolved) && !/video at/i.test(beat.shot)) beat.shot = `${beat.shot} (video at ${hms(Number(sec))})`;
        return;
      }
      const pool = evidenceFor(s).filter((p) => !/\.(webm|mp4|mov)$/i.test(p));
      beat.assetRef = i > 0 && pool.length ? pool[(i - 1) % pool.length] : null;
      note(`script ${s.id} beat ${beat.t}: "${ref}" is not an asset the run captured, ${beat.assetRef ? `replaced with ${beat.assetRef}` : 'cleared'}.`);
    });
  }

  // Calendar
  const scriptIds = new Set(plan.scripts.map((s) => s.id));
  plan.campaign.calendar = plan.campaign.calendar.filter((c) => {
    if (scriptIds.has(c.scriptId)) return true;
    note(`calendar day ${c.day}: unknown script ${c.scriptId}, dropped.`);
    return false;
  });

  // Figures in script copy. Anything the pages never showed is flagged; anything they did show is
  // a claim the product makes about itself, read by the run but not verified.
  const compact = (t) => t.toLowerCase().replace(/[\s,]+/g, '');
  const corpus = compact(observed.corpus);
  const spokenBy = new Map();
  const scan = (label, text) => {
    for (const m of String(text).matchAll(FIGURE_RE)) {
      const key = normFigure(m[0]);
      if (!spokenBy.has(key)) spokenBy.set(key, { token: m[0].trim(), where: new Set() });
      spokenBy.get(key).where.add(label);
    }
  };
  for (const s of plan.scripts) {
    for (const b of s.beats) { scan(s.id, b.voiceover); scan(s.id, b.onScreenText); }
    scan(s.id, s.cta);
    scan(s.id, plan.hooks.find((h) => h.id === s.hookId)?.text || '');
  }
  let flagged = 0;
  const known = new Set(plan.proposals);
  for (const { token, where } of spokenBy.values()) {
    const list = [...where].join(', ');
    const seen = corpus.includes(compact(token));
    const line = seen
      ? `Figure "${token}" (${list}) is a claim the product's own pages make. The run read it but did not verify it. Attribute it to the site or confirm it before use.`
      : `Figure "${token}" (${list}) does not appear anywhere the run observed. Remove it or confirm it before use.`;
    if (!known.has(line)) { plan.proposals.push(line); flagged++; }
  }
  if (flagged) note(`${flagged} figure(s) in script copy were flagged in proposals.`);

  return { plan, repairs, flaggedFigures: flagged };
}
