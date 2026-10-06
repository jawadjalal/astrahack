// What may be flagged as a finding. Pure functions, no I/O, no dependencies.
//
// A FUNCTIONAL finding is observable broken behavior. Design, copy and taste opinions are not findings by
// default. Every producer (runner, crawl, QA agent, fleet, QA analysis, teardown agent) states this definition
// in its prompt and passes what it emits through assessFinding()/filterFindings(); the canvas converter does
// the same, so a design opinion cannot reach the board unless the run opted in with --include-design.
//
// canvas/src/lib/findings-filter.mjs is a byte-identical copy so the canvas app deploys on its own;
// test/findings-filter.test.js fails when the two drift. Edit this file, then copy it over the other one.

export const CATEGORIES = ['functional', 'usability', 'visual'];
export const DESIGN_CATEGORIES = ['usability', 'visual'];

export const FUNCTIONAL_DEFINITION = `A FUNCTIONAL finding is observable broken behavior:
- a flow that cannot be completed;
- an action with no effect or the wrong effect (a button that does nothing, a save that does not persist);
- an error, crash, blank screen or stuck state;
- wrong or inconsistent data or state (a counter, balance or total that does not update or contradicts another number on screen);
- validation that blocks valid input or accepts invalid input;
- a dead link, a 404 or a redirect loop;
- broken navigation, back or refresh (state lost);
- a console error or failed network request (4xx or 5xx) tied to a user action;
- an accessibility blocker that stops task completion (a control that cannot be reached, a focus trap);
- slowness only when it blocks the task (a timeout, a spinner that never ends).
NOT functional, never report as a finding: colors, spacing, typography, "could be clearer" copy, taste, layout preferences, missing polish, marketing suggestions, speculation about what might go wrong.`;

// Text appended to every producer's system prompt. includeDesign widens it; the severity rule then applies.
export function findingRulesPrompt({ includeDesign = false } = {}) {
  const lines = [
    'WHAT COUNTS AS A FINDING (hard rule):',
    FUNCTIONAL_DEFINITION,
    'Every finding must carry: (1) category "functional"; (2) the exact reproducible steps, shortest path from the start; (3) EXPECTED versus ACTUAL behavior; (4) the evidence, meaning the step or screenshot where the actual behavior is visible. A finding missing any of these is discarded. Report only what you directly observed, never what might happen.'
  ];
  if (includeDesign) {
    lines.push('Design observations are allowed in this run only: label them category "usability" (confusing flow or copy) or "visual" (look and layout), always with severity "info". They are kept apart from functional findings and never outrank them. Functional findings come first.');
  } else {
    lines.push('Do not report design or usability opinions at all. If something only looks or reads badly but works, leave it out.');
  }
  return lines.join('\n');
}

const norm = value => String(value ?? '').toLowerCase().trim();

export function normalizeCategory(value) {
  const v = norm(value);
  if (CATEGORIES.includes(v)) return v;
  if (['ux', 'usability', 'copy', 'content'].includes(v)) return 'usability';
  if (['visual', 'ui', 'design', 'aesthetic', 'style', 'cosmetic'].includes(v)) return 'visual';
  if (['functional', 'bug', 'defect', 'functionality'].includes(v)) return 'functional';
  return null;
}

// Words that mark taste, polish, wording and layout preferences. Matched on word boundaries, case-insensitive.
const DESIGN_TERMS = [
  'colou?rs?', 'palette', 'fonts?', 'typeface', 'typography', 'kerning', 'line-height', 'letter-spacing',
  'spacing', 'padding', 'margins?', 'white ?space', 'alignment', 'misaligned', 'aligned',
  'looks?', 'looked', 'looking', 'feels?', 'felt', 'appearance', 'aesthetics?', 'stylish', 'ugly', 'pretty', 'modern',
  'polish(?:ed)?', 'cluttered', 'clutter', 'crowded', 'bland', 'boring', 'visual hierarchy', 'hierarchy',
  'prefer(?:s|red|ence)?', 'consider(?:ing|ed)?', 'could be', 'might be', 'would be (?:better|nicer|clearer|good)',
  'nice to have', 'nicer', 'better if', 'improvements?', 'suggest(?:s|ed|ion|ions)?', 'recommend(?:s|ed|ation|ations)?',
  'unclear', 'confusing', 'ambiguous', 'vague', 'wording', 'copywriting', 'microcopy', 'tone', 'branding',
  'low[- ]contrast', 'contrast', 'opacity', 'tiny', 'too (?:small|big|large|light|dark|faint|subtle|cramped|bright)',
  'hard to (?:see|read|notice|find)', 'easy to miss'
];
const DESIGN_RE = new RegExp(`\\b(?:${DESIGN_TERMS.join('|')})\\b`, 'gi');

// Words that show behavior actually broke. STRONG ones keep a finding functional even when it also mentions a
// design word ("the button does nothing and its color does not change"). WEAK ones ("inconsistent", "wrong")
// also describe styling, so they only rescue a finding that mentions no styling noun ("uneven spacing").
const STRONG_SIGNALS = [
  'does(?:n\'t| not) (?:do anything|work|respond|update|change|load|open|close|submit|save|match|navigate|persist|appear|trigger|react|add|remove|sync|reflect|accept|validate|show up|display|dismiss)',
  'do(?:es)? nothing', 'nothing (?:happens|changes|appears|loads)', 'no (?:effect|response|change|reaction)',
  'not responding', 'un?responsive', 'non-?responsive', 'not working', 'stopped working', 'broken', 'dead (?:link|end)',
  '40[0-9]', '50[0-9]', 'http [45]\\d\\d', 'status (?:code )?[45]\\d\\d',
  'errors?', 'exceptions?', 'crash(?:es|ed|ing)?', 'fail(?:s|ed|ure|ing)?', 'blank (?:page|screen|state)', 'white screen',
  'frozen', 'freez(?:e|es)', 'hangs?', 'stuck', 'time(?:s|d)? ?out', 'spinner', 'infinite', 'redirect loop',
  'cannot', 'can\'t', 'can not', 'unable', 'won\'t', 'will not',
  'not (?:updated|updating|saved|persisted|shown|displayed|reflected|cleared|rejected|validated|loaded|created|deleted|removed|sent|received|synced|reachable|clickable|tappable)'
];
const WEAK_SIGNALS = [
  'stale', 'incorrect', 'wrong', 'inconsistent', 'mismatch(?:es|ed)?', 'contradict(?:s|ed|ing)?', 'duplicat(?:e|ed|es)',
  'lost', 'loses', 'disappear(?:s|ed)?', 'reverts?', 'resets?', 'accepts?', 'rejects?', 'blocks?', 'blocked', 'console', 'network request'
];
const signal = list => new RegExp(`(?:^|[^a-z0-9])(?:${list.join('|')})(?![a-z0-9])`, 'i');
const STRONG_RE = signal(STRONG_SIGNALS);
const WEAK_RE = signal(WEAK_SIGNALS);
const STYLE_NOUN_RE = /\b(?:colou?rs?|palette|fonts?|typeface|typography|kerning|spacing|padding|margins?|white ?space|alignment|misaligned|contrast|opacity|line-height|letter-spacing)\b/i;

const VISUAL_RE = /\b(?:colou?rs?|palette|fonts?|typeface|typography|kerning|spacing|padding|margins?|white ?space|alignment|aligned|misaligned|looks?|looked|appearance|aesthetics?|ugly|pretty|modern|polish(?:ed)?|cluttered|clutter|crowded|contrast|opacity|tiny|too (?:small|big|large|light|dark|faint|bright))\b/i;

const text = f => [f?.summary ?? f?.title, f?.expected, f?.actual].filter(Boolean).map(String).join(' ');

const nonBlank = list => Array.isArray(list) && list.some(item => (typeof item === 'string' ? item.trim() : item != null));
const filled = value => typeof value === 'string' && value.trim().length > 0;

export function reproductionOf(f) {
  for (const key of ['reproduction', 'repro', 'repro_steps', 'reproSteps', 'stepsToReproduce', 'steps']) {
    if (nonBlank(f?.[key])) return f[key];
  }
  return [];
}

export function hasEvidence(f) {
  if (filled(f?.evidence) || filled(f?.screenshot)) return true;
  if (nonBlank(f?.evidenceRefs)) return true;
  return Number.isInteger(f?.evidenceStep) && f.evidenceStep >= 0;
}

// What is missing from a finding before it can be trusted: [] means nothing.
export function missingRequirements(f) {
  const missing = [];
  if (!filled(f?.summary ?? f?.title)) missing.push('a summary');
  if (!reproductionOf(f).length) missing.push('reproduction steps');
  if (!filled(f?.expected) || !filled(f?.actual)) missing.push('both expected and actual behavior');
  if (!hasEvidence(f)) missing.push('evidence (a step or screenshot)');
  return missing;
}

// Design words found in a finding, minus the case where the finding also shows behavior breaking.
export function designMarkers(f) {
  const body = text(f);
  if (STRONG_RE.test(body)) return [];
  if (WEAK_RE.test(body) && !STYLE_NOUN_RE.test(body)) return [];
  return [...new Set((body.match(DESIGN_RE) || []).map(m => m.toLowerCase()))];
}

// 'functional' | 'usability' | 'visual': the producer's explicit category wins, but an explicit "functional"
// that reads as pure taste is overruled. A missing category is inferred from the wording.
// trustCategory skips the wording heuristics: for producers whose findings are failed assertions written by a
// person (the scripted runner), where the observed page text can contain any word.
export function categoryOf(f, { trustCategory = false } = {}) {
  const explicit = normalizeCategory(f?.category);
  if (trustCategory) return explicit || 'functional';
  if (explicit && explicit !== 'functional') return explicit;
  const markers = designMarkers(f);
  if (!markers.length) return 'functional';
  return VISUAL_RE.test(text(f)) ? 'visual' : 'usability';
}

// -> { keep, category, reasons[], finding }. finding is a copy carrying the final category; a design finding
// that is kept (includeDesign) is forced to severity "info". Dropped findings keep their reasons for the report.
export function assessFinding(f, { includeDesign = false, trustCategory = false } = {}) {
  const category = categoryOf(f, { trustCategory });
  const reasons = [];
  if (category !== 'functional') {
    const markers = designMarkers(f);
    const explicit = normalizeCategory(f?.category);
    if (!includeDesign) {
      reasons.push(explicit && explicit !== 'functional'
        ? `category "${category}" is a design observation, not broken behavior`
        : `reads as a design or taste opinion (${markers.slice(0, 4).join(', ')})`);
    }
  }
  const missing = missingRequirements(f);
  if (missing.length) reasons.push(`missing ${missing.join(', ')}`);
  const keep = reasons.length === 0;
  const finding = { ...f, category, ...(category !== 'functional' ? { severity: 'info' } : {}) };
  return { keep, category, reasons, finding };
}

export function isFunctionalFinding(f, options = {}) {
  const { keep, category } = assessFinding(f, options);
  return keep && category === 'functional';
}

// -> { kept[], dropped[{ finding, category, reasons[] }] }. Order is preserved.
export function filterFindings(list, options = {}) {
  const kept = [];
  const dropped = [];
  for (const f of Array.isArray(list) ? list : []) {
    const verdict = assessFinding(f, options);
    if (verdict.keep) kept.push(verdict.finding);
    else dropped.push({ finding: f, category: verdict.category, reasons: verdict.reasons });
  }
  return { kept, dropped };
}

// Compact record of a dropped finding for run reports.
export const excludedSummary = ({ finding, category, reasons }) => ({
  summary: String(finding?.summary ?? finding?.title ?? '').slice(0, 160), category, reasons
});
