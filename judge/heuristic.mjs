// Deterministic judge + rewriter for UGC plans (no model key needed). Same rubric as the model judge.
// Every score is explainable: each deduction adds a short reason to the rationale.

export const CRITERIA = ['scrollStop', 'specificity', 'native', 'clarity', 'grounding', 'compliance'];
export const RUBRIC = {
  scrollStop: 'scroll-stop power: does the first line create tension or curiosity?',
  specificity: 'specific to this product: names it, its real features or on-page text',
  native: 'native to the platform: sounds like a person, not ad-speak or stage directions',
  clarity: 'clear and short enough to say in the time',
  grounding: 'claims tie to observed features that have evidence',
  compliance: 'no invented stats, prices or testimonials',
};
export const HOOK_MAX_WORDS = 15;

export const AD_SPEAK = ['revolutionary', 'game-changer', 'game changer', 'unlock', 'unleash', 'cutting-edge', 'best-in-class',
  'seamless', 'seamlessly', 'supercharge', 'next-level', 'world-class', 'synergy', 'leverage', 'empower', 'transform your',
  'elevate', 'disrupt', 'innovative', 'all-in-one', 'must-have', 'look no further', 'take it to the next level', 'let us look',
  'step by step', 'here is what', 'explained in'];
const TESTIMONIAL = /\b(customers (say|love)|loved by|trusted by|rated|#1|number one|five[- ]star|5[- ]star|everyone loves)\b/i;
const TENSION = [/\?/, /^pov\b/i, /^stop\b/i, /^why\b/i, /^nobody\b/i, /^(i|we) (tested|tried|clicked|checked|almost)\b/i,
  /\bbefore you\b/i, /so you don'?t have to/i, /\bdon'?t\b/i, /\bwhat .* (actually|really)\b/i, /\bsays? ".+"/i];
const ATTRIBUTED = /site'?s own|check the page|on the page/i;
const STAGE_DIRECTION = /^(pause|read|say|start at|tap|scroll|show|point)\b/i;

export const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const clamp = (n) => Math.max(0, Math.min(10, Math.round(n * 10) / 10));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

// ---------- product facts the judge is allowed to use ----------
export function quotesOf(feature) {
  const m = feature.whatItDoes.match(/confirmed this text on the page: (.*?)\.(?: Nearby| The run|$)/);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}
export function labelOf(feature) {
  let n = feature.name.split(':')[0].replace(/^(browse|explore|read|see|view|open|check)\s+/i, '').replace(/^the\s+/i, '').split(/\s+(?:that|for|which)\s+/i)[0].trim();
  if (words(n) > 4) n = n.split(/\s+and\s+/i)[0];
  if (words(n) > 4) n = n.split(/\s+/).slice(0, 4).join(' ');
  return n;
}
const FIGURE = /[£$€]\s?\d[\d,.]*\s?[kKmM]?\+?|\b\d[\d,.]*\s?[kKmM]\+?(?:\s+views)?|\b\d+(?:\.\d+)?%|\b\d{1,3}(?:,\d{3})+\b|\b\d{2,}\b/g;
const DURATION = /^\d+(?:–\d+)?$/;

export function productFacts(plan) {
  const features = new Map(plan.product.observedFeatures.map((f) => [f.id, { ...f, quotes: quotesOf(f), label: labelOf(f) }]));
  const evidence = new Set(plan.product.observedFeatures.flatMap((f) => f.evidence));
  const sourceText = [...plan.product.observedFeatures.map((f) => `${f.name} ${f.whatItDoes}`), ...plan.proposals].join(' ').toLowerCase();
  const angles = new Map(plan.angles.map((a) => [a.id, a]));
  return { name: plan.product.name, features, evidence, sourceText, angles };
}

function unsupportedFigures(text, facts) {
  const out = [];
  for (const m of String(text).matchAll(FIGURE)) {
    const fig = m[0].trim().replace(/[,.]+$/, '');
    const after = String(text).slice(m.index + m[0].length, m.index + m[0].length + 9);
    if (DURATION.test(fig) && /^\s*(-?\s*)?(s\b|sec|second|minute|day|week)/i.test(after)) continue; // video length, not a claim
    if (!facts.sourceText.includes(fig.toLowerCase())) out.push(fig);
  }
  return out;
}
const adSpeakIn = (text) => AD_SPEAK.filter((w) => String(text).toLowerCase().includes(w));
function mentions(text, f) {
  const t = String(text).toLowerCase();
  return t.includes(f.label.toLowerCase()) || f.quotes.some((q) => t.includes(q.toLowerCase())) || t.includes(f.name.toLowerCase());
}

// ---------- scoring ----------
function finish(scores, why, extra = {}) {
  for (const k of CRITERIA) scores[k] = clamp(scores[k]);
  // half average, half weakest line: one bad rubric line drags the item down instead of hiding in the mean
  const vals = CRITERIA.map((k) => scores[k]);
  let overall = 0.5 * mean(vals) + 0.5 * Math.min(...vals);
  if (extra.cap != null) overall = Math.min(overall, extra.cap);
  return { scores, overall: clamp(overall), rationale: why.length ? why.join('; ') : 'meets every rubric line' };
}

export function scoreHook(hook, facts) {
  const why = [];
  const s = Object.fromEntries(CRITERIA.map((k) => [k, 10]));
  const text = hook.text, n = words(text);
  const angle = facts.angles.get(hook.angleId);
  const feats = (angle?.featureIds || []).map((id) => facts.features.get(id)).filter(Boolean);
  const tension = TENSION.some((r) => r.test(text));
  if (!tension) { s.scrollStop -= 6; why.push('no tension or curiosity in the opener'); }
  if (/^(here is|here's|i mapped|the question everyone)/i.test(text)) { s.scrollStop -= 1.5; why.push('opens with a label, not a stake'); }
  if (n > HOOK_MAX_WORDS) { s.clarity -= 5; why.push(`${n} words (max ${HOOK_MAX_WORDS})`); } else if (n > 11) s.clarity -= 1;
  if ((text.replace(/"[^"]*"/g, 'Q').match(/[.!?]/g) || []).length > 1) { s.clarity -= 1.5; why.push('two sentences in the first line'); }
  const featHit = feats.some((f) => mentions(text, f));
  const quoteHit = feats.some((f) => f.quotes.some((q) => text.toLowerCase().includes(q.toLowerCase())));
  if (!featHit) { s.specificity -= 5; why.push('names no real feature or on-page text'); }
  else if (!quoteHit) { s.specificity -= 1; why.push('names a feature but quotes nothing from it'); }
  if (!text.includes(facts.name)) { s.specificity -= 1.5; why.push('product not named'); }
  if (/\b(hero|homepage)\b/i.test(text)) { s.native -= 2; why.push('internal page label, not how people talk'); }
  if (/launch studio for apps|so you can see it/i.test(text)) { s.specificity -= 1.5; why.push('generic category wording'); }
  const ad = adSpeakIn(text);
  if (ad.length) { s.native -= 3 * ad.length; why.push(`ad-speak: ${ad.join(', ')}`); }
  if (!angle) { s.grounding = 0; why.push(`unknown angle ${hook.angleId}`); }
  else if (!feats.length) { s.grounding -= 6; why.push('angle cites no observed feature'); }
  if (/\b(real numbers|proof|results)\b/i.test(text) && !featHit) { s.grounding -= 3; why.push('promises proof it does not point to'); }
  const figs = unsupportedFigures(text, facts);
  if (figs.length) { s.compliance -= 6; why.push(`unsupported figure: ${figs.join(', ')}`); }
  if (TESTIMONIAL.test(text)) { s.compliance -= 6; why.push('implied testimonial'); }
  return finish(s, why, { cap: n > HOOK_MAX_WORDS ? 4 : null });
}

export function scoreScript(script, facts, hookText) {
  const why = [];
  const s = Object.fromEntries(CRITERIA.map((k) => [k, 10]));
  const opener = script.beats[0]?.voiceover || '';
  const hookPart = scoreHook({ text: opener, angleId: script.angleId }, facts);
  s.scrollStop = hookPart.scores.scrollStop;
  if (hookPart.scores.scrollStop < 8) why.push('weak opening line');
  if (hookText && opener !== hookText) { s.clarity -= 1; why.push('opening line differs from its hook'); }
  const body = script.beats.slice(1, -1);
  const feats = script.featureIds.map((id) => facts.features.get(id)).filter(Boolean);
  const vo = script.beats.map((b) => b.voiceover).join(' ');
  const generic = body.filter((b) => !feats.some((f) => mentions(b.voiceover, f)) && !/"[^"]+"/.test(b.voiceover) && !ATTRIBUTED.test(b.voiceover));
  if (generic.length) { s.specificity -= 2 * generic.length; why.push(`${generic.length} beat(s) say nothing product-specific`); }
  const stage = script.beats.slice(1).filter((b) => STAGE_DIRECTION.test(b.voiceover));
  if (stage.length) { s.native -= 3 * stage.length; why.push(`${stage.length} voiceover line(s) are directions, not speech`); }
  const ad = adSpeakIn(vo);
  if (ad.length) { s.native -= 2 * ad.length; why.push(`ad-speak: ${ad.join(', ')}`); }
  if (/if that looks useful/i.test(vo)) { s.native -= 1; why.push('limp CTA'); }
  if (/\b(hero|homepage)\b/i.test(vo)) { s.native -= 1.5; why.push('says an internal page label out loud'); }
  const rate = words(vo) / Math.max(1, script.durationSec);
  if (rate > 3) { s.clarity -= 3; why.push(`${rate.toFixed(1)} words/sec is too fast`); }
  const unknown = script.featureIds.filter((id) => !facts.features.has(id));
  if (unknown.length) { s.grounding -= 5; why.push(`claims unobserved ${unknown.join(', ')}`); }
  const unmentioned = feats.filter((f) => !mentions(vo, f));
  if (unmentioned.length) { s.grounding -= 2 * unmentioned.length; why.push(`cites ${unmentioned.map((f) => f.id).join(', ')} but never shows it`); }
  const badAssets = script.beats.filter((b) => b.assetRef && !facts.evidence.has(b.assetRef) && !/^screenshots\/000-/.test(b.assetRef));
  if (badAssets.length) { s.grounding -= 2; why.push('beat shows an asset that is not evidence'); }
  const figs = unsupportedFigures(vo, facts);
  if (figs.length) { s.compliance -= 3 * figs.length; why.push(`unsupported figure(s): ${figs.join(', ')}`); }
  if (TESTIMONIAL.test(vo)) { s.compliance -= 6; why.push('implied testimonial'); }
  if (/\b(figures|prices|views)\b/i.test(vo) && !/site'?s own|check the page|not verified/i.test(vo) && FIGURE.test(vo)) { s.compliance -= 2; why.push('quotes site figures without attribution'); }
  FIGURE.lastIndex = 0;
  return finish(s, why);
}

// ---------- rewriting ----------
function hookCandidates(hook, facts) {
  const angle = facts.angles.get(hook.angleId);
  const feats = (angle?.featureIds || []).map((id) => facts.features.get(id)).filter(Boolean);
  const P = facts.name, out = [];
  const push = (tpl, text) => out.push({ tpl, text });
  for (const f of feats) {
    const L = f.label;
    const fresh = (q) => !L.toLowerCase().includes(q.toLowerCase()) && !q.toLowerCase().includes(L.toLowerCase());
    for (const q of f.quotes.filter((q) => words(q) >= 2 && words(q) <= 7 && fresh(q))) {
      if (q.endsWith('?')) push('ask', `"${q}" I made ${P} answer it on camera.`);
      else {
        push('says', `${P}'s site says "${q}", so I clicked to check.`);
        push('why', `Why does ${P}'s ${L} say "${q}"?`);
        push('before', `Before you book ${P}, read "${q}" on its site.`);
      }
    }
    push('pov', `POV: you click through ${P}'s ${L} before booking a call.`);
    push('tested', `I tested ${P}'s ${L} so you don't have to.`);
  }
  const seen = new Set();
  return out.filter((c) => words(c.text) <= HOOK_MAX_WORDS && !seen.has(c.text) && seen.add(c.text));
}

/** Best rewrite the templates can make that beats the current score; `avoid` holds texts already tried. */
// `templates` counts template use across the plan so ten hooks don't all come out in the same mould.
export function rewriteHook(hook, facts, { avoid = new Set(), used = new Set(), templates = new Map() } = {}) {
  const current = scoreHook(hook, facts).overall;
  let best = null;
  for (const { tpl, text } of hookCandidates(hook, facts)) {
    if (avoid.has(text) || used.has(text)) continue;
    const r = scoreHook({ ...hook, text }, facts);
    const rank = r.overall - 0.8 * (templates.get(tpl) || 0);
    if (r.overall > current && (!best || rank > best.rank)) best = { text, tpl, rank, overall: r.overall };
  }
  if (!best) return null;
  templates.set(best.tpl, (templates.get(best.tpl) || 0) + 1);
  const f = facts.features.get(facts.angles.get(hook.angleId)?.featureIds?.find((id) => best.text.includes(facts.features.get(id)?.label) || facts.features.get(id)?.quotes.some((q) => best.text.includes(q))));
  return { ...hook, text: best.text, visualOpener: f ? `Screen recording of ${f.name}, the on-page text already in frame.` : hook.visualOpener };
}

export function rewriteScript(script, facts, hookText) {
  const feats = script.featureIds.map((id) => facts.features.get(id)).filter(Boolean);
  const beats = script.beats.map((b) => ({ ...b }));
  if (hookText && beats[0]) { beats[0].voiceover = hookText; beats[0].onScreenText = hookText; }
  const spare = feats.flatMap((f) => f.quotes.filter((q) => !f.label.toLowerCase().includes(q.toLowerCase())).map((q) => ({ f, q })))
    .filter(({ q }) => !beats.some((b) => b.voiceover.includes(q)));
  const LEADS = [(L) => `Then the ${L}, and it says`, (L) => `Look at the ${L}. Right there:`, (L) => `On the ${L} it literally says`];
  let lead = 0;
  for (const b of beats.slice(1, -1)) {
    const needs = STAGE_DIRECTION.test(b.voiceover) || (!feats.some((f) => mentions(b.voiceover, f)) && !/"[^"]+"/.test(b.voiceover) && !ATTRIBUTED.test(b.voiceover));
    if (!needs) continue;
    const pick = spare.shift();
    if (!pick) { if (feats[0]) b.voiceover = `I went through the ${feats[0].label} one step at a time, so you can see each one.`; continue; }
    b.voiceover = `${LEADS[lead++ % LEADS.length](pick.f.label)} "${pick.q}".`;
    b.onScreenText = `"${pick.q}"`;
  }
  const missing = feats.filter((f) => !mentions(beats.map((b) => b.voiceover).join(' '), f));
  if (missing.length && beats.length > 2) {
    const f = missing[0], q = f.quotes[0];
    const slot = beats[beats.length - 2];
    slot.voiceover = `${slot.voiceover} And on the ${f.label}${q ? `: "${q}"` : ''}.`.replace(/\.\s+And/, '. And');
  }
  const last = beats[beats.length - 1];
  if (last && /if that looks useful/i.test(last.voiceover)) last.voiceover = last.voiceover.replace(/if that looks useful,\s*/i, 'Want yours looked at? ').replace(/\? (\w)/, (_, c) => `? ${c.toUpperCase()}`);
  for (const b of beats) for (const w of AD_SPEAK) b.voiceover = b.voiceover.replace(new RegExp(w, 'ig'), '').replace(/\s{2,}/g, ' ').trim();
  return { ...script, beats };
}
