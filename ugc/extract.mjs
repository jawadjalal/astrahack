// Step 1 of the planner: turn a runner report.json into observed features and journeys.
// Pure and deterministic. Nothing here is invented: every feature is a page or section the run
// actually visited, every fact is text the run actually read, every evidence path is an asset in the report.

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Trim to a word boundary, with an ellipsis when cut. */
export function clip(text, max) {
  const t = clean(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max).replace(/\s+\S*$/, '');
  return `${cut}...`;
}

function parseUrl(u) {
  try { return new URL(u); } catch { return null; }
}
const pathOf = (u) => parseUrl(u)?.pathname || '/';
const sectionOf = (u) => { const x = parseUrl(u); return x ? `${x.pathname}${x.hash}` : '/'; };

/** "Work: launch film, UGC content · Ignura" -> "Work: launch film, UGC content". */
function titleLabel(title, brand) {
  const parts = clean(title).split(/\s[·|–—-]\s/).map(clean).filter(Boolean);
  const pick = parts.find((p) => p.toLowerCase() !== String(brand || '').toLowerCase());
  return pick || '';
}

/** Window of page text around the first occurrence of `needle`, or '' when absent. */
function snippetAround(text, needle, before = 40, after = 220) {
  const hay = clean(text);
  const i = hay.toLowerCase().indexOf(clean(needle).toLowerCase());
  if (i < 0) return '';
  const start = Math.max(0, i - before), end = Math.min(hay.length, i + clean(needle).length + after);
  let s = hay.slice(start, end);
  if (start > 0) s = s.replace(/^\S*\s/, '');
  if (end < hay.length) s = s.replace(/\s\S*$/, '');
  return s;
}

// Numbers a script could repeat as a claim: money, percentages, "10k+", "50k views".
const NUM = '\\d(?:[\\d,]*\\d)?(?:\\.\\d+)?';
export const FIGURE_RE = new RegExp(
  `[£$€]\\s?${NUM}(?:[kKmM](?![a-zA-Z]))?\\+?|${NUM}(?:[kKmM](?![a-zA-Z])\\+?|%)(?:\\s(?:views|users|customers|downloads|signups|installs))?|${NUM}\\s(?:views|users|customers|downloads|installs)`, 'g');
const UNITS = /(views|users|customers|downloads|signups|installs)$/;
export const normFigure = (f) => f.toLowerCase().replace(/\s+/g, '').replace(/,/g, '').replace(UNITS, '').replace(/\+$/, '');

function findFigures(text) {
  return [...clean(text).matchAll(FIGURE_RE)].map((m) => ({ token: m[0].trim(), index: m.index }));
}

export function extractObserved(report) {
  if (!report || !Array.isArray(report.journeys)) throw new Error('Not a runner report: journeys[] is missing (expected report.json from node bin/astrahack.js).');
  const productObs = report.product || {};
  const firstTitle = productObs.title || report.journeys.flatMap((j) => j.steps).find((s) => s.observation?.title)?.observation.title || '';
  const brandGuess = clean(firstTitle.split(/\s[·|–—-]\s/)[0]) || clean(report.name).split(' ')[0] || 'The product';

  const assets = new Map(); // path -> asset record
  const addAsset = (path, rec) => { if (path && !assets.has(path)) assets.set(path, { path, ...rec }); };
  for (const a of report.assets || []) addAsset(a.path, { type: a.type || 'screenshot', journey: a.journey || null, step: a.step ?? null, shows: a.purpose || '' });

  const features = [];
  const journeys = [];
  const corpus = [clean(productObs.text)];
  const claimSeen = new Map();

  report.journeys.forEach((journey) => {
    const stepsOut = [];
    const t0 = Date.parse(journey.startedAt);
    const groups = new Map(); // pathname -> steps
    let prevText = null;
    for (const s of journey.steps || []) {
      const obs = s.observation;
      const target = s.selector || s.url || s.text || (s.action === 'assertUrl' ? pathOf(obs?.url) : '') || '';
      const tSec = journey.video && s.startedAt && t0 ? Math.max(0, Math.round((Date.parse(s.startedAt) - t0) / 1000)) : null;
      const rec = {
        index: s.index, action: s.action, target, status: s.status, url: obs?.url || null,
        screenshot: s.screenshot || null, tSec,
        changed: s.action === 'click' && obs && prevText != null ? clean(obs.text) !== clean(prevText) : null,
      };
      stepsOut.push(rec);
      if (obs?.text != null) {
        prevText = obs.text;
        corpus.push(clean(obs.text));
        for (const f of findFigures(obs.text)) {
          const key = normFigure(f.token);
          const page = sectionOf(obs.url);
          if (!claimSeen.has(key)) claimSeen.set(key, { token: f.token, sentence: clip(snippetAround(obs.text, f.token, 60, 80), 160), page, pages: [page], evidence: s.screenshot || null });
          else if (!claimSeen.get(key).pages.includes(page)) claimSeen.get(key).pages.push(page);
        }
      }
      if (s.screenshot) {
        const shows = [`${s.action}${target ? ` ${target}` : ''}`, obs?.url ? `on ${sectionOf(obs.url)}` : ''].filter(Boolean).join(' ');
        addAsset(s.screenshot, { type: 'screenshot', journey: journey.name, step: s.index, shows });
        const a = assets.get(s.screenshot);
        if (!a.shows || a.journey == null) Object.assign(a, { journey: journey.name, step: s.index, shows });
      }
      if (obs) {
        const key = pathOf(obs.url);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ s, rec, obs });
      }
    }
    if (journey.video) addAsset(journey.video, { type: 'video', journey: journey.name, step: null, shows: `recording of "${journey.name}"` });

    const single = groups.size <= 1;
    const featureIds = [];
    for (const [pathname, items] of groups) {
      const last = items[items.length - 1].obs;
      const label = single ? journey.name : (titleLabel(last.title, brandGuess) || clean(last.headings?.[0]?.text) || pathname);
      const evidence = [...new Set(items.map((x) => x.s.screenshot).filter(Boolean))].slice(0, 8);
      if (!evidence.length) continue; // no evidence, no feature
      if (journey.video && evidence.length) evidence.push(journey.video);

      const facts = [];
      for (const { s, obs, rec } of items) {
        if (s.action !== 'assertText' || s.status !== 'passed' || !s.text) continue;
        const snippet = snippetAround(obs.text, s.text);
        if (snippet && !facts.some((f) => f.assertedText === s.text)) facts.push({ assertedText: s.text, text: clip(snippet, 260), step: rec.index, screenshot: s.screenshot || null });
      }
      const clicks = items.filter((x) => x.s.action === 'click' && x.s.status === 'passed')
        .map(({ rec }) => ({ selector: rec.target, step: rec.index, pageChanged: rec.changed, screenshot: rec.screenshot }));
      const failed = items.filter((x) => x.s.status === 'failed').length;
      const where = sectionOf(items[0].obs.url);
      const asserted = facts.map((f) => `"${clip(f.assertedText, 60)}"`);
      const whatItDoes = [
        `Observed at ${where}${last.title ? ` (page title: "${clip(last.title, 90)}")` : ''}.`,
        facts.length ? `The run confirmed this text on the page: ${asserted.slice(0, 3).join(', ')}.` : '',
        facts[0] ? `Nearby page copy: "${clip(facts[0].text, 200)}"` : (last.headings?.length ? `Headings seen: ${last.headings.slice(0, 3).map((h) => `"${clip(h.text, 60)}"`).join(', ')}.` : ''),
        clicks.length ? `The run clicked ${clicks.slice(0, 4).map((c) => c.selector).join(', ')}${clicks.some((c) => c.pageChanged) ? ' and the page content changed in response' : ''}.` : '',
        failed ? `${failed} step(s) failed here; see findings.` : '',
      ].filter(Boolean).join(' ');

      const id = `F${features.length + 1}`;
      features.push({
        id, name: clip(label, 80), whatItDoes, evidence, journey: journey.name, page: where,
        steps: items.map((x) => x.rec.index), facts, clicks,
        headings: (last.headings || []).slice(0, 4).map((h) => clean(h.text)),
        video: journey.video || null, failedSteps: failed,
      });
      featureIds.push(id);
    }
    journeys.push({ name: journey.name, status: journey.status, video: journey.video || null, featureIds, steps: stepsOut });
  });

  // Page text around claims the site itself makes. Read, not verified.
  const siteClaims = [...claimSeen.values()].slice(0, 24);

  const friction = [
    ...(report.findings || []).map((f) => `${f.severity || 'medium'}${f.journey ? ` (${f.journey})` : ''}: ${clean(f.summary)}${f.actual ? ` Actual: ${clip(f.actual, 140)}` : ''}`),
    ...(report.limitations || []).map((l) => `Run limitation: ${clean(l)}`),
  ];
  const usedFill = report.journeys.some((j) => (j.steps || []).some((s) => s.action === 'fill'));
  const videos = [...assets.values()].filter((a) => a.type === 'video');

  const [namePart, ...rest] = clean(firstTitle).split(/\s[·|–—-]\s/);
  return {
    product: {
      url: productObs.url || report.target?.url || '', title: clean(firstTitle), description: clean(productObs.description),
      name: clean(namePart) || brandGuess, tagline: clean(rest.join(' · ')), headings: (productObs.headings || []).map((h) => clean(h.text)),
      ctaLabels: [...new Set((productObs.controls || []).map((c) => clean(c.label)).filter((l) => /\b(book|start|get|try|sign|join|buy|download|subscribe|demo|contact)\b/i.test(l)))].slice(0, 5),
    },
    features, journeys, assets: [...assets.values()], videos, siteClaims, friction,
    corpus: corpus.join(' \n '), usedFill, status: report.status, runName: report.name,
  };
}
