// Offline sample kit for `npm run teardown -- --mock`: five ad concepts (drawn as SVG, no image API), X and Reddit
// post drafts, and UGC hooks. Everything here is clearly a SAMPLE proposal; nothing is observed product fact.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function wrapLines(text, max) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

const PALETTES = [
  ['#16352a', '#f7f4ec', '#86c79f'],
  ['#f7f4ec', '#1d2b24', '#c8744a'],
  ['#2f6b4a', '#ffffff', '#f2b84b'],
  ['#e3efe5', '#16352a', '#2f6b4a'],
  ['#1d2b24', '#f2b84b', '#ffffff'],
];

// 1024x1024 SVG ad card as a data URL (the canvas draws SVG data URLs, like seed-demo.mjs does)
function adCard(i, headline, sub) {
  const [bg, fg, accent] = PALETTES[i % PALETTES.length];
  const h = wrapLines(headline, 16).slice(0, 4);
  const s = wrapLines(sub, 34).slice(0, 3);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif">
<rect width="1024" height="1024" fill="${bg}"/>
<circle cx="${i % 2 ? 820 : 210}" cy="${i % 2 ? 190 : 820}" r="260" fill="${accent}" opacity=".35"/>
<rect x="72" y="72" width="120" height="14" rx="7" fill="${accent}"/>
${h.map((l, n) => `<text x="72" y="${300 + n * 118}" font-size="104" font-weight="800" fill="${fg}">${esc(l)}</text>`).join('')}
${s.map((l, n) => `<text x="72" y="${340 + h.length * 118 + n * 48}" font-size="38" fill="${fg}" opacity=".85">${esc(l)}</text>`).join('')}
<text x="72" y="960" font-size="28" font-weight="700" fill="${accent}">SAMPLE CONCEPT</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export function mockKit({ name = 'Your product', oneLiner = 'See what it does before you try it.' } = {}) {
  const ads = [
    ['hero', `${name} in 30 seconds`, oneLiner],
    ['editorial', `What ${name} actually does`, 'Straight from a recorded walkthrough, not the pitch deck.'],
    ['benefit', `Fewer dead ends in ${name}`, 'We found the friction first, so your users do not hit it.'],
    ['context', 'Built for the first five minutes', `${name} onboarding, tested one step at a time.`],
    ['typographic', name, 'See it before you try it.'],
  ].map(([angle, headline, sub], i) => ({ angle, headline, body: sub, image: adCard(i, headline, sub), sample: true }));

  const campaigns = [
    {
      channel: 'x', title: `X launch, 14 days: ${name}`, objective: `Get qualified visits to ${name} from people who recognise the problem.`,
      posts: [
        { title: 'Post 1: the walkthrough', copy: `We watched someone use ${name} for the first time. Here is every step, with the screenshot. Where would you have quit?` },
        { title: 'Post 2: one finding', copy: `One thing a recorded run caught in ${name}: the part everyone skips is the part that loses people. Thread below.` },
        { title: 'Post 3: proof', copy: `Verified means we saw it twice. Unverified means once, and we say so. That is how we report on ${name}.` },
      ],
    },
    {
      channel: 'reddit', title: `Reddit, 14 days: ${name}`, objective: 'Be useful in two or three relevant communities, disclose affiliation, no hard sell.',
      posts: [
        { title: `We tore down ${name}'s first-run. Here is what we found`, copy: 'Long-form post with screenshots, the ranked list, and what we are unsure about. Disclosure: we work on the product.' },
        { title: `Ask us anything about ${name}`, copy: 'A plain AMA-style post that answers real questions from the run. Needs a community-rules check before posting.' },
      ],
    },
  ];

  const ugc = {
    source: 'sample',
    hooks: [
      { id: 'H1', text: `I clicked through ${name} so you don't have to.`, format: 'screen-recording-voiceover' },
      { id: 'H2', text: `POV: you open ${name} for the first time.`, format: 'pov' },
      { id: 'H3', text: 'The one screen that decides if people stay.', format: 'problem-solution' },
    ],
    scripts: [
      { id: 'S1', title: `${name}: walk through it live`, platform: 'tiktok', durationSec: 30 },
      { id: 'S2', title: `${name}: first-run, step by step`, platform: 'instagram-reels', durationSec: 25 },
    ],
  };
  return { ads, campaigns, ugc, label: 'SAMPLE (offline mock, not model output)' };
}
