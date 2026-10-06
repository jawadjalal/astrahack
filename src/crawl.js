import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { attach, launchBrowser } from './cdp.js';
import { navigate, observe, screenshot } from './runner.js';

const safe = value => String(value).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 60);

export function normalizeLink(raw, base, origin) {
  try {
    const url = new URL(raw, base);
    if (!['http:', 'https:', 'file:'].includes(url.protocol)) return null;
    if (url.origin !== origin) return null;
    if (/\.(?:mp4|webm|mov|mp3|wav|png|jpe?g|gif|webp|svg|pdf|zip|gz|css|js|json|xml|txt|woff2?|ttf|otf)$/i.test(url.pathname)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export async function crawlSite({ url, output, chrome, maxPages = 50, maxDepth = 4, headless = true, onPage }) {
  if (!url || !chrome) throw new Error('crawlSite requires url and chrome');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) throw new Error('maxPages must be 1–500');
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 10) throw new Error('maxDepth must be 0–10');
  const root = new URL(url);
  if (!['http:', 'https:', 'file:'].includes(root.protocol)) throw new Error('Only HTTP, HTTPS, and local fixtures are supported');
  const out = resolve(output);
  await mkdir(join(out, 'screenshots'), { recursive: true });
  const report = {
    schemaVersion: 1, target: root.href, startedAt: new Date().toISOString(), finishedAt: null,
    limits: { maxPages, maxDepth }, pages: [], observations: [], findings: [], assets: []
  };
  const queue = [{ url: root.href, depth: 0, discoveredFrom: null }];
  const queued = new Set([root.href]);
  let browser;
  let cdp;
  try {
    browser = await launchBrowser({ executable: chrome, headless });
    cdp = await attach(browser.port);
    while (queue.length && report.pages.length < maxPages) {
      const item = queue.shift();
      const page = { ...item, visitedAt: new Date().toISOString(), status: 'visited' };
      report.pages.push(page);
      try {
        await navigate(cdp, item.url);
        page.observation = await observe(cdp);
        page.contentType = await cdp.eval('document.contentType');
        page.httpStatus = await cdp.eval('performance.getEntriesByType("navigation")[0]?.responseStatus || null');
        page.finalUrl = page.observation.url;
        if (!['text/html', 'application/xhtml+xml'].includes(page.contentType)) {
          page.status = 'skipped_non_html';
          page.links = [];
          continue;
        }
        const asset = `screenshots/${String(report.pages.length).padStart(3, '0')}-${safe(new URL(item.url).pathname || 'home')}.png`;
        await screenshot(cdp, join(out, asset));
        page.screenshot = asset;
        report.assets.push({ type: 'screenshot', path: asset, url: page.finalUrl, purpose: 'QA crawl evidence' });
        report.observations.push({ screenshot: asset, observation: page.observation, url: page.finalUrl });
        report.product ||= page.observation;
        page.links = [...new Set(page.observation.controls.filter(x => x.href).map(x => normalizeLink(x.href, page.finalUrl, root.origin)).filter(Boolean))];
        if (page.httpStatus && page.httpStatus >= 400) {
          report.findings.push({ type: 'http_error', severity: 'high', url: item.url, actual: `HTTP ${page.httpStatus}`, evidence: asset });
        }
        if (!page.observation.title) report.findings.push({ type: 'missing_title', severity: 'low', url: item.url, actual: 'Document title is empty', evidence: asset });
        if (!page.observation.headings.some(x => x.level === 'h1')) report.findings.push({ type: 'missing_h1', severity: 'low', url: item.url, actual: 'No visible H1 heading', evidence: asset });
        if (item.depth < maxDepth) {
          for (const link of page.links) {
            if (!queued.has(link)) {
              queued.add(link);
              queue.push({ url: link, depth: item.depth + 1, discoveredFrom: item.url });
            }
          }
        }
      } catch (error) {
        page.status = 'error';
        page.error = error.message;
        report.findings.push({ type: 'navigation_error', severity: 'high', url: item.url, actual: error.message, evidence: page.screenshot || null });
      }
      await onPage?.(page, report);
      await writeFile(join(out, 'crawl.json'), JSON.stringify(report, null, 2) + '\n');
    }
    report.unvisited = queue.map(item => item.url);
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(join(out, 'crawl.json'), JSON.stringify(report, null, 2) + '\n');
    cdp?.close();
    await browser?.close();
  }
  return { out, report };
}
