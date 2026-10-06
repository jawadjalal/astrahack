// leads.json -> leads.md. A working document for a human: every link is clickable, every draft has
// its evidence slot, every unverified claim says so.

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const link = (l) => `[${esc(l.label)}](${l.url})`;
const bullets = (items) => items.map((i) => `- ${i}`).join('\n');
const quote = (s) => String(s).split('\n').map((l) => `> ${l}`).join('\n');

const TYPE_TITLES = {
  reddit: 'Reddit', x: 'X', hn: 'Hacker News', producthunt: 'Product Hunt', indiehackers: 'Indie Hackers',
  community: 'Discord, Slack and other communities', newsletter: 'Newsletters', creator: 'Creator and influencer archetypes',
  intent: 'Intent phrases ("I wish there was an app for...")', competitor: 'Competitor complaints',
};

function renderSource(s) {
  const out = [`#### ${esc(s.name)}${s.platform ? ` (${s.platform})` : ''}${s.route ? ` (route: ${s.route})` : ''}`, '', s.why, '', `Verify: ${s.verification}`];
  if (s.links.length) out.push('', s.links.map(link).join(' · '));
  const withUrls = s.queries.filter((q) => q.urls.length);
  if (withUrls.length) {
    out.push('', '| Query | Intent | Open |', '| --- | --- | --- |');
    for (const q of withUrls) out.push(`| \`${esc(q.q)}\` | ${q.intent} | ${q.urls.map(link).join(' · ')} |`);
  } else if (s.queries.length) {
    out.push('', `Search terms: ${s.queries.map((q) => `\`${esc(q.q)}\``).join(', ')}`);
  }
  return out.join('\n');
}

export function renderLeads(doc) {
  const out = [];
  const p = doc.product;
  out.push(`# Lead generation: ${p.name}`, '',
    `Generated ${doc.generatedAt} · mode: ${doc.mode}${doc.model ? ` · model: ${doc.model}` : ''} · input: ${doc.source.kind}${doc.source.path ? ` (${doc.source.path})` : ''}`, '',
    doc.notes.map((n) => `> ${n}`).join('\n>\n'), '');

  out.push('## Product understanding', '', `${p.name}${p.url ? ` (${p.url})` : ''}: ${p.oneLiner}`, '', '| ID | Observed feature | What the run saw | Evidence |', '| --- | --- | --- | --- |');
  for (const f of p.observedFeatures) out.push(`| ${f.id} | ${esc(f.name)} | ${esc(f.whatItDoes)} | ${f.evidence.length ? `${f.evidence.length} file(s), e.g. \`${esc(f.evidence[0])}\`` : 'none'} |`);
  if (p.frictionFromQa.length) out.push('', 'Friction found by QA (do not use as a selling point):', bullets(p.frictionFromQa));

  out.push('', '## 1. Ideal customer profile', '', doc.icp.summary, '');
  for (const s of doc.icp.segments) out.push(`### ${s.id}: ${s.name}`, '', `- Who: ${s.who}`, `- Pain: ${s.pain}`, `- Trigger: ${s.trigger}`, `- Maps to features: ${s.featureIds.join(', ')}`, `- Disqualifiers: ${s.disqualifiers.join('; ')}`, '');
  out.push('**Buying triggers**', '', bullets(doc.icp.buyingTriggers), '', '**Likely objections**', '', bullets(doc.icp.objections), '', '**Not a fit**', '', bullets(doc.icp.notAFit), '', '**Assumptions (not observed in the product)**', '', bullets(doc.icp.assumptions), '');

  out.push('## 2. Lead sources and search recipes', '', 'Everything in this section is a recipe: a place to look and a query to run. Links open each platform\'s own public search. Nothing is verified until a human has looked.', '');
  for (const type of Object.keys(TYPE_TITLES)) {
    const group = doc.sources.filter((s) => s.type === type);
    if (!group.length) continue;
    out.push(`### ${TYPE_TITLES[type]}`, '', `Etiquette: ${group[0].etiquette.join(' ')}`, '');
    for (const s of group) out.push(renderSource(s), '');
  }

  out.push('## 3. Scored shortlist', '', `Scoring: ${doc.shortlist.scoring.scale}`, '');
  for (const k of ['fit', 'intent', 'reachability', 'recency']) out.push(`- ${k}: ${doc.shortlist.scoring[k].join(' · ')}`);
  out.push(`- Action: ${doc.shortlist.scoring.action.map((a) => `${a.min}+ ${a.do}`).join(' | ')}`, `- ${doc.shortlist.scoring.honesty}`, '', `Fields per lead: ${doc.shortlist.fields.join(', ')}.`, '');
  const d = doc.discovery;
  if (!d.enabled) {
    out.push('No live discovery was run (use `--search` with `GEMINI_API_KEY`). Fill the table below from the recipes above.', '', '| Name / handle | Platform | URL | Why they fit | Intent signal | Score /10 | Suggested first message | Status |', '| --- | --- | --- | --- | --- | --- | --- | --- |', '|  |  |  |  |  |  |  | unreviewed |');
  } else {
    out.push(`Live discovery: ${d.queriesRun} search(es) run, ${d.results} unique result(s)${d.stoppedEarly ? ', stopped early (quota)' : ''}.`);
    if (d.errors.length) out.push('', 'Discovery problems:', bullets(d.errors.map((e) => `\`${esc(e)}\``)));
    if (!doc.shortlist.leads.length) out.push('', 'No leads came back, so the shortlist is empty. The recipes above are still valid; run them by hand.');
    for (const l of doc.shortlist.leads) {
      out.push('', `#### ${l.score ? `${l.score.total}/8 (+ recency) · ` : ''}${esc(l.handle)} · ${l.platform}`, '', `- URL: ${l.url}`, `- Snippet (model paraphrase of the search result): ${l.title}`, `- Why they fit: ${l.whyTheyFit}`, `- Intent signal: ${l.intentSignal}`, `- Found via: \`${esc(l.foundVia.query)}\` · status: ${l.status}`);
      if (l.suggestedFirstMessage) out.push(`- Suggested first message (draft ${l.outreachId}; replace {{EVIDENCE}} first):`, '', quote(l.suggestedFirstMessage));
    }
  }

  out.push('', '## 4. Outreach drafts', '', 'Each draft has a `{{EVIDENCE}}` slot. Replace it with something the agent actually observed: a screenshot from the run or the exact flow. Do not send a draft with the slot still in it.', '');
  out.push('**Evidence available from the input**', '', '| Feature | Observed | Attach |', '| --- | --- | --- |');
  for (const e of doc.evidence) out.push(`| ${e.featureId} ${esc(e.label)} | ${esc(e.observed)} | ${e.assets.length ? e.assets.map((a) => `\`${esc(a)}\``).join(', ') : esc(e.attachNote)} |`);
  out.push('');
  for (const o of doc.outreach) {
    out.push(`### ${o.id} · ${o.sourceType}`, '', `When: ${o.scenario}`, ...(o.subject !== '(none)' ? [`Subject: ${o.subject}`] : []), '', quote(o.draft), '', `- Evidence slot: ${o.evidenceSlot}`, `- Disclosure: ${o.disclosure}`, `- Norms: ${o.etiquette.join(' ')}`);
    if (o.lint.length) out.push(`- Check before sending: ${o.lint.join('; ')}`);
    out.push('');
  }

  out.push('## 5. Seven-day cadence', '');
  for (const c of doc.cadence) out.push(`### Day ${c.day}: ${c.focus}`, '', bullets(c.actions), '', `Target: ${c.target} · Review: ${c.review}`, '');
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}
