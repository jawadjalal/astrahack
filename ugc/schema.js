// Contract for the UGC planner. Input: a computer-use run's report.json (see src/runner.js).
// Output: ugc-plan.json matching PLAN_SCHEMA. Everything downstream (canvas, preview) reads only this shape.
//
// Grounding rule: every product claim points at observed feature ids, and every feature points at
// evidence (screenshot/video paths from the run). Anything not observed is marked as a proposal.

const str = { type: 'string' };
const strs = { type: 'array', items: str };
const obj = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const arr = (items) => ({ type: 'array', items });

export const PLATFORMS = ['tiktok', 'instagram-reels', 'youtube-shorts', 'linkedin', 'x'];
export const FORMATS = [
  'talking-head', 'screen-recording-voiceover', 'green-screen', 'pov', 'problem-solution',
  'before-after', 'tutorial', 'reaction', 'day-in-the-life', 'founder-story', 'listicle',
];

export const PLAN_SCHEMA = obj({
  product: obj({
    name: str,
    oneLiner: str,
    category: str,
    whoItsFor: str,
    observedFeatures: arr(obj({
      id: str,                 // e.g. "F1"
      name: str,
      whatItDoes: str,         // plain words, only what the run observed
      evidence: strs,          // asset paths from report.json, e.g. "screenshots/003-...png"
    })),
    frictionFromQa: strs,      // QA findings worth knowing before promoting (never used as ad claims)
  }),
  audiences: arr(obj({
    id: str,                   // "A1"
    name: str,
    pain: str,
    desire: str,
    platforms: arr({ type: 'string', enum: PLATFORMS }),
  })),
  angles: arr(obj({
    id: str,                   // "ANG1"
    name: str,
    insight: str,
    audienceId: str,
    featureIds: strs,
    whyItWorks: str,
  })),
  creators: arr(obj({
    id: str,                   // "C1"
    archetype: str,            // e.g. "Overwhelmed solo founder"
    profile: str,              // who to cast: age range, niche, vibe, follower tier
    whyThem: str,
    audienceId: str,
  })),
  hooks: arr(obj({
    id: str,                   // "H1"
    angleId: str,
    text: str,                 // the first spoken / on-screen line, < 15 words
    format: { type: 'string', enum: FORMATS },
    visualOpener: str,         // what the viewer sees in the first 2 seconds
  })),
  scripts: arr(obj({
    id: str,                   // "S1"
    title: str,
    angleId: str,
    hookId: str,
    creatorId: str,
    platform: { type: 'string', enum: PLATFORMS },
    format: { type: 'string', enum: FORMATS },
    durationSec: { type: 'integer' },
    beats: arr(obj({
      t: str,                  // "0-2s"
      voiceover: str,
      onScreenText: str,
      shot: str,               // camera direction
      assetRef: { type: ['string', 'null'] }, // screenshot/video path to show, or null
    })),
    cta: str,
    featureIds: strs,          // claims used; must exist in product.observedFeatures
  })),
  creatorBrief: obj({
    mustShow: strs,
    dos: strs,
    donts: strs,
    deliverables: strs,
    disclosure: str,           // e.g. "#ad / Paid partnership label"
  }),
  campaign: obj({
    goal: str,
    phases: arr(obj({
      name: str,               // "Test", "Scale", "Always-on"
      days: str,               // "Days 1-7"
      objective: str,
      actions: strs,
    })),
    calendar: arr(obj({
      day: { type: 'integer' },
      platform: { type: 'string', enum: PLATFORMS },
      scriptId: str,
      note: str,
    })),
    kpis: arr(obj({ metric: str, target: str, why: str })),
    budgetNote: str,
  }),
  proposals: strs,             // assumptions / claims NOT observed in the product, to verify before use
});

// Full document written to disk (model output + provenance added by the planner).
export function wrapPlan(plan, meta) {
  return {
    schemaVersion: 1,
    kind: 'astrahack.ugc-plan',
    generatedAt: new Date().toISOString(),
    source: meta.source,       // { report: path, target: url, runName }
    model: meta.model,         // model id or "mock"
    ...plan,
  };
}

// Cheap integrity checks the model's JSON schema can't express.
export function checkGrounding(plan) {
  const problems = [];
  const features = new Set(plan.product.observedFeatures.map((f) => f.id));
  const ids = (list) => new Set(list.map((x) => x.id));
  const audiences = ids(plan.audiences), angles = ids(plan.angles);
  const hooks = ids(plan.hooks), creators = ids(plan.creators), scripts = ids(plan.scripts);
  for (const f of plan.product.observedFeatures) if (!f.evidence.length) problems.push(`feature ${f.id} has no evidence`);
  for (const a of plan.angles) {
    if (!audiences.has(a.audienceId)) problems.push(`angle ${a.id} -> unknown audience ${a.audienceId}`);
    for (const id of a.featureIds) if (!features.has(id)) problems.push(`angle ${a.id} -> unknown feature ${id}`);
  }
  for (const h of plan.hooks) if (!angles.has(h.angleId)) problems.push(`hook ${h.id} -> unknown angle ${h.angleId}`);
  for (const s of plan.scripts) {
    if (!angles.has(s.angleId)) problems.push(`script ${s.id} -> unknown angle ${s.angleId}`);
    if (!hooks.has(s.hookId)) problems.push(`script ${s.id} -> unknown hook ${s.hookId}`);
    if (!creators.has(s.creatorId)) problems.push(`script ${s.id} -> unknown creator ${s.creatorId}`);
    for (const id of s.featureIds) if (!features.has(id)) problems.push(`script ${s.id} claims unobserved feature ${id}`);
  }
  for (const c of plan.campaign.calendar) if (!scripts.has(c.scriptId)) problems.push(`calendar day ${c.day} -> unknown script ${c.scriptId}`);
  return problems;
}
