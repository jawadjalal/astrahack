import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Find a Chrome/Chromium executable on any teammate's machine.
// Order: ASTRAHACK_CHROME, CHROME_PATH, the usual install locations per OS, then a Playwright browser cache.
// Returns the first path that exists, or null. Never throws.
export function chromeCandidates(env = process.env, platform = process.platform, home = homedir()) {
  const list = [env.ASTRAHACK_CHROME, env.CHROME_PATH];
  if (platform === 'darwin') {
    for (const app of ['Google Chrome', 'Google Chrome Canary', 'Chromium', 'Brave Browser', 'Microsoft Edge']) {
      list.push(`/Applications/${app}.app/Contents/MacOS/${app}`, join(home, `Applications/${app}.app/Contents/MacOS/${app}`));
    }
  } else if (platform === 'win32') {
    for (const root of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) {
      list.push(join(root, 'Google/Chrome/Application/chrome.exe'), join(root, 'Microsoft/Edge/Application/msedge.exe'));
    }
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge');
  }
  // A Playwright browser cache (`npx playwright install chromium`) works too.
  const caches = [
    env.PLAYWRIGHT_BROWSERS_PATH,
    platform === 'darwin' ? join(home, 'Library/Caches/ms-playwright') : platform === 'win32' ? join(env.LOCALAPPDATA || home, 'ms-playwright') : join(home, '.cache/ms-playwright'),
  ].filter(Boolean);
  for (const cache of caches) {
    let dirs = [];
    try { dirs = readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort().reverse(); } catch { /* no cache */ }
    for (const d of dirs) {
      const base = join(cache, d);
      for (const sub of ['chrome-mac-arm64', 'chrome-mac', 'chrome-mac-x64']) {
        list.push(
          join(base, sub, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
          join(base, sub, 'Chromium.app/Contents/MacOS/Chromium'),
        );
      }
      list.push(join(base, 'chrome-linux/chrome'), join(base, 'chrome-linux64/chrome'), join(base, 'chrome-win/chrome.exe'), join(base, 'chrome-win64/chrome.exe'));
    }
  }
  return list.filter(Boolean);
}

export function findChrome(env = process.env, platform = process.platform, home = homedir()) {
  return chromeCandidates(env, platform, home).find(p => existsSync(p)) || null;
}
