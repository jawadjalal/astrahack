// `cdp` backend: drives a Chromium page (website, web app, or an Electron renderer with a CDP port)
// through the repo's existing src/cdp.js + src/runner.js helpers.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { attach } from '../../src/cdp.js';
import { navigate, observe } from '../../src/runner.js';
import { toCdpCommands, isRiskyLabel } from './actions.mjs';
import { PLACEHOLDER_SHOT } from './placeholder.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'
];
// Playwright's cached "Chrome for Testing" works too (and is a throwaway build, ideal for a teardown).
function playwrightChromes() {
  const roots = [join(homedir(), 'Library', 'Caches', 'ms-playwright'), join(homedir(), '.cache', 'ms-playwright')];
  const out = [];
  for (const root of roots) {
    let dirs = [];
    try { dirs = readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse(); } catch { continue; }
    for (const d of dirs) {
      out.push(join(root, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        join(root, d, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        join(root, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        join(root, d, 'chrome-linux', 'chrome'));
    }
  }
  return out;
}
export const findChrome = (explicit = process.env.ASTRAHACK_CHROME) => explicit || [...CHROME_CANDIDATES, ...playwrightChromes()].find(existsSync);

// registrable-ish domain: last two labels (good enough for an allow-list; use --allow-host for exceptions)
export function siteOf(hostname) {
  const parts = hostname.split('.');
  return parts.length <= 2 ? hostname : parts.slice(-2).join('.');
}

export function hostAllowed(url, { startHost, allowHosts = [] }) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'about:' || u.protocol === 'data:') return true;
  if (u.protocol === 'file:') return startHost === '';
  if (!/^https?:$/.test(u.protocol)) return false;
  if (u.hostname === startHost || siteOf(u.hostname) === siteOf(startHost)) return true;
  return allowHosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
}

// Same idea as src/cdp.js launchBrowser (fresh temporary profile, ephemeral CDP port) with two differences that matter
// for an unattended run: --use-mock-keychain/--password-store=basic (without them Chrome can stall 10-20s on a macOS
// Keychain lookup, longer than launchBrowser waits) and a 30s wait with a hard kill on failure.
export async function launchThrowaway({ executable, headless = true, width = 1440, height = 900, waitMs = 30000 }) {
  const profile = await mkdtemp(join(tmpdir(), 'astrahack-chrome-'));
  const args = [
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--use-mock-keychain', '--password-store=basic', `--window-size=${width},${height}`, 'about:blank'
  ];
  if (headless) args.unshift('--headless=new', '--disable-gpu');
  const child = spawn(executable, args, { stdio: 'ignore' });
  let launchError;
  child.on('error', error => { launchError = error; });
  let port;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && !launchError && child.exitCode === null && child.signalCode === null) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch { /* not yet */ }
    await sleep(100);
  }
  const cleanup = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(t);
    }
    await rm(profile, { recursive: true, force: true });
  };
  if (!port) {
    await cleanup();
    throw new Error(`Chrome did not expose a CDP port within ${waitMs / 1000}s. ${launchError?.message || 'Check the executable and launch permissions.'}`);
  }
  return { port, close: cleanup };
}

// Make links that open a new tab/window navigate in place, so the model never "loses" the page.
const NO_NEW_TABS = `(() => {
  const fix = e => { const a = e.target.closest && e.target.closest('a[target]'); if (a && a.target && a.target !== '_self') a.target = '_self'; };
  addEventListener('click', fix, true); addEventListener('auxclick', fix, true);
  const open = window.open; window.open = (u) => { if (u) location.assign(u); return null; };
})()`;

export class CdpBackend {
  constructor({ url, cdpPort, pageMatch, chrome, headless = true, viewport = { width: 1440, height: 900 }, allowHosts = [], allowRisky = false, dryRun = false, log = () => {} }) {
    this.name = 'cdp';
    Object.assign(this, { url, cdpPort, pageMatch, chrome, headless, viewport, allowHosts, allowRisky, dryRun, log });
    this.attached = !!cdpPort;
    this.startUrl = url || null;
    this.lastGoodUrl = url || null;
    this.notes = [];
  }

  async open() {
    if (this.dryRun) { this.log('cdp: dry-run, no browser launched'); return; }
    if (this.attached) {
      this.cdp = await attach(this.cdpPort, this.pageMatch);
      this.startUrl = await this.cdp.eval('location.href');
    } else {
      const executable = findChrome(this.chrome);
      if (!executable) throw new Error('No Chromium found. Install Chrome or set ASTRAHACK_CHROME / --chrome PATH.');
      this.browser = await launchThrowaway({ executable, headless: this.headless, width: this.viewport.width, height: this.viewport.height });
      this.cdp = await attach(this.browser.port);
      await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: this.viewport.width, height: this.viewport.height, deviceScaleFactor: 1, mobile: false });
      await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_NEW_TABS });
      await navigate(this.cdp, this.url);
    }
    this.startHost = (() => { try { return new URL(this.startUrl).hostname; } catch { return ''; } })();
    this.lastGoodUrl = await this.cdp.eval('location.href');
  }

  async close() {
    try { this.cdp?.close(); } catch { /* already closed */ }
    await this.browser?.close();
  }

  // -> { buffer, mime, width, height, scale }  (coordinates the model gives are in these pixels)
  // Concurrent Page.captureScreenshot calls can stall each other (recorder frames vs. model screenshots): serialize.
  capture(task) {
    const run = (this.captureChain || Promise.resolve()).then(task, task);
    this.captureChain = run.catch(() => {});
    return run;
  }

  screenshot() { return this.capture(() => this.takeScreenshot()); }

  async takeScreenshot() {
    if (this.dryRun) return { ...PLACEHOLDER_SHOT };
    const metrics = await this.cdp.send('Page.getLayoutMetrics');
    const vv = metrics.cssVisualViewport || metrics.visualViewport;
    const cssW = Math.round(vv.clientWidth); const cssH = Math.round(vv.clientHeight);
    const scale = cssW > 1600 ? 1600 / cssW : 1;
    const result = await this.cdp.send('Page.captureScreenshot', {
      format: 'jpeg', quality: 80, captureBeyondViewport: false,
      clip: { x: vv.pageX ?? 0, y: vv.pageY ?? 0, width: cssW, height: cssH, scale }
    });
    return { buffer: Buffer.from(result.data, 'base64'), mime: 'image/jpeg', width: Math.round(cssW * scale), height: Math.round(cssH * scale), scale };
  }

  async state() {
    if (this.dryRun) return { url: this.url, title: 'dry-run' };
    try {
      const o = await observe(this.cdp);
      return { url: o.url, title: o.title, text: o.text };
    } catch { return {}; }
  }

  // Throwing means the action did not run (or was blocked); the loop reports it to the model and keeps going.
  async execute(action, { scale = 1 } = {}) {
    if (this.dryRun) return { commands: toCdpCommands(action, { scale }) };
    if (!this.allowRisky && ['click', 'double_click'].includes(action.type)) await this.guardClick(action, scale);
    const commands = toCdpCommands(action, { scale });
    for (const c of commands) {
      if (c.sleep) await sleep(c.sleep);
      else await this.cdp.send(c.method, c.params);
    }
    return { commands: commands.length };
  }

  async guardClick(action, scale) {
    const target = await this.cdp.eval(`(() => {
      const el = document.elementFromPoint(${action.x / scale}, ${action.y / scale});
      const ctl = el && el.closest('button,[role="button"],a,input[type="submit"],input[type="button"]');
      return (ctl && (ctl.innerText || ctl.value || ctl.getAttribute('aria-label') || '') || '').trim();
    })()`);
    if (isRiskyLabel(target)) throw new Error(`Blocked by safety rules: "${target}" looks like a purchase or destructive account action. Record it as unreachable coverage instead.`);
  }

  // After each batch: let the page settle and keep the run inside the product.
  async settle() {
    if (this.dryRun) return { notes: [] };
    const notes = [];
    await sleep(350);
    try {
      for (let i = 0; i < 20; i++) {
        if (await this.cdp.eval('document.readyState') === 'complete') break;
        await sleep(150);
      }
    } catch { /* navigating: next eval will retry */ }
    let href;
    try { href = await this.cdp.eval('location.href'); } catch { return { notes }; }
    if (!this.attached && !hostAllowed(href, this)) {
      notes.push(`Navigation to ${href} was blocked: it is outside the product (${this.startHost}). The page was returned to ${this.lastGoodUrl}. Do not follow external links.`);
      try { await navigate(this.cdp, this.lastGoodUrl); } catch { /* best effort */ }
    } else {
      this.lastGoodUrl = href;
    }
    return { notes, url: this.lastGoodUrl };
  }

  // Fresh start for a replay: back to the page where the run began.
  async reset() {
    if (this.dryRun) return;
    if (this.attached) { await this.cdp.send('Page.reload').catch(() => {}); await sleep(800); return; }
    await this.cdp.eval('(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} })()').catch(() => {});
    await this.cdp.send('Network.enable').catch(() => {});
    await this.cdp.send('Network.clearBrowserCookies').catch(() => {});
    await navigate(this.cdp, this.startUrl);
  }

  // Center of a CSS selector in screenshot pixels (used by --mock scripts and tests).
  async locate(selector) {
    if (this.dryRun) return null;
    const scale = (await this.screenshot()).scale;
    const box = await this.cdp.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({block: 'center'});
      const r = el.getBoundingClientRect();
      return {x: r.x + r.width / 2, y: r.y + r.height / 2};
    })()`);
    return box ? { x: Math.round(box.x * scale), y: Math.round(box.y * scale) } : null;
  }

  // A cheap frame for the screen recorder (does not disturb the page).
  async frame() {
    if (this.dryRun) return null;
    return this.capture(async () => {
      const r = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, 5000);
      return Buffer.from(r.data, 'base64');
    });
  }
}
