// Deterministic plan from the input alone: no key, no network, same input -> same output.
// It is a template planner, not a thinker. It uses what the input says (name, category, audience,
// feature names) and a small topic table of well-known communities. Everything it names is a
// candidate that the generated kit tells a human to verify.

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

/** "launch studio for consumer apps, prosumer tools and B2B" -> { category, audience } */
export function deriveCategory(u) {
  if (u.category && u.audience) return { category: u.category, audience: u.audience };
  const text = `${u.oneLiner}`;
  const m = text.match(/\bis (?:a|an|the)\s+([^,.;:]+?)\s+(?:for|that|to|which|where|who)\s+([^.;]+)/i)
    || (u.headings ?? []).concat(text).map((t) => String(t).match(/^(?:the\s+)?([a-z][a-z -]{3,30}?)\s+for\s+([^.;]+)/i)).find(Boolean);
  if (m) return { category: m[1].trim().toLowerCase(), audience: m[2].trim().replace(/\.$/, '') };
  const words = text.replace(new RegExp(u.name, 'gi'), '').split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
  return { category: u.category || words.toLowerCase() || 'tool like this', audience: u.audience || 'people with this problem' };
}

const TOPICS = [
  { key: 'startup', words: /\b(app|apps|launch|startup|saas|founder|indie|product|b2b|prosumer|mvp|go-to-market|gtm)\b/gi,
    subs: [['SideProject', 'Builders share finished or in-progress apps and ask how to get users.'], ['startups', 'Founders ask for launch and go-to-market help.'], ['indiehackers', 'Solo founders discuss launches and what they would pay for.'], ['SaaS', 'SaaS founders compare tools and growth channels.'], ['EntrepreneurRideAlong', 'Founders narrate their journeys and name blockers.'], ['microsaas', 'Small-product builders talk distribution.']],
    newsletters: [['Indie Hackers newsletter', 'Reaches solo founders at launch stage.', 'submit'], ['Product Hunt Daily', 'Reads like a launch calendar; founders preparing to launch follow it.', 'read-for-leads'], ['Starter Story', 'Founders reading growth case studies.', 'pitch']] },
  { key: 'marketing', words: /\b(ugc|creator|creators|ads?|marketing|social|tiktok|reels|influencer|campaign|brand|growth)\b/gi,
    subs: [['marketing', 'Marketers ask for tools and agency recommendations.'], ['DigitalMarketing', 'Practitioners trade channel tactics and ask what works.'], ['socialmedia', 'Social managers ask how to make content.'], ['UGCcreators', 'UGC creators and the people who hire them.']],
    newsletters: [['Marketing Brew', 'General marketing readership.', 'pitch'], ['Social Media Today', 'Social marketers.', 'pitch']] },
  { key: 'ecommerce', words: /\b(shop|store|ecommerce|e-commerce|shopify|dtc|checkout|cart)\b/gi,
    subs: [['ecommerce', 'Store owners ask for tools and services.'], ['shopify', 'Merchants ask for recommendations.']], newsletters: [] },
  { key: 'dev', words: /\b(api|sdk|developer|developers|code|devtool|open[- ]source|github|cli)\b/gi,
    subs: [['webdev', 'Developers ask for tools and discuss pain points.'], ['programming', 'General developer discussion.']], newsletters: [['TLDR', 'Developer-leaning readership.', 'sponsor']] },
  { key: 'ai', words: /\b(ai|llm|gpt|agent|agents|model|machine learning)\b/gi,
    subs: [['artificial', 'AI-curious readers and builders.'], ['ChatGPT', 'People hunting for AI-powered tools.']], newsletters: [] },
  { key: 'health', words: /\b(health|fitness|workout|nutrition|sleep|habit|wellness|meditation)\b/gi,
    subs: [['fitness', 'People ask for tracking and programming tools.'], ['QuantifiedSelf', 'Self-tracking enthusiasts.']], newsletters: [] },
  { key: 'finance', words: /\b(budget|finance|money|invest|expense|bank|payments?)\b/gi,
    subs: [['personalfinance', 'People ask for budgeting tools.'], ['budgeting', 'Budget-app seekers.']], newsletters: [] },
  { key: 'education', words: /\b(learn|learning|student|students|study|course|tutor|school|education)\b/gi,
    subs: [['GetStudying', 'Students ask for study tools.'], ['studytips', 'Learners trade methods.']], newsletters: [] },
  { key: 'productivity', words: /\b(productivity|notes|tasks?|todo|calendar|workflow|notion)\b/gi,
    subs: [['productivity', 'People compare tools and routines.'], ['Notion', 'Heavy tool users ask for add-ons.']], newsletters: [] },
  { key: 'design', words: /\b(design|designer|figma|ui|ux|brand identity|logo)\b/gi,
    subs: [['web_design', 'Designers and clients ask for help.'], ['graphic_design', 'Designers share work and ask for tools.']], newsletters: [] },
];

function topicsFor(u) {
  const hay = [u.name, u.oneLiner, ...u.headings, ...u.features.map((f) => f.name), u.brief ?? ''].join(' ');
  const scored = TOPICS.map((t) => ({ t, n: (hay.match(t.words) ?? []).length })).filter((x) => x.n).sort((a, b) => b.n - a.n || TOPICS.indexOf(a.t) - TOPICS.indexOf(b.t));
  const picked = scored.slice(0, 3).map((x) => x.t);
  return picked.length ? picked : [TOPICS[0]];
}

const first = (s, n) => s.split(/\s+/).slice(0, n).join(' ');
const splitAudience = (aud) => aud.split(/,|\band\b|\bor\b|\/|&/i).map((s) => s.trim()).filter((s) => s.length > 2).slice(0, 3);

export function mockPlan(u) {
  const { category: cat, audience } = deriveCategory(u);
  const name = u.name;
  const parts = splitAudience(audience);
  const aud0 = parts[0] ?? audience;
  const fids = u.features.map((f) => f.id);
  const slice = (i) => { const out = [fids[i % fids.length], fids[(i + 1) % fids.length]]; return [...new Set(out)]; };
  const topics = topicsFor(u);

  const segNames = parts.length >= 2 ? parts : [aud0, `People comparing options for a ${cat}`];
  const segments = segNames.slice(0, 3).map((who, i) => ({
    id: `S${i + 1}`,
    name: i === 0 ? `Makers of ${who}` : `Buyers of ${who}`,
    who: `People responsible for ${who} who are deciding on a ${cat}.`,
    pain: `They need what a ${cat} provides, as ${name}'s own site describes it, and do not know where to start or whom to trust.`,
    trigger: `A deadline or launch is close, or a previous attempt did not work, and they search for a ${cat}.`,
    featureIds: slice(i),
    disqualifiers: ['Already has an in-house team doing this', 'No product or project yet'],
  }));

  const subs = []; const seen = new Set();
  for (const t of topics) for (const s of t.subs) if (!seen.has(s[0]) && subs.length < 6) { seen.add(s[0]); subs.push(s); }
  const reddit = subs.map(([subreddit, fit]) => ({
    subreddit, fit: `${fit} Candidate: confirm it exists and allows this kind of reply.`,
    queries: [
      { q: `looking for a ${cat}`, intent: 'recommendation-ask' },
      { q: `how to find a ${cat} for ${first(aud0, 3)}`, intent: 'how-to' },
      { q: `${cat} worth it`, intent: 'pain' },
    ].slice(0, 2 + (subs.indexOf(subs.find((s) => s[0] === subreddit)) % 2)),
  }));

  const newsletters = []; const nseen = new Set();
  for (const t of topics) for (const n of t.newsletters) if (!nseen.has(n[0]) && newsletters.length < 5) { nseen.add(n[0]); newsletters.push({ name: n[0], fit: n[1], route: n[2], howToFind: 'Search the name and look for a "sponsor", "submit" or "contact" page.' }); }
  while (newsletters.length < 3) newsletters.push({ name: `Newsletters read by ${aud0}`, fit: `Where ${aud0} already read about ${cat}.`, route: 'read-for-leads', howToFind: `Search "${aud0} newsletter" and subscribe to the top few.` });

  return {
    icp: {
      summary: `People responsible for ${audience} who are actively looking for a ${cat}. Grounded in how ${name}'s own pages describe it: ${clip(u.oneLiner, 160)}`,
      segments,
      buyingTriggers: [`A launch or release date is approaching and nobody owns ${cat} work`, `A previous attempt at ${cat} did not produce results`, `Public asking for recommendations for a ${cat}`],
      objections: ['Cost and what is included', 'Whether the work will fit their product', 'Trust: no proof yet from someone like them'],
      notAFit: ['Hobby projects with no intent to launch', 'Teams that already have this covered in-house'],
      assumptions: [`The customer is who ${name}'s pages address (${audience}); this was not tested with real customers.`, 'Pain statements are inferred from the category, not from interviews.', 'Mock mode: no model reasoned about this input.'],
    },
    reddit,
    x: [
      { q: `"looking for a ${cat}" -filter:replies lang:en`, intent: 'recommendation-ask', note: 'People asking outright.' },
      { q: `("recommend a ${cat}" OR "anyone used a ${cat}") lang:en`, intent: 'recommendation-ask', note: 'Recommendation requests.' },
      { q: `"I wish there was" ${first(aud0, 2)} lang:en`, intent: 'wish', note: 'Unmet-need posts.' },
      { q: `"${cat}" ("not worth it" OR "waste of money") lang:en`, intent: 'competitor-complaint', note: 'Dissatisfaction with existing options.' },
      { q: `"how do I" ${first(cat, 3)} lang:en -filter:replies`, intent: 'how-to', note: 'How-to questions where a helpful answer fits.' },
    ],
    hackerNews: [{ q: `Ask HN ${cat}`, intent: 'recommendation-ask' }, { q: `${first(aud0, 3)} ${first(cat, 2)} advice`, intent: 'how-to' }],
    productHunt: [{ q: cat, intent: 'recommendation-ask' }, { q: first(aud0, 3), intent: 'pain' }],
    indieHackers: [{ q: `${cat} recommendations`, intent: 'recommendation-ask' }, { q: `${first(cat, 2)} did not work`, intent: 'pain' }],
    communities: [
      { platform: 'discord', name: `Discord servers for ${aud0}`, fit: `Real-time conversation among ${aud0}.`, howToFind: 'Search Disboard or Google for the topic plus "Discord server".' },
      { platform: 'slack', name: `Slack communities for ${aud0}`, fit: `Peer groups where ${aud0} ask for recommendations.`, howToFind: 'Search "Slack community" plus the topic; many list a public application form.' },
      { platform: 'forum', name: `Forums and Facebook groups about ${cat}`, fit: `Long-lived discussions about ${cat}.`, howToFind: 'Search the topic plus "forum" or "Facebook group".' },
    ],
    newsletters,
    creators: [
      { archetype: `Build-in-public founders in the ${first(aud0, 3)} space`, platform: 'x', searchTerms: ['building in public founder', `${first(aud0, 3)} founder`], whatToLookFor: 'Audience of founders, replies that show people ask them for recommendations.' },
      { archetype: `Reviewers who test ${cat}s`, platform: 'youtube', searchTerms: [`${cat} review`, `${cat} tutorial`], whatToLookFor: 'Channels that compare tools or services honestly and show a business contact.' },
      { archetype: `Micro-creators covering ${aud0}`, platform: 'tiktok', searchTerms: [`${aud0} tips`, `${first(cat, 2)} behind the scenes`], whatToLookFor: 'Small, engaged accounts with a published business email.' },
    ],
    intentPhrases: [`looking for a ${cat}`, `recommend a ${cat}`, `anyone used a ${cat}`, `I wish there was a ${cat}`, `how do I find a ${cat}`, `need help with ${cat}`, `best ${cat} for ${first(aud0, 3)}`, `is a ${cat} worth it`],
    competitors: [
      { name: `Other providers of ${cat}`, why: 'Mock mode cannot name real competitors. Replace with the real alternatives your buyers mention.', complaintQueries: [`${cat} bad experience`, `${cat} alternatives`] },
      { name: 'Doing it in-house or with freelancers', why: 'The most common alternative to a specialist provider.', complaintQueries: [`freelancer ${first(cat, 2)} did not work`, `tried to do ${first(cat, 3)} myself`] },
    ],
    outreach: outreach(name, cat, aud0, u),
    cadence: cadence(cat),
  };
}

function evidenceSlot(u, n = 0) {
  const withEvidence = u.features.filter((x) => x.evidence.length);
  const pool = withEvidence.length ? withEvidence : u.features;
  const f = pool[n % pool.length];
  return f.evidence.length ? `Feature ${f.id} "${f.name}": attach ${f.evidence[0]} or describe that flow exactly.` : `Feature ${f.id} "${f.name}": capture a screenshot from a real run first.`;
}

function outreach(name, cat, aud0, u) {
  const slots = [0, 1, 2, 3].map((n) => evidenceSlot(u, n));
  return [
    { id: 'o-1', sourceType: 'reddit-comment', scenario: `Someone asks how to find or choose a ${cat}.`, subject: '(none)',
      draft: `[Answer their actual question first, in two or three specific sentences, using only what you know to be true.]\n\nFull disclosure: [confirm your relationship] with ${name}, which is a ${cat}. We ran an automated walkthrough of the site and saw this: {{EVIDENCE}}\n\nIf that is not what you need, the advice above still stands. Happy to answer questions here.`,
      evidenceSlot: slots[0], disclosure: `States the relationship with ${name} up front.` },
    { id: 'o-2', sourceType: 'x-reply', scenario: `A public post asking for a ${cat} recommendation.`, subject: '(none)',
      draft: `[One concrete tip.] I work with ${name}, a ${cat}. What we observed: {{EVIDENCE}}`,
      evidenceSlot: slots[1], disclosure: `"I work with ${name}" in the reply.` },
    { id: 'o-3', sourceType: 'dm', scenario: `Only after they replied, asked for details, or their profile invites DMs about ${cat}.`, subject: '(none)',
      draft: `Hi [first name], you mentioned [their exact words]. I'm [your name] and [confirm your relationship] with ${name}, a ${cat}. Here is what our walkthrough showed: {{EVIDENCE}}. No pressure; happy to just answer questions.`,
      evidenceSlot: slots[2], disclosure: 'Opens with who you are and your relationship.' },
    { id: 'o-4', sourceType: 'cold-email', scenario: `A published business contact for someone who fits the ICP (${aud0}).`, subject: `[Their project]: a question about ${first(cat, 3)}`,
      draft: `Hi [first name],\n\nI saw [specific public thing they made or said, with the link]. I'm [your name] and [confirm your relationship] with ${name}, a ${cat}.\n\nOne observation from using ${name}: {{EVIDENCE}}\n\nWould a short call be useful, or is this not a priority right now? Either answer is fine. [Unsubscribe or opt-out line and postal address as your local law requires.]`,
      evidenceSlot: slots[3], disclosure: 'Identifies the sender and relationship in the first lines.' },
  ];
}

function cadence(cat) {
  return [
    { day: 1, focus: 'Set up and verify', actions: ['Confirm every recommended subreddit, community and newsletter exists and read their rules.', 'Open each source link and discard queries that return nothing useful.', 'Attach real evidence (screenshot or exact flow) to each outreach draft.'], target: 'Verified source list; 3 drafts with real evidence', review: 'Drop any source whose rules forbid this kind of reply.' },
    { day: 2, focus: 'Listen', actions: ['Run the Reddit and X recipes; collect 15 candidate threads without replying.', 'Add them to the shortlist and score each.'], target: '15 candidates scored', review: 'Which queries returned real asks?' },
    { day: 3, focus: 'Help first', actions: ['Answer 5 of the top-scoring threads with useful advice and no pitch.', 'Mention the product only where it fits, with disclosure.'], target: '5 helpful replies', review: 'Any replies, removals or mod notes?' },
    { day: 4, focus: 'Expand sources', actions: ['Run the Hacker News, Product Hunt and Indie Hackers recipes.', 'Check the newsletter and community candidates; join one community that allows it.'], target: '10 more candidates', review: 'Which platform gave the best fit?' },
    { day: 5, focus: 'Creators', actions: ['Search the creator archetypes and shortlist 5 profiles with a published business contact.', 'Send at most 3 personal emails with real evidence.'], target: '5 profiles, up to 3 emails', review: 'Is the offer clear and honest?' },
    { day: 6, focus: 'Follow up', actions: ['Reply to anyone who responded; continue in public where possible.', 'Offer DMs only to people who asked or invite them.'], target: 'Every reply answered', review: 'Note objections heard.' },
    { day: 7, focus: 'Review and decide', actions: ['Count shortlisted, contacted, replied.', 'Cut the weakest source, double the best, and write down what to change in the ICP.'], target: 'One-page summary', review: `What did we learn about who needs a ${cat}?` },
  ];
}
