import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome } from './chrome-path.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
    });
  }

  async send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Page evaluation failed');
    }
    return result.result.value;
  }

  close() { this.ws.close(); }
}

async function endpoint(port, target) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
  const pages = (await response.json()).filter(item => item.type === 'page');
  const page = target ? pages.find(item => item.url.includes(target) || item.title.includes(target)) : pages[0];
  if (!page) throw new Error(`No CDP page found${target ? ` matching ${target}` : ''}`);
  return page.webSocketDebuggerUrl;
}

export async function attach(port, target) {
  const url = await endpoint(port, target);
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return cdp;
}

/** Opt-in (ASTRAHACK_CHROME_NO_SANDBOX=1) for isolated Linux VMs where Chrome's own sandbox cannot start. Off by default. */
export function isolatedVmChromeFlags(env = process.env) {
  return env.ASTRAHACK_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
}

export async function launchBrowser({ executable, headless = true, width = 1280, height = 800 }) {
  executable ||= findChrome();
  if (!executable) throw new Error('No Chrome/Chromium found. Install Google Chrome, or set ASTRAHACK_CHROME=/path/to/chrome (run `npm run doctor` to see what was checked).');
  const profile = await mkdtemp(join(tmpdir(), 'astrahack-chrome-'));
  const args = [
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--use-mock-keychain', '--password-store=basic', // a macOS Keychain prompt/stall otherwise delays the DevTools port past the wait
    `--window-size=${width},${height}`, 'about:blank'
  ];
  if (headless) args.unshift('--headless=new', '--disable-gpu');
  args.unshift(...isolatedVmChromeFlags());
  const child = spawn(executable, args, { stdio: 'ignore' });
  let launchError;
  child.on('error', error => { launchError = error; });
  const portFile = join(profile, 'DevToolsActivePort');
  let port;
  for (let i = 0; i < 300; i++) { // up to 30 s: Chrome can take >10 s to start on a loaded laptop
    if (launchError || child.exitCode !== null || child.signalCode !== null) break;
    try { port = Number((await readFile(portFile, 'utf8')).split('\n')[0]); break; } catch {}
    await sleep(100);
  }
  if (!port) {
    if (!launchError && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); // a Chrome stuck at startup ignores SIGTERM
    await rm(profile, { recursive: true, force: true });
    throw new Error(`Chrome did not expose a CDP port. ${launchError?.message || 'Check the executable and launch permissions.'}`);
  }
  return {
    port,
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill();
        await exited;
      }
      await rm(profile, { recursive: true, force: true });
    }
  };
}
