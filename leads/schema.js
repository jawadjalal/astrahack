// Contract for the lead-generation planner.
//
// The model (or the mock) returns a PLAN: who the customer is, where to look, what to search, what to say.
// It never returns URLs. Every link in leads.json is built by code in recipes.mjs from the query strings
// below, and every real lead URL comes from a search result (discover.mjs), never from model prose.

const str = { type: 'string', minLength: 1 };
const strs = (min = 1, max = 12) => ({ type: 'array', items: str, minItems: min, maxItems: max });
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items, min, max) => ({ type: 'array', items, minItems: min, maxItems: max });
const en = (...values) => ({ type: 'string', enum: values });

export const QUERY_INTENTS = ['pain', 'wish', 'competitor-complaint', 'how-to', 'recommendation-ask'];
export const COMMUNITY_PLATFORMS = ['discord', 'slack', 'facebook', 'forum', 'other'];
export const NEWSLETTER_ROUTES = ['sponsor', 'submit', 'pitch', 'read-for-leads'];
export const CREATOR_PLATFORMS = ['tiktok', 'instagram', 'youtube', 'x', 'linkedin'];
export const OUTREACH_TYPES = ['reddit-comment', 'x-reply', 'dm', 'cold-email'];

const query = obj({ q: str, intent: en(...QUERY_INTENTS) });

export const PLAN_SCHEMA = obj({
  icp: obj({
    summary: str,
    segments: arr(obj({
      id: str,                  // "S1"
      name: str,
      who: str,                 // role, situation, stage
      pain: str,                // the problem, in the customer's words where possible
      trigger: str,             // the moment they go looking
      featureIds: strs(1, 8),   // observed feature ids this segment's pain maps to
      disqualifiers: strs(1, 4),
    }), 2, 4),
    buyingTriggers: strs(3, 6),
    objections: strs(2, 5),
    notAFit: strs(1, 4),
    assumptions: strs(1, 8),    // anything about the customer NOT observed in the product
  }),
  reddit: arr(obj({ subreddit: str, fit: str, queries: arr(query, 2, 3) }), 3, 6),
  x: arr(obj({ q: str, intent: en(...QUERY_INTENTS), note: str }), 4, 8),
  hackerNews: arr(query, 2, 4),
  productHunt: arr(query, 2, 3),
  indieHackers: arr(query, 2, 3),
  communities: arr(obj({ platform: en(...COMMUNITY_PLATFORMS), name: str, fit: str, howToFind: str }), 3, 6),
  newsletters: arr(obj({ name: str, fit: str, route: en(...NEWSLETTER_ROUTES), howToFind: str }), 3, 5),
  creators: arr(obj({ archetype: str, platform: en(...CREATOR_PLATFORMS), searchTerms: strs(2, 4), whatToLookFor: str }), 3, 4),
  intentPhrases: strs(8, 12),
  competitors: arr(obj({ name: str, why: str, complaintQueries: strs(2, 3) }), 2, 4),
  outreach: arr(obj({
    id: str,                    // "o-1"
    sourceType: en(...OUTREACH_TYPES),
    scenario: str,              // the situation this draft answers
    subject: str,               // email subject, or "(none)"
    draft: str,                 // must contain {{EVIDENCE}} where the observed proof goes
    evidenceSlot: str,          // which observed screenshot / flow replaces {{EVIDENCE}}
    disclosure: str,            // how the affiliation is stated inside the draft
  }), 4, 8),
  cadence: arr(obj({ day: { type: 'integer', minimum: 1, maximum: 7 }, focus: str, actions: strs(2, 5), target: str, review: str }), 7, 7),
});

// The model gets this in three requests: the whole schema, or even the 11-key research half, is rejected
// by the API with HTTP 400 (too complex), while each of these groups is accepted. Later requests also see
// the ICP the first one produced, which keeps the drafts consistent with it.
const pick = (keys) => ({ ...PLAN_SCHEMA, required: keys, properties: Object.fromEntries(keys.map((k) => [k, PLAN_SCHEMA.properties[k]])) });
export const ICP_KEYS = ['icp', 'reddit', 'x', 'hackerNews', 'productHunt', 'indieHackers'];
export const MORE_KEYS = ['communities', 'newsletters', 'creators', 'intentPhrases', 'competitors'];
export const DRAFTING_KEYS = ['outreach', 'cadence'];
export const RESEARCH_KEYS = [...ICP_KEYS, ...MORE_KEYS];
export const ICP_SCHEMA = pick(ICP_KEYS);
export const MORE_SCHEMA = pick(MORE_KEYS);
export const DRAFTING_SCHEMA = pick(DRAFTING_KEYS);

function check(value, schema, path, problems) {
  if (schema.type === 'string') {
    if (typeof value !== 'string' || !value.trim()) return problems.push(`${path}: expected nonempty string`);
    if (schema.enum && !schema.enum.includes(value)) problems.push(`${path}: "${value}" not in ${schema.enum.join('|')}`);
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum) problems.push(`${path}: expected integer ${schema.minimum}-${schema.maximum}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return problems.push(`${path}: expected array`);
    if (value.length < schema.minItems || value.length > schema.maxItems) problems.push(`${path}: expected ${schema.minItems}-${schema.maxItems} items, got ${value.length}`);
    value.forEach((v, i) => check(v, schema.items, `${path}[${i}]`, problems));
  } else if (!value || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${path}: expected object`);
  } else {
    for (const k of Object.keys(value)) if (!(k in schema.properties)) problems.push(`${path}.${k}: unexpected field`);
    for (const k of schema.required) check(value[k], schema.properties[k], `${path}.${k}`, problems);
  }
}

/** Structural problems plus the rules JSON schema cannot express. Empty array = valid. `keys` validates a part. */
export function validatePlan(plan, { featureIds = [], keys } = {}) {
  const problems = [];
  check(plan, keys ? pick(keys) : PLAN_SCHEMA, 'plan', problems);
  if (problems.length) return problems;
  const known = new Set(featureIds);
  const has = (k) => !keys || keys.includes(k);
  if (has('icp')) for (const s of plan.icp.segments) for (const id of s.featureIds) if (known.size && !known.has(id)) problems.push(`segment ${s.id} cites unknown feature ${id}`);
  if (has('reddit')) for (const r of plan.reddit) if (!/^[A-Za-z0-9_]{2,21}$/.test(r.subreddit)) problems.push(`reddit subreddit "${r.subreddit}" must be a bare name (no r/, no spaces)`);
  if (has('outreach')) {
    for (const o of plan.outreach) if (!o.draft.includes('{{EVIDENCE}}')) problems.push(`outreach ${o.id} is missing the {{EVIDENCE}} placeholder`);
    const types = new Set(plan.outreach.map((o) => o.sourceType));
    for (const t of OUTREACH_TYPES) if (!types.has(t)) problems.push(`outreach has no ${t} draft`);
    if (new Set(plan.outreach.map((o) => o.id)).size !== plan.outreach.length) problems.push('outreach ids must be unique');
  }
  if (has('cadence') && new Set(plan.cadence.map((d) => d.day)).size !== 7) problems.push('cadence must cover days 1-7 exactly once');
  return problems;
}
