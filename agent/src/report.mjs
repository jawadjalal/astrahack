// Report writers: report.json (everything), findings.json (the findings schema only), report.md (human readable).

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function findingsJson(report) {
  return report.findings.map(f => ({
    id: f.id, title: f.title, severity: f.severity, expected: f.expected, actual: f.actual,
    step: f.stepIndex, screenshot: f.screenshot, screenshotUrl: f.screenshotUrl ?? null,
    timestamp: f.timestamp, verified: f.verified, verification: f.verification, repro: f.repro
  }));
}

export function renderMarkdown(report) {
  const c = report.counts || { total: 0, verified: 0 };
  const lines = [
    `# Teardown: ${report.target}`, '',
    `Backend \`${report.backend}\`, model \`${report.model}\`, status **${report.status}**${report.stopReason ? ` (${report.stopReason})` : ''}.`,
    ...(report.brief ? [`Brief: ${report.brief}`] : []), '',
    '## Summary', '', report.summary || '_No summary produced._', ''
  ];
  if (report.timeToValue) lines.push(`Time to value: ${report.timeToValue}`, '');
  if (report.coldOpen) {
    lines.push('## Cold open', '', `- What it is: ${report.coldOpen.what_it_is}`, `- Who it is for: ${report.coldOpen.who_for}`, `- Primary action: ${report.coldOpen.primary_action}`);
    if (report.coldOpen.unclear) lines.push(`- Unclear: ${report.coldOpen.unclear}`);
    lines.push('');
  }
  lines.push(`## Findings (${c.total}, ${c.verified} verified)`, '');
  if (!report.findings.length) lines.push('_None recorded._', '');
  for (const f of report.findings) {
    const why = f.verification.observation || f.verification.reason;
    lines.push(`### ${f.id} [${f.severity}] ${f.title} ${f.verified ? '(verified)' : '(unverified)'}`, '',
      `- Expected: ${f.expected}`, `- Actual: ${f.actual}`,
      `- Step ${f.stepIndex}${f.timestamp != null ? `, recording ${f.timestamp}s` : ''}, screenshot \`${f.screenshot}\``,
      `- Verification: ${f.verification.status}${why ? ` - ${why}` : ''}`);
    if (f.repro.length) lines.push('- Repro:', ...f.repro.map((s, i) => `  ${i + 1}. ${s}`));
    lines.push('');
  }
  if (report.stateTracking.length) {
    lines.push('## Tracked state', '', '| Step | What | Value | Previous | Context |', '| --- | --- | --- | --- | --- |');
    for (const s of report.stateTracking) lines.push(`| ${s.stepIndex} | ${cell(s.label)} | ${cell(s.value)} | ${cell(s.previous ?? '')} | ${cell(s.context)} |`);
    lines.push('');
  }
  lines.push('## Coverage', '', '**Visited**', '');
  for (const v of report.coverage.visited) lines.push(`- ${v.screen}${v.how ? ` (${v.how})` : ''}`);
  lines.push('', '**Not reachable / not covered**', '');
  if (!report.coverage.unreachable.length) lines.push('- none reported');
  for (const u of report.coverage.unreachable) lines.push(`- ${u.screen}: ${u.reason}`);
  if (report.humanSteers.length) lines.push('', '## Human steering', '', ...report.humanSteers.map(s => `- (step ${s.atStep}) ${s.text}`));
  if (report.limitations.length) lines.push('', '## Limitations', '', ...report.limitations.map(l => `- ${l}`));
  lines.push('', `Steps: ${report.steps.length}. Model requests: ${report.usage?.requests ?? 0}.`, '');
  return lines.join('\n');
}

export async function writeReports(outDir, report) {
  await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(outDir, 'findings.json'), JSON.stringify(findingsJson(report), null, 2) + '\n');
  await writeFile(join(outDir, 'report.md'), renderMarkdown(report));
}
