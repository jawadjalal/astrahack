// Turns a validated PLAN into the leads.json document. Every URL in a recipe is built here, from a
// query string, using each platform's own public search page. Nothing here is fetched or scraped:
// the links are for a human to click. Real leads come only from discover.mjs.

const enc = encodeURIComponent;

export const searchUrl = {
  reddit: (q) => `https://www.reddit.com/search/?q=${enc(q)}&sort=new&t=year`,
  subreddit: (sub, q) => `https://www.reddit.com/r/${sub}/search/?q=${enc(q)}&restrict_sr=1&sort=new&t=year`,
  x: (q) => `https://x.com/search?q=${enc(q)}&f=live`,
  xPeople: (q) => `https://x.com/search?q=${enc(q)}&f=user`,
  hn: (q) => `https://hn.algolia.com/?dateRange=pastYear&page=0&prefix=false&query=${enc(q)}&sort=byDate&type=story`,
  hnComments: (q) => `https://hn.algolia.com/?dateRange=pastYear&page=0&prefix=false&query=${enc(q)}&sort=byDate&type=comment`,
  productHunt: (q) => `https://www.producthunt.com/search?q=${enc(q)}`,
  indieHackers: (q) => `https://www.indiehackers.com/search?q=${enc(q)}`,
  google: (q) => `https://www.google.com/search?q=${enc(q)}`,
  googleSite: (site, q) => `https://www.google.com/search?q=${enc(`${q} site:${site}`)}`,
  tiktok: (q) => `https://www.tiktok.com/search?q=${enc(q)}`,
  youtube: (q) => `https://www.youtube.com/results?search_query=${enc(q)}`,
  linkedin: (q) => `https://www.linkedin.com/search/results/people/?keywords=${enc(q)}`,
  instagramTag: (t) => `https://www.instagram.com/explore/tags/${enc(t.replace(/[^A-Za-z0-9_]/g, '').toLowerCase())}/`,
};

/** Conservative, platform-level norms. They are reminders to check the real rules, not quotes of them. */
export const ETIQUETTE = {
  reddit: [
    'Read the subreddit rules and sidebar before commenting. Many communities restrict self-promotion; if the rules are unclear, ask the mods first.',
    'Lead with a useful answer to the person\'s actual question. Mention the product only if it genuinely fits, say you are affiliated, and never paste links in a first reply unless asked.',
    'No alt accounts, no vote asking, no copy-pasted replies across threads, no unsolicited DMs to people who did not ask for recommendations.',
  ],
  x: [
    'Reply only where your answer helps the person. One reply per thread; do not tag or pile on strangers.',
    'State the affiliation when you mention the product. No automated replies, no mass mentions, no DMs to people who do not follow you or have not opened DMs.',
    'Search on X needs a logged-in human; this kit only builds the search links.',
  ],
  hn: [
    'Comment to add information, not to promote. Show HN is for things people can try; follow the Show HN guidelines.',
    'Never ask for upvotes or coordinate votes. Disclose affiliation in the comment.',
  ],
  producthunt: ['Engage with makers and commenters honestly; disclose that you are the maker or affiliated; do not ask for upvotes in bulk.'],
  indiehackers: ['Contribute to the thread first. Promotion belongs in the places the community designates for it; check the guidelines.'],
  dm: [
    'DM only people who asked for recommendations, invited DMs, or replied to you. Say who you are and your affiliation in the first line.',
    'Many Discord and Slack groups ban unsolicited DMs and promotion outside a designated channel. Ask an admin first. Stop at the first no.',
  ],
  email: [
    'Email only a business address the person publishes for that purpose. Identify yourself and your affiliation, keep it short, and include a working opt-out and the sender details your local law requires (for example CAN-SPAM or GDPR).',
    'One follow-up at most. No scraped or purchased lists.',
  ],
  community: [
    'Confirm the community exists and is open to you, then read its rules channel before posting anything.',
    'Many Discord and Slack groups ban unsolicited DMs and promotion outside a designated channel. Ask an admin before sharing.',
  ],
  newsletter: ['Use the newsletter\'s own submission, sponsorship or contact route. Do not scrape subscriber data or email readers directly.'],
  creator: ['Use public contact details the creator publishes for business enquiries. Offer a paid or clearly disclosed collaboration; never fake testimonials.'],
  intent: ['These phrases are search seeds. Respond only to people who are asking for help, and answer the question first.'],
  competitor: ['Complaints about a competitor are context, not an invitation. Do not disparage the competitor; offer a factual comparison only when asked.'],
};

export const SCORING = {
  scale: 'Total 0-10: fit (0-3) + intent (0-3) + reachability (0-2) + recency (0-2).',
  fit: ['0 not the ICP or a disqualifier applies', '1 loosely related', '2 matches a segment\'s who', '3 matches a segment\'s who and pain'],
  intent: ['0 no ask', '1 discusses the topic', '2 describes the pain or a failed workaround', '3 explicitly asks for a tool, service or recommendation'],
  reachability: ['0 no public way to respond', '1 can reply in a public thread', '2 thread is open and the person invites replies or lists a business contact'],
  recency: ['0 older than 12 months or undated', '1 3-12 months', '2 under 3 months'],
  action: [
    { min: 7, do: 'Reply or reach out this week with the matching outreach draft, after adding real evidence.' },
    { min: 5, do: 'Engage helpfully without pitching; revisit if they reply or the thread stays active.' },
    { min: 0, do: 'Skip.' },
  ],
  honesty: 'Scores are a human judgement. A search result is only a candidate until someone has opened the page and confirmed it.',
};

export const SHORTLIST_FIELDS = [
  'name', 'handle', 'platform', 'url', 'title', 'whyTheyFit', 'intentSignal',
  'score (fit, intent, reach, recency, total)', 'status (unreviewed | shortlisted | contacted | replied | won | skipped)',
  'outreachId', 'suggestedFirstMessage', 'foundVia', 'backing', 'notes',
];

const OVERCLAIM = /\b(guarantee[sd]?|#1|number one|best in|the best|proven|risk[- ]free|instantly|10x|\d+x\b|skyrocket|revolutionary|game[- ]chang|only (tool|app|service)|always works|100%)/i;

const INVENTED = /\b(when i was|i ran into|i('ve| have) been there|in your shoes|we('ve| have) helped|i (used|had) to|our (clients|customers|users) (have|saw|see|love|got))\b/i;

/** Warnings for a human, not rejections: overclaiming, missing disclosure, platform-specific mistakes. */
export function lintDraft(o) {
  const warnings = [];
  const made = o.draft.match(INVENTED);
  if (made) warnings.push(`possible invented experience: "${made[0]}"; only report what the agent observed`);
  if (/\[their exact words\]/i.test(o.draft.split(/[.!?\n]/)[0]) && /^(hi|hey|hello)\b/i.test(o.draft)) warnings.push('greeting uses [their exact words]; use [first name]');
  const hit = o.draft.match(OVERCLAIM);
  if (hit) warnings.push(`possible overclaim: "${hit[0]}"`);
  if (!/(i work|i'm part|i am part|we built|i built|affiliat|disclos|full disclosure|my team|our team|relationship|i'm with|i help|i run)/i.test(o.draft)) warnings.push('no clear affiliation statement');
  if (o.sourceType === 'x-reply' && Buffer.byteLength(o.draft.replace(/\{\{EVIDENCE\}\}/g, ''), 'utf8') > 280) warnings.push('over 280 bytes before evidence is attached');
  if (o.sourceType === 'reddit-comment' && /https?:\/\//.test(o.draft)) warnings.push('contains a link; many subreddits remove first-reply links');
  return warnings;
}

function linkSet(...pairs) { return pairs.filter(Boolean).map(([label, url]) => ({ label, url })); }

const querySet = (items, build) => items.map(({ q, intent }) => ({ q, intent, urls: build(q) }));

export function buildSources(plan) {
  const sources = [];
  const add = (s) => sources.push({ id: `src-${sources.length + 1}`, status: 'recipe', backing: 'recipe', verified: false, ...s });

  for (const r of plan.reddit) {
    add({
      type: 'reddit', name: `r/${r.subreddit}`, why: r.fit, etiquette: ETIQUETTE.reddit,
      verification: 'Open the subreddit, confirm it exists, is active, and read the rules before anything else.',
      links: linkSet(
        ['Open subreddit', `https://www.reddit.com/r/${r.subreddit}/`],
        ['Read the rules', `https://www.reddit.com/r/${r.subreddit}/about/rules`],
      ),
      queries: r.queries.map(({ q, intent }) => ({
        q, intent,
        urls: linkSet(['Search this subreddit (newest, past year)', searchUrl.subreddit(r.subreddit, q)], ['Search all of Reddit', searchUrl.reddit(q)], ['Google, reddit.com only', searchUrl.googleSite('reddit.com', q)]),
      })),
    });
  }
  add({
    type: 'x', name: 'X (Twitter) search', why: 'Public posts where people ask for recommendations or vent about the problem. Needs a logged-in human; the agent only builds the links.',
    etiquette: ETIQUETTE.x, verification: 'Run each search yourself and judge the results; operators may change.',
    links: [], queries: plan.x.map(({ q, intent, note }) => ({ q, intent, note, urls: linkSet(['Search X (latest)', searchUrl.x(q)], ['Google, x.com only', searchUrl.googleSite('x.com', q)]) })),
  });
  add({
    type: 'hn', name: 'Hacker News', why: 'Ask HN and Show HN threads, and comments where builders describe their stack and gaps.',
    etiquette: ETIQUETTE.hn, verification: 'Open the Algolia search and read the threads.', links: [],
    queries: plan.hackerNews.map(({ q, intent }) => ({ q, intent, urls: linkSet(['Stories (newest, past year)', searchUrl.hn(q)], ['Comments (newest, past year)', searchUrl.hnComments(q)]) })),
  });
  add({
    type: 'producthunt', name: 'Product Hunt', why: 'Launch threads and comments from makers who are about to launch or just did.',
    etiquette: ETIQUETTE.producthunt, verification: 'Open the search and read recent launches.', links: [],
    queries: plan.productHunt.map(({ q, intent }) => ({ q, intent, urls: linkSet(['Search Product Hunt', searchUrl.productHunt(q)], ['Google, producthunt.com only', searchUrl.googleSite('producthunt.com', q)]) })),
  });
  add({
    type: 'indiehackers', name: 'Indie Hackers', why: 'Posts where founders discuss launches, growth channels and what is not working.',
    etiquette: ETIQUETTE.indiehackers, verification: 'Open the search and read the posts; the site search path may change.', links: [],
    queries: plan.indieHackers.map(({ q, intent }) => ({ q, intent, urls: linkSet(['Search Indie Hackers', searchUrl.indieHackers(q)], ['Google, indiehackers.com only', searchUrl.googleSite('indiehackers.com', q)]) })),
  });
  for (const c of plan.communities) {
    add({
      type: 'community', name: c.name, platform: c.platform, why: c.fit, etiquette: ETIQUETTE.community,
      verification: `Candidate only. ${c.howToFind} Confirm it exists and is open before joining.`,
      links: linkSet([`Search for "${c.name}"`, searchUrl.google(`${c.name} ${c.platform === 'other' ? 'community' : c.platform} community invite`)]), queries: [],
    });
  }
  for (const n of plan.newsletters) {
    add({
      type: 'newsletter', name: n.name, route: n.route, why: n.fit, etiquette: ETIQUETTE.newsletter,
      verification: `Candidate only. ${n.howToFind} Confirm it exists, is still sending, and how it accepts ${n.route === 'read-for-leads' ? 'readers' : n.route === 'sponsor' ? 'sponsors' : 'submissions'}.`,
      links: linkSet([`Search for "${n.name}"`, searchUrl.google(`${n.name} newsletter ${n.route === 'sponsor' ? 'sponsor' : n.route === 'submit' ? 'submit a tool' : 'contact'}`)]), queries: [],
    });
  }
  for (const c of plan.creators) {
    const terms = c.searchTerms;
    const by = {
      tiktok: () => linkSet(...terms.map((t) => [`TikTok: ${t}`, searchUrl.tiktok(t)])),
      youtube: () => linkSet(...terms.map((t) => [`YouTube: ${t}`, searchUrl.youtube(t)])),
      x: () => linkSet(...terms.map((t) => [`X people: ${t}`, searchUrl.xPeople(t)])),
      linkedin: () => linkSet(...terms.map((t) => [`LinkedIn people: ${t}`, searchUrl.linkedin(t)])),
      instagram: () => linkSet(...terms.filter((t) => !/\s/.test(t.trim())).map((t) => [`Instagram tag: ${t}`, searchUrl.instagramTag(t)]), ...terms.slice(0, 2).map((t) => [`Google: ${t}`, searchUrl.googleSite('instagram.com', t)])),
    };
    add({
      type: 'creator', name: c.archetype, platform: c.platform, why: c.whatToLookFor, etiquette: ETIQUETTE.creator,
      verification: 'These are search terms for finding real accounts. No handle here is a recommendation until a human has reviewed the profile.',
      links: by[c.platform](), queries: terms.map((t) => ({ q: t, intent: 'recommendation-ask', urls: [] })),
    });
  }
  add({
    type: 'intent', name: 'Intent phrases', why: 'Phrases people use when they want what the product does but have not found it.', etiquette: ETIQUETTE.intent,
    verification: 'Run them on Reddit, X and Google; keep only threads where someone is asking for help.', links: [],
    queries: plan.intentPhrases.map((q) => ({ q, intent: 'wish', urls: linkSet(['Reddit', searchUrl.reddit(`"${q}"`)], ['X', searchUrl.x(`"${q}"`)], ['Google', searchUrl.google(`"${q}"`)]) })),
  });
  for (const c of plan.competitors) {
    add({
      type: 'competitor', name: c.name, why: c.why, etiquette: ETIQUETTE.competitor,
      verification: 'Competitor names come from the model unless the input listed them; confirm each is real and relevant.', links: [],
      queries: c.complaintQueries.map((q) => ({ q, intent: 'competitor-complaint', urls: linkSet(['Reddit', searchUrl.reddit(q)], ['X', searchUrl.x(q)], ['Google', searchUrl.google(q)]) })),
    });
  }
  return sources;
}

export function buildEvidence(understanding) {
  return understanding.features.map((f) => ({
    featureId: f.id, label: f.name, observed: f.whatItDoes, assets: f.evidence.slice(0, 4),
    attachNote: f.evidence.length ? 'Attach one of these run screenshots, or describe the exact flow.' : 'No screenshot in the input. Capture one from a real run before using this as evidence.',
  }));
}

export function assemble({ understanding, plan, mode, model, now = new Date() }) {
  const outreach = plan.outreach.map((o) => ({ ...o, evidenceRequired: true, etiquette: ETIQUETTE[{ 'reddit-comment': 'reddit', 'x-reply': 'x', dm: 'dm', 'cold-email': 'email' }[o.sourceType]], lint: lintDraft(o) }));
  return {
    schemaVersion: 1,
    kind: 'astrahack.leads',
    generatedAt: now.toISOString(),
    mode,                                   // mock | model | dry-run
    model,
    source: { kind: understanding.kind, path: understanding.sourcePath, name: understanding.name, url: understanding.url },
    product: {
      name: understanding.name, url: understanding.url, oneLiner: understanding.oneLiner,
      observedFeatures: understanding.features.map(({ id, name, whatItDoes, evidence }) => ({ id, name, whatItDoes, evidence })),
      frictionFromQa: understanding.friction,
    },
    icp: plan.icp,
    sources: buildSources(plan),
    shortlist: { fields: SHORTLIST_FIELDS, scoring: SCORING, leads: [] },
    evidence: buildEvidence(understanding),
    outreach,
    cadence: [...plan.cadence].sort((a, b) => a.day - b.day),
    discovery: { enabled: false, queriesRun: 0, results: 0, errors: [] },
    notes: [
      'Sources marked "recipe" are search instructions and candidates. They are not verified leads, and subreddit, community and newsletter names must be confirmed to exist.',
      'Only entries in shortlist.leads with backing "search-result" came from a real search; every URL there was returned by Google Search, none was written by a model.',
      'Nothing here posts, messages or emails anyone. A human reviews every lead and sends every message.',
    ],
  };
}
