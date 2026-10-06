// Readable ugc-plan.md from a ugc-plan document.
const byId = (list) => new Map(list.map((x) => [x.id, x]));
const bullets = (list) => list.map((x) => `- ${x}`).join('\n');

export function renderPlan(doc) {
  const p = doc.product;
  const angles = byId(doc.angles), creators = byId(doc.creators), feats = byId(p.observedFeatures);
  const out = [];
  out.push(`# UGC plan: ${p.name}`);
  out.push(`Generated ${doc.generatedAt} by \`${doc.model}\` from run "${doc.source.runName ?? 'unnamed'}" (${doc.source.target ?? 'no target'}). Draft for review: product claims point at observed features, everything under Proposals is an assumption.`);

  out.push('## Product');
  out.push(`${p.oneLiner}\n\n- Category: ${p.category}\n- Who it is for: ${p.whoItsFor}`);
  out.push('### Observed features');
  out.push(p.observedFeatures.map((f) => `**${f.id}. ${f.name}**\n${f.whatItDoes}\nEvidence: ${f.evidence.map((e) => `\`${e}\``).join(', ')}`).join('\n\n'));
  if (p.frictionFromQa.length) out.push(`### QA friction (not for ads)\n${bullets(p.frictionFromQa)}`);

  out.push('## Audiences');
  out.push(doc.audiences.map((a) => `**${a.id}. ${a.name}** (${a.platforms.join(', ')})\n- Pain: ${a.pain}\n- Desire: ${a.desire}`).join('\n\n'));

  out.push('## Angles and hooks');
  out.push(doc.angles.map((a) => {
    const hs = doc.hooks.filter((h) => h.angleId === a.id);
    return `### ${a.id}. ${a.name}\n${a.insight}\n\n- Why it works: ${a.whyItWorks}\n- Audience: ${a.audienceId}\n- Observed features: ${a.featureIds.map((id) => `${id} (${feats.get(id)?.name})`).join(', ')}\n\nHooks:\n${hs.map((h) => `- **${h.id}** [${h.format}] "${h.text}". Opens on: ${h.visualOpener}`).join('\n')}`;
  }).join('\n\n'));

  out.push('## Creators');
  out.push(doc.creators.map((c) => `**${c.id}. ${c.archetype}** (for ${c.audienceId})\n${c.profile}\nWhy: ${c.whyThem}`).join('\n\n'));

  out.push('## Example scripts');
  out.push(doc.scripts.map((s) => {
    const rows = s.beats.map((b) => `| ${b.t} | ${esc(b.voiceover)} | ${esc(b.onScreenText)} | ${esc(b.shot)} | ${b.assetRef ? `\`${b.assetRef}\`` : 'creator on camera'} |`).join('\n');
    return `### ${s.id}. ${s.title}\n${s.platform} · ${s.format} · ${s.durationSec}s · creator ${creators.get(s.creatorId)?.archetype} · angle ${angles.get(s.angleId)?.name} · hook ${s.hookId}\nClaims rest on: ${s.featureIds.map((id) => `${id} (${feats.get(id)?.name})`).join(', ')}\n\n| Time | Voiceover | On screen | Shot | Show |\n| --- | --- | --- | --- | --- |\n${rows}\n\nCTA: ${s.cta}`;
  }).join('\n\n'));

  const b = doc.creatorBrief;
  out.push(`## Creator brief\n**Must show**\n${bullets(b.mustShow)}\n\n**Do**\n${bullets(b.dos)}\n\n**Do not**\n${bullets(b.donts)}\n\n**Deliverables**\n${bullets(b.deliverables)}\n\n**Disclosure:** ${b.disclosure}`);

  const c = doc.campaign;
  out.push(`## Campaign\n**Goal:** ${c.goal}\n\n${c.phases.map((ph) => `### ${ph.name} (${ph.days})\n${ph.objective}\n${bullets(ph.actions)}`).join('\n\n')}`);
  out.push(`### Calendar\n| Day | Platform | Script | Note |\n| --- | --- | --- | --- |\n${c.calendar.map((d) => `| ${d.day} | ${d.platform} | ${d.scriptId} | ${esc(d.note)} |`).join('\n')}`);
  out.push(`### Success metrics\n| Metric | Target | Why |\n| --- | --- | --- |\n${c.kpis.map((k) => `| ${esc(k.metric)} | ${esc(k.target)} | ${esc(k.why)} |`).join('\n')}\n\nBudget: ${c.budgetNote}`);

  out.push(`## Proposals (not observed, verify before use)\n${bullets(doc.proposals)}`);
  if (doc.grounding?.repairs?.length) out.push(`## Grounding repairs\n${bullets(doc.grounding.repairs)}`);
  return `${out.join('\n\n')}\n`;
}

const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
