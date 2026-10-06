// Dependency-free validator for the JSON-schema subset PLAN_SCHEMA uses
// (object/array/string/integer, enum, required, additionalProperties:false, ['string','null']),
// plus the integrity checks the schema cannot express.
import { PLAN_SCHEMA, checkGrounding } from './schema.js';

function kind(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

export function validateSchema(value, schema = PLAN_SCHEMA, path = '$') {
  const types = [].concat(schema.type);
  const actual = kind(value);
  const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
  if (!ok) return [`${path}: expected ${types.join('|')}, got ${actual}`];
  const problems = [];
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${path}: "${value}" is not one of ${schema.enum.join(', ')}`);
  if (actual === 'array') {
    if (schema.minItems != null && value.length < schema.minItems) problems.push(`${path}: needs at least ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) problems.push(`${path}: allows at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => problems.push(...validateSchema(item, schema.items, `${path}[${i}]`)));
  }
  if (actual === 'object' && schema.properties) {
    for (const key of schema.required || []) if (!(key in value)) problems.push(`${path}.${key}: missing`);
    for (const [key, v] of Object.entries(value)) {
      if (!(key in schema.properties)) {
        if (schema.additionalProperties === false) problems.push(`${path}.${key}: unexpected property`);
        continue;
      }
      problems.push(...validateSchema(v, schema.properties[key], `${path}.${key}`));
    }
  }
  return problems;
}

const COLLECTIONS = [
  ['product.observedFeatures', (p) => p.product.observedFeatures],
  ['audiences', (p) => p.audiences], ['angles', (p) => p.angles], ['creators', (p) => p.creators],
  ['hooks', (p) => p.hooks], ['scripts', (p) => p.scripts],
];

/**
 * Full validation: schema shape, then grounding (checkGrounding from schema.js), then extras:
 * unique ids, 3 to 5 scripts, beats cite known assets.
 * @param {object} plan  model output or wrapped plan
 * @param {{assets?: Set<string>, scriptRange?: [number, number]}} [opts]
 * @returns {string[]} problems (empty means valid)
 */
export function validatePlan(plan, { assets, scriptRange = [3, 5] } = {}) {
  plan = 'schemaVersion' in plan ? contractPart(plan) : plan;
  const shape = validateSchema(plan, PLAN_SCHEMA);
  if (shape.length) return shape;
  const problems = [...checkGrounding(plan)];
  for (const [label, get] of COLLECTIONS) {
    const seen = new Set();
    for (const item of get(plan)) {
      if (seen.has(item.id)) problems.push(`${label}: duplicate id ${item.id}`);
      seen.add(item.id);
    }
  }
  const n = plan.scripts.length;
  if (n < scriptRange[0] || n > scriptRange[1]) problems.push(`scripts: expected ${scriptRange[0]} to ${scriptRange[1]}, got ${n}`);
  for (const s of plan.scripts) {
    if (!s.featureIds.length) problems.push(`script ${s.id} cites no feature`);
    if (!s.beats.length) problems.push(`script ${s.id} has no beats`);
    if (assets) for (const b of s.beats) if (b.assetRef && !assets.has(b.assetRef)) problems.push(`script ${s.id} beat ${b.t} -> unknown asset ${b.assetRef}`);
  }
  return problems;
}

/** Wrapped documents carry provenance keys (schemaVersion, kind, generatedAt, source, model, grounding)
 *  that PLAN_SCHEMA does not describe. This returns only the contract part. */
export function contractPart(doc) {
  return Object.fromEntries(Object.keys(PLAN_SCHEMA.properties).filter((k) => k in doc).map((k) => [k, doc[k]]));
}
