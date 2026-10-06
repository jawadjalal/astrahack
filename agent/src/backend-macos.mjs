// `macos` backend: OS-level computer use on this Mac.
//   screenshot  screencapture -x (+ sips downscale)
//   mouse       cliclick if installed (brew install cliclick), otherwise CGEvent via osascript JXA
//   keyboard    osascript System Events
//   scroll      CGEvent scroll wheel via osascript JXA
// Needs: Screen Recording (screenshots) and Accessibility (clicks/keys) granted to the app that launches node
// (Terminal, iTerm, Claude Code...). See docs/AGENT.md. `--dry-run` logs every command and executes none.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { toMacCommands } from './actions.mjs';
import { StopError } from './stop.mjs';
import { PLACEHOLDER_SHOT } from './placeholder.mjs';

const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const SCREEN_JXA = `ObjC.import('AppKit');
const f = $.NSScreen.mainScreen.frame;
JSON.stringify({width: f.size.width, height: f.size.height});`;
// CGPreflightScreenCaptureAccess is not bridged into JXA, so Screen Recording is probed with a real capture instead.
const PREFLIGHT_JXA = `ObjC.import('ApplicationServices');
JSON.stringify({accessibility: $.AXIsProcessTrusted()});`;

export async function hasCliclick() {
  try { await run('which', ['cliclick']); return true; } catch { return false; }
}

export class MacBackend {
  constructor({ url, app, dryRun = false, stop, log = () => {}, targetWidth = 1440, useCliclick } = {}) {
    this.name = 'macos';
    Object.assign(this, { url, app, dryRun, stop, log, targetWidth });
    this.useCliclick = useCliclick;
    this.startUrl = url || null;
    this.executed = [];   // dry-run transcript: every command that would have run
  }

  async jxa(script) { return (await run('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 15000 })).stdout.trim(); }

  async preflight() {
    const out = { cliclick: await hasCliclick(), screenRecording: null, accessibility: null };
    try { Object.assign(out, JSON.parse(await this.jxa(PREFLIGHT_JXA))); } catch (error) { out.error = error.message; }
    const dir = await mkdtemp(join(tmpdir(), 'astrahack-mac-'));
    try {
      await run('screencapture', ['-x', '-m', '-t', 'png', join(dir, 'probe.png')], { timeout: 15000 });
      out.screenRecording = true;
    } catch { out.screenRecording = false; } finally { await rm(dir, { recursive: true, force: true }); }
    return out;
  }

  async open() {
    if (this.useCliclick === undefined) this.useCliclick = await hasCliclick();
    const pre = await this.preflight();
    this.log(`macos: cliclick ${pre.cliclick ? 'found' : 'not found (using CGEvent fallback)'}, screen recording ${pre.screenRecording}, accessibility ${pre.accessibility}`);
    if (!this.dryRun) {
      if (pre.screenRecording === false) throw new Error('Screen Recording permission is not granted to this terminal app. System Settings > Privacy & Security > Screen & System Audio Recording, enable it, then restart the terminal.');
      if (pre.accessibility === false) throw new Error('Accessibility permission is not granted to this terminal app. System Settings > Privacy & Security > Accessibility, enable it, then restart the terminal.');
    }
    try { this.points = JSON.parse(await this.jxa(SCREEN_JXA)); } catch { this.points = { width: 1440, height: 900 }; }
    this.log(`macos: main display ${this.points.width}x${this.points.height} points`);
    if (this.url) await this.openUrl(this.url);
    if (this.app && !this.url) await this.activate();
  }

  async openUrl(url) {
    const args = this.app ? ['-a', this.app, url] : [url];
    await this.command({ tool: 'open', args });
    await sleep(this.dryRun ? 0 : 2500);
  }

  async activate() {
    if (!this.app) return;
    await this.command({ tool: 'osascript', args: ['-e', `tell application "${this.app.replace(/"/g, '')}" to activate`] });
    await sleep(this.dryRun ? 0 : 600);
  }

  async close() { /* nothing to tear down: the user's apps stay open */ }

  // -> { buffer, mime, width, height, scale }  scale = screenshot px per screen point
  async screenshot() {
    const dir = await mkdtemp(join(tmpdir(), 'astrahack-mac-'));
    try {
      const raw = join(dir, 'raw.png');
      const out = join(dir, 'shot.jpg');
      try {
        await run('screencapture', ['-x', '-m', '-t', 'png', raw], { timeout: 15000 });
        const probe = (await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', raw])).stdout;
        const pw = Number(probe.match(/pixelWidth:\s*(\d+)/)?.[1]);
        const width = Math.min(this.targetWidth, pw);
        await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '--resampleWidth', String(width), raw, '--out', out]);
        const sized = (await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', out])).stdout;
        const w = Number(sized.match(/pixelWidth:\s*(\d+)/)?.[1]);
        const h = Number(sized.match(/pixelHeight:\s*(\d+)/)?.[1]);
        const buffer = await readFile(out);
        return { buffer, mime: 'image/jpeg', width: w, height: h, scale: w / (this.points?.width || w) };
      } catch (error) {
        if (this.dryRun) {
          if (!this.warnedPlaceholder) { this.warnedPlaceholder = true; this.log(`macos: screenshots unavailable in dry-run (${error.message.split('\n')[0]}); using a placeholder image`); }
          return { ...PLACEHOLDER_SHOT };
        }
        throw new Error(`screencapture failed: ${error.message.split('\n')[0]}. Check Screen Recording permission.`);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  async frame() {
    if (this.dryRun) return null;
    return (await this.screenshot()).buffer;
  }

  async state() { return { app: this.app || 'desktop' }; }

  async command(c) {
    this.stop?.check();
    if (c.sleep) { await sleep(this.dryRun ? 0 : c.sleep); return; }
    const flat = a => a.replace(/\s*\n\s*/g, ' ; ');
    const printable = c.tool === 'jxa'
      ? `osascript -l JavaScript <${c.script.length} char CGEvent script: ${c.script.includes('ScrollWheel') ? 'scroll' : 'mouse'}>`
      : `${c.tool} ${c.args.map(a => flat(a.length > 90 ? a.slice(0, 87) + '...' : a)).join(' ')}`;
    if (this.dryRun) { this.executed.push(printable); this.log(`[dry-run] ${printable}`); return; }
    if (c.tool === 'jxa') await run('osascript', ['-l', 'JavaScript', '-e', c.script], { timeout: 15000 });
    else await run(c.tool, c.args, { timeout: 15000 });
  }

  async execute(action, { scale = 1 } = {}) {
    if (action.type === 'keypress' && action.keys.some(k => k === 'Escape')) this.stop?.mute?.(800);
    const commands = toMacCommands(action, { scale, cliclick: this.useCliclick !== false });
    for (const c of commands) await this.command(c);
    return { commands: commands.length };
  }

  async settle() { await sleep(this.dryRun ? 0 : 500); return { notes: [] }; }

  async reset() { if (this.url) await this.openUrl(this.url); else await this.activate(); }
}

export { StopError };
