// Normalises the three accepted inputs into one ProductUnderstanding:
//   - a computer-use run (report.json, or a run directory holding it)
//   - a UGC plan (ugc-plan.json, kind "astrahack.ugc-plan")
//   - a one-paragraph brief (--brief text, or a .txt/.md file)
// Nothing is invented: a run only yields what it observed, a brief yields only what it says.

import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export const MAX_BRIEF = 12000;
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const uniq = (list) => [...new Set(list)];

/** "Ignura · The launch studio for apps" -> "Ignura" */
export function nameFromTitle(title, fallback = 'the product') {
  const first = String(title ?? '').split(/\s[·|–—-]\s|[·|]/)[0].trim();
  return first || fallback;
}

function featuresFromReport(report) {
  const assets = report.assets ?? [];
  const features = [];
  for (const journey of report.journeys ?? []) {
    const steps = journey.steps ?? [];
    const texts = uniq(steps.filter((s) => s.action === 'assertText' && s.text).map((s) => s.text));
    const pages = uniq(steps.filter((s) => s.action === 'goto' && s.url).map((s) => s.url));
    const clicks = steps.filter((s) => s.action === 'click').length;
    const evidence = uniq([
      ...assets.filter((a) => a.type === 'screenshot' && a.journey === journey.name).map((a) => a.path),
      ...steps.map((s) => s.screenshot).filter(Boolean),
    ]);
    const bits = [];
    if (texts.length) bits.push(`the page showed ${texts.slice(0, 3).map((t) => `"${clip(t, 60)}"`).join(', ')}`);
    if (pages.length) bits.push(`visited ${pages.slice(0, 3).join(', ')}`);
    if (clicks) bits.push(`${clicks} click${clicks === 1 ? '' : 's'} worked`);
    features.push({
      id: `F${features.length + 1}`,
      name: journey.name,
      whatItDoes: `Observed journey "${journey.name}" (${journey.status ?? 'unknown'}): ${bits.join('; ') || 'no assertions recorded'}.`,
      evidence,
    });
  }
  return features;
}

function fromReport(report, path) {
  const p = report.product ?? {};
  const name = nameFromTitle(p.title, report.name ?? 'the product');
  const labels = uniq((p.controls ?? []).map((c) => c.label).filter((l) => l && l.length > 2 && l.length < 60)).slice(0, 24);
  return {
    kind: 'run',
    sourcePath: path,
    name,
    url: p.url ?? report.target?.url ?? null,
    oneLiner: clip(p.description || p.title || report.name, 300),
    headings: (p.headings ?? []).map((h) => h.text).filter(Boolean).slice(0, 10),
    controlLabels: labels,
    features: featuresFromReport(report),
    friction: (report.findings ?? []).map((f) => clip(f.title ?? f.message ?? JSON.stringify(f), 200)).slice(0, 8),
    audienceHints: [],
    brief: null,
  };
}

function fromUgcPlan(plan, path) {
  const p = plan.product;
  return {
    kind: 'ugc-plan',
    sourcePath: path,
    name: p.name,
    url: plan.source?.target ?? null,
    oneLiner: clip(`${p.oneLiner} (${p.category}; for ${p.whoItsFor})`, 400),
    category: p.category,
    audience: p.whoItsFor,
    headings: [],
    controlLabels: [],
    features: p.observedFeatures.map((f) => ({ id: f.id, name: f.name, whatItDoes: f.whatItDoes, evidence: f.evidence ?? [] })),
    friction: p.frictionFromQa ?? [],
    audienceHints: (plan.audiences ?? []).map((a) => `${a.name}: pain "${a.pain}"; desire "${a.desire}"`),
    brief: null,
  };
}

function fromBrief(text, { name, url } = {}) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('The brief is empty.');
  if (body.length > MAX_BRIEF) throw new Error(`The brief is longer than ${MAX_BRIEF} characters.`);
  const guess = name || (body.match(/^\s*([A-Z][\w.-]{1,30})\s+(?:is|helps|lets|turns|makes)\b/)?.[1]) || 'the product';
  const foundUrl = url || body.match(/https?:\/\/[^\s)]+/)?.[0] || null;
  return {
    kind: 'brief',
    sourcePath: null,
    name: guess,
    url: foundUrl,
    oneLiner: clip(body, 300),
    headings: [],
    controlLabels: [],
    // A brief has no observed evidence; the single feature records that honestly.
    features: [{ id: 'F1', name: 'Described in the brief', whatItDoes: clip(body, 600), evidence: [] }],
    friction: [],
    audienceHints: [],
    brief: body,
  };
}

/** Accepts { brief } | { input: path } and returns the normalised understanding. */
export async function loadInput({ input, brief, name, url } = {}) {
  if (brief && input) throw new Error('Supply --input or --brief, not both.');
  if (brief) return fromBrief(brief, { name, url });
  if (!input) throw new Error('Supply --input <report.json | run dir | ugc-plan.json | brief.md> or --brief "<text>".');
  let path = resolve(input);
  const s = await stat(path).catch(() => null);
  if (!s) throw new Error(`Not found: ${input}`);
  if (s.isDirectory()) {
    for (const f of ['report.json', 'ugc-plan.json']) {
      if (await stat(join(path, f)).then(() => true, () => false)) { path = join(path, f); break; }
    }
    if ((await stat(path)).isDirectory()) throw new Error(`No report.json or ugc-plan.json in ${input}.`);
  }
  const raw = await readFile(path, 'utf8');
  if (!path.endsWith('.json')) return fromBrief(raw, { name: name ?? undefined, url });
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`${basename(path)} is not valid JSON.`); }
  const out = data.kind === 'astrahack.ugc-plan' ? fromUgcPlan(data, path)
    : data.journeys || data.product ? fromReport(data, path)
      : null;
  if (!out) throw new Error(`${basename(path)} is neither a run report nor a UGC plan.`);
  if (name) out.name = name;
  if (url) out.url = url;
  out.runDir = dirname(path);
  return out;
}

/** The text block the model sees. Facts only, each tagged with its id so claims can cite them. */
export function describeProduct(u) {
  const lines = [`Name: ${u.name}`, `URL: ${u.url ?? '(none supplied)'}`, `Input kind: ${u.kind}`, `Summary: ${u.oneLiner}`];
  if (u.headings.length) lines.push(`Page headings seen: ${u.headings.map((h) => `"${clip(h, 80)}"`).join(' | ')}`);
  if (u.controlLabels.length) lines.push(`Buttons and links seen: ${u.controlLabels.join(' | ')}`);
  lines.push('Observed features (cite these ids):');
  for (const f of u.features) lines.push(`- ${f.id} ${f.name}: ${clip(f.whatItDoes, 500)}${f.evidence.length ? ` [evidence: ${f.evidence.length} file${f.evidence.length === 1 ? '' : 's'}, e.g. ${f.evidence[0]}]` : ' [no evidence files]'}`);
  if (u.audienceHints.length) lines.push('Audience hints from the UGC plan:', ...u.audienceHints.map((a) => `- ${a}`));
  if (u.friction.length) lines.push('Friction found by QA (never use as a selling point):', ...u.friction.map((a) => `- ${a}`));
  return lines.join('\n');
}
