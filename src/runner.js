import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { attach, launchBrowser } from './cdp.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safe = value => String(value).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 60);
const stamp = () => new Date().toISOString();

async function until(check, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

const pageUrl = cdp => cdp.eval('location.href');

async function navigate(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await until(() => cdp.eval('document.readyState === "complete"'), `page load: ${url}`, 15000);
}

async function observe(cdp) {
  return cdp.eval(`(() => {
    const clean = text => (text || '').replace(/\\s+/g, ' ').trim();
    const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    return {
      url: location.href,
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content || '',
      headings: Array.from(document.querySelectorAll('h1,h2,h3')).filter(visible).map(el => ({level: el.tagName.toLowerCase(), text: clean(el.innerText)})).filter(x => x.text).slice(0, 40),
      controls: Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role="button"]')).filter(visible).map(el => ({
        tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || undefined,
        label: clean(el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name')),
        href: el.tagName === 'A' ? el.href : undefined,
        type: el.getAttribute('type') || undefined
      })).slice(0, 100),
      text: clean(document.body?.innerText).slice(0, 4000)
    };
  })()`);
}

async function screenshot(cdp, path) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path, Buffer.from(result.data, 'base64'));
}

async function click(cdp, selector) {
  const box = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({block:'center'});
    const r = el.getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height};
  })()`);
  if (!box || !box.width || !box.height) throw new Error(`Missing or hidden element: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
}

async function fill(cdp, selector, value) {
  const found = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || !('value' in el)) return false;
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, ''); else el.value = '';
    el.dispatchEvent(new Event('input', {bubbles:true}));
    return true;
  })()`);
  if (!found) throw new Error(`Missing form field: ${selector}`);
  await cdp.send('Input.insertText', { text: value });
}

async function press(cdp, key) {
  const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8 };
  if (!(key in codes)) throw new Error(`Unsupported key: ${key}`);
  const params = { key, windowsVirtualKeyCode: codes[key], nativeVirtualKeyCode: codes[key] };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

async function stepAction(cdp, step, baseUrl) {
  const timeout = step.timeoutMs || 10000;
  switch (step.action) {
    case 'goto': {
      const url = new URL(step.url, baseUrl).href;
      await navigate(cdp, url);
      return;
    }
    case 'click': await click(cdp, step.selector); return;
    case 'fill': {
      const value = step.valueFromEnv ? process.env[step.valueFromEnv] : step.value;
      if (value === undefined) throw new Error(`Missing value for ${step.selector}`);
      await fill(cdp, step.selector, String(value)); return;
    }
    case 'press': await press(cdp, step.key); return;
    case 'waitFor':
      await until(() => cdp.eval(`!!document.querySelector(${JSON.stringify(step.selector)})`), step.selector, timeout);
      return;
    case 'assertText': {
      const actual = await cdp.eval(`document.body?.innerText || ''`);
      if (!actual.includes(step.text)) throw new Error(`Expected page text ${JSON.stringify(step.text)}; observed ${JSON.stringify(actual.slice(0, 300))}`);
      return;
    }
    case 'assertUrl': {
      const actual = await pageUrl(cdp);
      if (!actual.includes(step.contains)) throw new Error(`Expected URL containing ${JSON.stringify(step.contains)}; observed ${actual}`);
      return;
    }
    case 'wait': await sleep(Math.min(step.ms || 500, 30000)); return;
    case 'observe': return;
    default: throw new Error(`Unsupported action: ${step.action}`);
  }
}

async function startVideo(cdp, path, ffmpeg, fps = 2) {
  if (!ffmpeg) throw new Error('Video requested but no ffmpeg path supplied');
  const child = spawn(ffmpeg, [
    '-loglevel', 'error', '-y', '-f', 'image2pipe', '-vcodec', 'mjpeg',
    '-framerate', String(fps), '-i', 'pipe:0', '-c:v', 'libvpx', '-pix_fmt', 'yuv420p',
    '-f', 'webm', path
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.stderr.on('data', data => { stderr += data.toString(); });
  let busy = false;
  let stopped = false;
  const frame = async () => {
    if (busy || stopped || child.stdin.destroyed) return;
    busy = true;
    try {
      const result = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 75 }, 5000);
      child.stdin.write(Buffer.from(result.data, 'base64'));
    } catch {} finally { busy = false; }
  };
  await frame();
  const timer = setInterval(frame, 1000 / fps);
  return async () => {
    stopped = true;
    clearInterval(timer);
    while (busy) await sleep(20);
    child.stdin.end();
    const code = child.exitCode ?? await new Promise(resolve => child.once('exit', resolve));
    if (code !== 0 || spawnError) throw new Error(`Video encoder failed: ${spawnError?.message || stderr.trim()}`);
  };
}

function validate(config) {
  if (!config || !['website', 'electron'].includes(config.target?.type)) throw new Error('target.type must be website or electron');
  if (config.target.type === 'website' && !config.target.url) throw new Error('Website target.url is required');
  if (config.target.type === 'electron' && !config.target.cdpPort) throw new Error('Electron target.cdpPort is required');
  if (!Array.isArray(config.journeys) || !config.journeys.length) throw new Error('At least one journey is required');
  for (const journey of config.journeys) {
    if (!journey.name || !Array.isArray(journey.steps)) throw new Error('Each journey needs a name and steps');
  }
}

export async function run(config, options = {}) {
  validate(config);
  const out = resolve(options.output || `runs/${safe(config.name || 'run')}-${Date.now()}`);
  await mkdir(join(out, 'screenshots'), { recursive: true });
  await mkdir(join(out, 'video'), { recursive: true });
  let browser;
  let cdp;
  const report = {
    schemaVersion: 1, name: config.name || basename(out), target: config.target,
    startedAt: stamp(), finishedAt: null, status: 'running',
    product: null, journeys: [], findings: [], assets: [], limitations: []
  };
  // A local evidence path is the stable reference; downstream agents should not infer claims from filenames.
  const save = () => writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  try {
    if (config.target.type === 'website') {
      browser = await launchBrowser({ executable: options.chrome || config.target.chrome, headless: options.headless !== false });
      cdp = await attach(browser.port);
      await navigate(cdp, config.target.url);
    } else {
      cdp = await attach(config.target.cdpPort, config.target.pageMatch);
      report.limitations.push('Electron mode attaches to an existing Chromium renderer. Native menus and OS dialogs are outside this adapter.');
    }
    report.product = await observe(cdp);
    const first = 'screenshots/000-initial.png';
    await screenshot(cdp, join(out, first));
    report.assets.push({ type: 'screenshot', path: first, purpose: 'initial product view' });
    let index = 0;
    for (const journey of config.journeys) {
      const record = { name: journey.name, status: 'running', steps: [], startedAt: stamp(), finishedAt: null };
      report.journeys.push(record);
      let stopVideo;
      try {
        if (journey.video) {
          const videoPath = `video/${safe(journey.name)}.webm`;
          stopVideo = await startVideo(cdp, join(out, videoPath), options.ffmpeg || config.ffmpeg);
          record.video = videoPath;
        }
        for (const step of journey.steps) {
          index++;
          const entry = {
            index, action: step.action, selector: step.selector, url: step.url,
            text: step.action === 'assertText' ? step.text : undefined,
            value: step.action === 'fill' ? (step.valueFromEnv ? `[env:${step.valueFromEnv}]` : '[redacted]') : undefined,
            startedAt: stamp(), status: 'running'
          };
          record.steps.push(entry);
          try {
            await stepAction(cdp, step, config.target.url || await pageUrl(cdp));
            if (step.settleMs) await sleep(step.settleMs);
            entry.status = 'passed';
          } catch (error) {
            entry.status = 'failed';
            entry.error = error.message;
          }
          entry.finishedAt = stamp();
          try {
            entry.observation = await observe(cdp);
            const asset = `screenshots/${String(index).padStart(3, '0')}-${safe(journey.name)}-${safe(step.action)}.png`;
            await screenshot(cdp, join(out, asset));
            entry.screenshot = asset;
            report.assets.push({ type: 'screenshot', path: asset, journey: journey.name, step: index });
          } catch (error) { entry.captureError = error.message; }
          if (entry.status === 'failed') {
            report.findings.push({
              id: `QA-${String(report.findings.length + 1).padStart(3, '0')}`,
              severity: step.severity || 'medium', journey: journey.name,
              summary: step.failureSummary || `${step.action} failed`,
              expected: step.expected || `${step.action} should complete successfully`,
              actual: entry.error, stepsToReproduce: record.steps.map(s => ({ action: s.action, selector: s.selector, url: s.url, text: s.text })),
              evidence: entry.screenshot || null, observedAt: entry.finishedAt
            });
            break;
          }
        }
        record.status = record.steps.some(s => s.status === 'failed') ? 'failed' : 'passed';
      } finally {
        if (stopVideo) {
          try {
            await stopVideo();
            report.assets.push({ type: 'video', path: record.video, journey: journey.name });
          } catch (error) { record.videoError = error.message; }
        }
        record.finishedAt = stamp();
        await save();
      }
    }
    report.status = report.findings.length ? 'findings' : 'passed';
  } catch (error) {
    report.status = 'error';
    report.error = error.message;
  } finally {
    report.finishedAt = stamp();
    await save();
    cdp?.close();
    await browser?.close();
  }
  return { out, report };
}
