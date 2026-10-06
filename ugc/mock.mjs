// Deterministic stand-in for the text model. No network, no key, same output every time.
// It builds a plan from the observed features only: copy quotes text the run actually read,
// screenshots are the ones the run captured, and assumptions are labelled as proposals.
// Returns the same shape the model returns (PLAN_SCHEMA without observedFeatures / frictionFromQa).
import { clip } from './extract.mjs';

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean);
const TRAILING = new Set(['a', 'an', 'the', 'for', 'of', 'to', 'and', 'or', 'in', 'on', 'like', 'that', 'with']);
// Whole phrase when it fits, else cut on a word boundary without leaving a dangling "for a".
function shortName(s, n = 8) {
  const w = words(s).slice(0, n);
  while (w.length > 1 && TRAILING.has(w[w.length - 1].toLowerCase())) w.pop();
  return w.join(' ');
}
const featureText = (f) => [f.name, ...f.facts.flatMap((x) => [x.assertedText, x.text]), ...f.headings].join(' ');
const count = (re, text) => (text.match(new RegExp(re.source, 'gi')) || []).length;

const PLATFORM_WORDS = [
  ['tiktok', /tik\s?tok/i], ['instagram-reels', /instagram|reels?/i], ['youtube-shorts', /youtube|shorts/i],
  ['linkedin', /linked\s?in/i], ['x', /\b(x|twitter)\b(?!\w)/i],
];
const DEFAULT_PLATFORMS = ['tiktok', 'instagram-reels', 'youtube-shorts', 'linkedin'];

export function platformsFromBrief(brief = '') {
  const found = PLATFORM_WORDS.filter(([, re]) => re.test(brief)).map(([p]) => p);
  return found.length ? found : DEFAULT_PLATFORMS;
}

// Each archetype is a reusable creator angle. `match` scores a feature; the best unused feature
// becomes the primary. `demo` scores by observed interactions, `overview`/`tour` always apply.
const ARCHETYPES = [
  { key: 'demo', score: (f) => f.clicks.length + (f.clicks.some((c) => c.pageChanged) ? 1 : 0), platform: 'tiktok', format: 'screen-recording-voiceover', creator: 'C1', durs: [2, 6, 10, 8, 4] },
  { key: 'price', match: /pric|cost|£|\$|€|a month|upfront|from [£$€]/i, platform: 'youtube-shorts', format: 'problem-solution', creator: 'C2', durs: [2, 5, 9, 6, 3] },
  { key: 'proof', match: /case study|views|numbers|results|worked with|customers|testimonial|real /i, platform: 'tiktok', format: 'reaction', creator: 'C2', durs: [2, 6, 10, 7, 4] },
  { key: 'process', match: /\bhow\b|weeks?\b|steps?\b|process|plan\b|timeline/i, platform: 'instagram-reels', format: 'tutorial', creator: 'C1', durs: [2, 6, 12, 9, 6] },
  { key: 'faq', match: /faq|ask us|questions?\b|\?/i, platform: 'linkedin', format: 'talking-head', creator: 'C2', durs: [2, 6, 10, 6, 4] },
  { key: 'free', match: /free|try\b|test|teardown|tool|sample/i, platform: 'tiktok', format: 'green-screen', creator: 'C3', durs: [2, 6, 10, 7, 5] },
  { key: 'overview', always: true, platform: 'instagram-reels', format: 'talking-head', creator: 'C3', durs: [2, 6, 9, 6, 4] },
  { key: 'tour', always: true, platform: 'youtube-shorts', format: 'listicle', creator: 'C1', durs: [2, 7, 7, 7, 4] },
];

// Copy per archetype. {p}=product, {f}=primary feature, {q}=a phrase the run read on the page.
const COPY = {
  demo: {
    angle: 'Walk through it live',
    insight: 'A viewer judges a product faster by watching it used than by reading a description.',
    why: 'Screen walkthroughs show the real interface, so nothing has to be taken on trust.',
    hookA: ["I clicked through {p} so you don't have to.", 'Screen recording of {f}, cursor already moving.', 'screen-recording-voiceover'],
    hookB: ['POV: you open {p} for the first time.', 'Phone-camera POV, thumb hovering over the screen.', 'pov'],
    actText: "Watch what changes", actShot: "Cursor visible, tap through the controls on screen.",
    show: 'First stop: {f}.{qline}', act: 'Then I tapped around, and the page changed as I clicked.',
  },
  price: {
    angle: 'Say the price out loud',
    insight: 'Pricing is where people drop off. Reading the real tiers aloud removes the guesswork.',
    why: 'Straight talk on cost earns trust and filters for serious buyers.',
    hookA: ['What does {p} actually cost? I read the pricing.', 'Creator at a desk, pricing screen behind them.', 'problem-solution'],
    hookB: ['{p} pricing, explained in 30 seconds.', 'Pricing screen full frame with a timer overlay.', 'listicle'],
    actText: "Prices on the page", actShot: "Hold on the pricing section and point at each option as you read it.",
    show: 'This is {f}.{qline}', act: '{money}',
  },
  proof: {
    angle: 'Proof you can see',
    insight: 'The site shows real examples instead of promises. Pointing at them is more credible than summarising them.',
    why: 'Reacting to evidence on screen feels like a recommendation, not a pitch.',
    hookA: ['{p} put its real numbers on the page. Let us look.', 'Creator leans in toward the screen, reaction framing.', 'reaction'],
    hookB: ['Before you trust any {cat}, check the proof.', 'Creator to camera, proof page visible over the shoulder.', 'talking-head'],
    actText: "The site's own numbers", actShot: "Zoom in on the figures the page shows.",
    show: 'On the "{f}" page, it says "{q}".', act: '{claims}',
  },
  process: {
    angle: 'What happens after you say yes',
    insight: 'People hesitate when they cannot picture the process. Walking the steps makes it feel doable.',
    why: 'A step-by-step walkthrough answers "what am I signing up for" before the viewer asks.',
    hookA: ['Here is what working with {p} looks like, step by step.', 'Screen recording starting at the first step.', 'tutorial'],
    hookB: ['I mapped out the {p} process so you can see it.', 'Hand-drawn checklist on camera, then the screen.', 'day-in-the-life'],
    actText: "Step by step", actShot: "Scroll the steps in order, pausing on each.",
    show: 'Start at {f}.{qline}', act: 'Pause on each step as it appears on screen, and say it in your own words.',
  },
  faq: {
    angle: 'Answer the question everyone asks',
    insight: 'FAQ questions are the objections viewers already have. Answering one on camera meets them where they are.',
    why: 'Objection-first content stops the scroll for viewers who are close to deciding.',
    hookA: ['The question everyone asks {p}, answered.', 'Creator to camera, question as a big caption.', 'talking-head'],
    hookB: ['I read the whole {p} FAQ. Here is the one that matters.', 'Scroll through the FAQ at speed, then stop.', 'reaction'],
    actText: "The question, answered", actShot: "Expand the answer on screen and read along.",
    show: 'The FAQ asks: "{q}".', act: 'Read the answer straight off the page, then say what you think of it.',
  },
  free: {
    angle: 'Try before you commit',
    insight: 'A low-risk first step makes saying yes easier. Showing exactly what that step is makes it concrete.',
    why: 'Concrete first steps convert curiosity into action.',
    hookA: ['There is a way to try {p} first.', 'Green screen: creator in front of the product page.', 'green-screen'],
    hookB: ['POV: you test {f} before anything else.', 'Phone POV scrolling to the first step.', 'pov'],
    actText: "The first step", actShot: "Show the screen where the first step lives.",
    show: 'Start with {f}.{qline}', act: 'Show the screen where that first step lives and say what it is in your own words.',
  },
  overview: {
    angle: 'What is it, in 15 seconds',
    insight: 'Most viewers just need to know what the product is. A short plain answer beats a clever one.',
    why: 'A clear one-line explanation is the cheapest way to qualify viewers.',
    hookA: ['{p}, in 15 seconds.', 'Creator to camera, product homepage on a second screen.', 'talking-head'],
    hookB: ['Heard of {p}? Here is the quick version.', 'Creator holds up a phone showing the homepage.', 'problem-solution'],
    actText: "In plain words", actShot: "Cut between the creator and the headline on screen.",
    show: 'Here is {f}.{qline}', act: 'Read the headline straight from the page, then say who you think it is for.',
  },
  tour: {
    angle: 'Three things worth seeing',
    insight: 'A short list is easy to watch and easy to share, and each item is a real screen.',
    why: 'Listicles give each beat a visual and a reason to keep watching.',
    hookA: ["Three things I found on {p}'s site.", 'Big number 1 over a screen recording.', 'listicle'],
    hookB: ['I explored {p} so you can skip to the good parts.', 'Fast scroll through the site, then stop on the best bit.', 'screen-recording-voiceover'],
    actText: "Why it stands out", actShot: "Hold the screen while the creator reacts.",
    show: 'Number one: {f}.{qline}', act: 'Hold on the screen for a beat and say why it caught your eye.',
  },
};

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const hms = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

export function mockPlan(observed, brief = '') {
  const { product, features, journeys, assets, siteClaims } = observed;
  if (!features.length) throw new Error('The run has no observed features with screenshots, so there is nothing to ground a plan in.');
  const p = product.name || 'the product';
  const platforms = platformsFromBrief(brief);
  const pick = (preferred) => (platforms.includes(preferred) ? preferred : platforms[0]);
  const category = (product.tagline || '').replace(/^the\s+/i, '').toLowerCase() || 'product';
  const cat = shortName(category, 6);
  const cta = product.ctaLabels.find((l) => /book|start|get|try|sign|join|buy|download/i.test(l)) || product.ctaLabels[0] || `Check out ${p}`;
  const heroShot = assets.find((a) => a.type === 'screenshot')?.path || features[0].evidence[0];

  // Choose archetypes and bind each to its best unused feature (and a runner-up as the second beat).
  const scoreOf = (a, f) => (a.score ? a.score(f) : a.match ? count(a.match, featureText(f)) : 0);
  const used = new Set();
  const chosen = [];
  const bind = (a) => {
    const ranked = features.map((f, i) => ({ f, i, s: a.always ? 1 : scoreOf(a, f) })).filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s || x.i - y.i);
    const primary = (ranked.find((x) => !used.has(x.f.id)) || (a.always ? ranked[0] : null))?.f;
    if (!primary) return;
    used.add(primary.id);
    const second = ranked.find((x) => x.f.id !== primary.id && !used.has(x.f.id))?.f || features.find((f) => f.id !== primary.id) || null;
    chosen.push({ a, primary, second });
  };
  for (const key of ['demo', 'price', 'proof', 'process', 'faq', 'free']) { if (chosen.length < 5) bind(ARCHETYPES.find((x) => x.key === key)); }
  for (const key of ['overview', 'tour']) { if (chosen.length < 3) bind(ARCHETYPES.find((x) => x.key === key)); }

  const audiences = [
    { id: 'A1', name: 'People the site is written for', pain: `They are not sure ${p} is worth their time and want to see it working before they commit.`, desire: `A fast, honest look at what ${p} does and what it costs.`, platforms: [...new Set([pick('tiktok'), pick('instagram-reels')])] },
    { id: 'A2', name: 'Careful comparers', pain: 'It is hard to tell options apart without clear pricing, process and proof.', desire: 'Straight answers on cost, timing and what is included.', platforms: [...new Set([pick('youtube-shorts'), pick('linkedin')])] },
  ];
  const creators = [
    { id: 'C1', archetype: 'Hands-on explorer', profile: `Age 20 to 32, micro creator (5k to 50k followers) whose audience overlaps with ${p}'s (${cat}). Films screen walkthroughs with voiceover and is comfortable narrating without a script.`, whyThem: 'Credibility comes from visibly using the product, which fits the screen-recording angles.', audienceId: 'A1' },
    { id: 'C2', archetype: 'Straight-talking comparer', profile: 'Age 25 to 40, small but trusted audience (2k to 30k) that likes breakdowns of pricing and process. Talking-head with a calm, direct tone.', whyThem: 'Viewers who compare options trust a creator who reads the details aloud.', audienceId: 'A2' },
    { id: 'C3', archetype: 'Peer who just went through it', profile: `Age 22 to 35, founder or builder who shares what they are working on. Works in POV and story formats.`, whyThem: 'A peer voice makes the product feel like a next step, not an ad.', audienceId: 'A1' },
  ];

  const angles = [], hooks = [], scripts = [];
  chosen.forEach(({ a, primary, second }, i) => {
    const c = COPY[a.key];
    const angleId = `ANG${i + 1}`;
    const featureIds = [primary.id, ...(second && a.key !== 'faq' ? [second.id] : [])];
    const vars = { p, f: shortName(primary.name, 6), cat };
    angles.push({
      id: angleId, name: c.angle, insight: c.insight, audienceId: a.key === 'price' || a.key === 'faq' ? 'A2' : 'A1',
      featureIds, whyItWorks: `${c.why} Grounded in "${primary.name}" (${primary.page}).`,
    });
    const [hA, hB] = [c.hookA, c.hookB].map(([text, opener, format], k) => ({
      id: `H${i * 2 + k + 1}`, angleId, text: fill(text, vars), format, visualOpener: fill(opener, vars),
    }));
    hooks.push(hA, hB);

    // Beats. Screenshots come from the run; the quoted phrase is page text the run confirmed.
    const q = primary.facts[0]?.assertedText || '';
    const qline = q ? ` The page says "${clip(q, 70)}".` : '';
    const here = (x) => (x.pages.includes(primary.page) ? 0 : x.pages.some((pg) => pg.split('#')[0] === primary.page.split('#')[0]) ? 1 : 2);
    const nearby = siteClaims.filter((x) => here(x) < 2).sort((x, y) => here(x) - here(y));
    const money = nearby.filter((x) => /[£$€]/.test(x.token)).slice(0, 3).map((x) => x.token);
    const moneyLine = money.length ? `The site lists prices like ${money.join(', ')}. Check the page for current numbers.` : 'Read the options on screen exactly as the page lists them.';
    const claimsHere = nearby.slice(0, 2).map((x) => x.token);
    const claimsLine = claimsHere.length ? `It shows figures like ${claimsHere.join(' and ')}. Those are the site's own numbers, and I have not verified them.` : 'Everything here is the site speaking for itself, so read it as theirs.';
    const interact = primary.clicks.find((x) => x.pageChanged) || primary.clicks[0];
    const journey = journeys.find((j) => j.name === primary.journey);
    const vidStep = primary.video && journey?.steps.find((s) => s.index === interact?.step && s.tSec != null);
    const anchor = primary.facts[0]?.screenshot || primary.evidence[0];
    const act = fill(c.act, { money: moneyLine, claims: claimsLine });
    const secondVars = second ? { ...vars, f: shortName(second.name) } : vars;
    const [d1, d2, d3, d4, d5] = a.durs;
    let t = 0;
    const span = (d) => { const s = `${t}-${t + d}s`; t += d; return s; };
    const screenShot = (what) => `Screen recording of ${what}: slow scroll, then hold on the text.`;
    const beats = [
      { t: span(d1), voiceover: hA.text, onScreenText: hA.text, shot: hA.visualOpener, assetRef: null },
      { t: span(d2), voiceover: fill(c.show, { ...vars, f: shortName(primary.name), qline, q: clip(q, 70) }), onScreenText: shortName(primary.name), shot: screenShot(primary.name), assetRef: anchor },
      {
        t: span(d3), voiceover: act, onScreenText: c.actText,
        shot: vidStep ? `Use the recording of "${primary.journey}" (video at ${hms(vidStep.tSec)}), cursor visible.` : c.actShot,
        assetRef: vidStep ? primary.video : (interact?.screenshot || primary.evidence[1] || anchor),
      },
      second ? {
        t: span(d4), voiceover: `Next up: ${shortName(second.name)}.${second.facts[0] ? ` It reads "${clip(second.facts[0].assertedText, 70)}".` : ''}`,
        onScreenText: shortName(second.name), shot: screenShot(second.name), assetRef: second.facts[0]?.screenshot || second.evidence[0],
      } : {
        t: span(d4), voiceover: `Say in one line what you would do next on ${p}.`, onScreenText: secondVars.f, shot: 'Creator to camera, close framing.', assetRef: null,
      },
      { t: span(d5), voiceover: `If that looks useful, ${cta.toLowerCase()}. Link in bio.`, onScreenText: cta, shot: 'Creator to camera, point down to the link in bio, then hold the homepage on screen.', assetRef: heroShot },
    ];
    scripts.push({
      id: `S${i + 1}`, title: `${p}: ${c.angle.toLowerCase()}`, angleId, hookId: hA.id, creatorId: a.creator,
      platform: pick(a.platform), format: a.format, durationSec: t, beats, cta: `${cta} (link in bio)`, featureIds,
    });
  });

  const n = scripts.length;
  const platformList = [...new Set(scripts.map((s) => s.platform))];
  const calendar = [];
  const hookFor = (sc, alt) => hooks.filter((h) => h.angleId === sc.angleId)[alt ? 1 : 0] || hooks.find((h) => h.id === sc.hookId);
  for (let d = 1; d <= 7; d++) {
    const sc = scripts[(d - 1) % n];
    const alt = d > n;
    const h = hookFor(sc, alt);
    calendar.push({ day: d, platform: sc.platform, scriptId: sc.id, note: `Test cut: ${angles.find((x) => x.id === sc.angleId).name}, ${alt ? 'alternate ' : ''}hook ${h.id} (${h.format}).` });
  }
  [9, 11, 13, 15, 17].forEach((d, i) => {
    const sc = scripts[i % n];
    calendar.push({ day: d, platform: sc.platform, scriptId: sc.id, note: 'Re-cut of the best performer so far. Swap in a new hook for the first 2 seconds.' });
  });

  const proposals = [
    `Category, one-liner and audience for ${p} are read from the site title and description, not from using the product. Confirm them with the team.`,
    'Audiences A1 and A2 (pains and desires) are assumptions.',
    'Creator archetypes, casting notes and the campaign cadence are proposals.',
    'Angles, hooks and scripts are creative proposals. Only the features they cite are observed; the voiceover wording is not.',
    'KPI targets are starting benchmarks, not forecasts.',
    ...(observed.usedFill ? [] : ['The run did not sign up, pay or use any logged-in flow. Nothing about in-product results or outcomes is supported by it.']),
    ...(brief.trim() ? [`Team brief (stated intent, not observed): ${clip(brief, 240)}`] : []),
  ];

  const first = (s) => s.replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0];
  return {
    product: {
      name: p,
      oneLiner: clip(product.description || product.tagline || product.title, 220),
      category,
      whoItsFor: product.description ? `Audience as the site describes it: ${clip(first(product.description), 160)}` : 'Not stated on the pages the run visited.',
    },
    audiences, angles, creators, hooks, scripts,
    creatorBrief: {
      mustShow: [...new Map(chosen.map(({ primary }) => [primary.id, `${primary.name} (${primary.page}), as captured in ${primary.evidence[0]}`])).values(), `The call to action on screen: "${cta}"`],
      dos: [
        'Show the real interface, using the supplied screenshots or your own recording of the live product.',
        'Open with the hook in the first 2 seconds and add burned-in captions.',
        'Read any quoted page copy exactly as written.',
        'Say plainly that the post is sponsored.',
      ],
      donts: [
        'Do not present the site\'s own numbers, prices or view counts as your own results. Attribute them ("their site says").',
        'Do not promise outcomes such as views, signups or revenue.',
        'Do not mention features that are not in the must-show list.',
        'Do not hide or bury the paid-partnership label.',
      ],
      deliverables: [
        `${scripts.length} vertical 9:16 videos, ${Math.min(...scripts.map((s) => s.durationSec))} to ${Math.max(...scripts.map((s) => s.durationSec))} seconds, with captions`,
        'Raw screen recording of the product for re-cuts',
        'Two hook variants per video for A/B testing',
        'Post links within 48 hours of publishing, for tracking',
      ],
      disclosure: "Label every post as an ad: use the platform's paid-partnership tool and add #ad. Disclose any payment or free access.",
    },
    campaign: {
      goal: `${brief.trim() ? `From the brief: ${clip(brief, 160)} ` : ''}Learn which angle, hook and creator pairing earns qualified visits to ${product.url || p}, then put more creators behind the winners.`,
      phases: [
        { name: 'Test', days: 'Days 1-7', objective: 'Find the strongest hook and angle at small cost.', actions: [
          `Publish ${scripts.length} scripts across ${platformList.join(', ')}, one per day, then repeat each with its alternate hook. Test matrix: hook (A/B per script) x creator x platform. Change one variable at a time, so finish both hooks on a script before changing creator or platform.`,
          'Keep every cut under 35 seconds with the same CTA, so only the hook and angle vary.',
          'Review 3-second hold rate and link clicks at 24 and 72 hours.',
          'Pause anything below the benchmark after 72 hours.',
        ] },
        { name: 'Scale', days: 'Days 8-21', objective: 'Put more creators behind the winning hook and angle.', actions: [
          'Brief 2 to 3 more creators on the top script.',
          'Re-cut the winner with two new hooks.',
          'Cross-post winners to the other platforms.',
        ] },
        { name: 'Always-on', days: 'Days 22-30', objective: 'Keep a steady flow of fresh cuts.', actions: [
          'Publish 3 posts a week.',
          'Refresh hooks weekly from comments and questions.',
          'Retire a creative when its 3-second hold rate falls.',
        ] },
      ],
      calendar,
      kpis: [
        { metric: '3-second hold rate', target: '30% or higher (proposed)', why: 'Shows whether the hook stops the scroll.' },
        { metric: 'Average watch time', target: '45% of video length or higher (proposed)', why: 'Shows whether the walkthrough holds attention.' },
        { metric: 'Link click-through rate', target: '1% or higher (proposed)', why: 'Shows whether viewers want to see the product.' },
        { metric: 'Cost per qualified visit', target: 'Set after the test week', why: 'No budget or baseline was supplied.' },
        { metric: 'Comments asking a product question', target: 'Track the count, no target', why: 'Surfaces objections to answer in the next hooks.' },
      ],
      budgetNote: 'No budget was supplied. Assumption: start with 3 creators on a flat fee or free access, then fund more of whichever script wins. Confirm figures with the team.',
    },
    proposals,
  };
}
