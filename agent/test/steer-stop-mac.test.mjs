import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SteerInbox, startSteerServer, watchSteerFile } from '../src/steer.mjs';
import { StopController, StopError, ESC_WATCHER_JXA } from '../src/stop.mjs';
import { MacBackend } from '../src/backend-macos.mjs';
import { normalizeAction } from '../src/actions.mjs';
import { parseCli } from '../src/cli.mjs';
import { hostAllowed, siteOf } from '../src/backend-cdp.mjs';
import { tmp } from './helpers.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('steer inbox queues, trims, drains with the HUMAN STEER prefix and ignores blanks', () => {
  const inbox = new SteerInbox();
  assert.equal(inbox.push('   '), false);
  inbox.push('  skip onboarding,   show me settings ');
  inbox.push('and then try dark mode');
  assert.equal(inbox.pending, 2);
  assert.deepEqual(inbox.drain(), ['HUMAN STEER: skip onboarding, show me settings', 'HUMAN STEER: and then try dark mode']);
  assert.equal(inbox.pending, 0);
  assert.deepEqual(inbox.drain(), []);
});

test('steer HTTP endpoint accepts JSON, plain text and GET; status and stop work', async () => {
  const inbox = new SteerInbox();
  let stopped = null;
  const server = await startSteerServer({ inbox, port: 0, getStatus: () => ({ state: 'running' }), onStop: r => { stopped = r; } });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/steer`, { method: 'POST', body: JSON.stringify({ text: 'one' }) })).json(), { ok: true });
    assert.deepEqual(await (await fetch(`${base}/steer`, { method: 'POST', body: 'two plain' })).json(), { ok: true });
    assert.deepEqual(await (await fetch(`${base}/steer?text=three`)).json(), { ok: true });
    assert.deepEqual(inbox.drain().map(s => s.replace('HUMAN STEER: ', '')), ['one', 'two plain', 'three']);
    assert.deepEqual(await (await fetch(`${base}/status`)).json(), { state: 'running' });
    await fetch(`${base}/stop`, { method: 'POST' });
    assert.equal(stopped, 'http /stop');
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally { await server.close(); }
});

test('steer file is tailed, ignoring content that existed before', async () => {
  const dir = await tmp('steer-file-');
  const file = join(dir, 'steer.txt');
  await writeFile(file, 'old line\n');
  const inbox = new SteerInbox();
  const stop = watchSteerFile(file, inbox, 20);
  await appendFile(file, 'new one\nnew two\n');
  await sleep(120);
  stop();
  assert.deepEqual(inbox.drain().map(s => s.replace('HUMAN STEER: ', '')), ['new one', 'new two']);
});

test('stop controller: STOP file, trigger, check() and stale file cleanup', async () => {
  const dir = await tmp('stop-');
  const file = join(dir, 'STOP');
  await writeFile(file, 'stale');
  const stop = new StopController({ files: [file] }).install({ signals: false, pollMs: 20 });
  try {
    assert.equal(stop.stopped, false, 'a stale STOP file from an earlier run does not kill a new run');
    stop.check();
    await writeFile(file, 'now');
    await sleep(100);
    assert.equal(stop.stopped, true);
    assert.match(stop.reason, /stop file/);
    assert.throws(() => stop.check(), StopError);
  } finally { stop.dispose(); }
});

test('the Esc watcher script polls key state (keycode 53) and is muted around the agent\'s own Escape presses', () => {
  assert.match(ESC_WATCHER_JXA, /CGEventSourceKeyState/);
  assert.match(ESC_WATCHER_JXA, /53/);
  const stop = new StopController({});
  stop.mute(500);
  assert.ok(stop.muteUntil > Date.now());
});

test('macOS dry-run logs every command and executes nothing', async () => {
  const logs = [];
  const mac = new MacBackend({ url: 'https://example.test', dryRun: true, useCliclick: true, log: m => logs.push(m), stop: new StopController({}) });
  mac.points = { width: 1440, height: 900 };
  await mac.execute(normalizeAction({ type: 'click', x: 200, y: 100 }), { scale: 1 });
  await mac.execute(normalizeAction({ type: 'type', text: 'hello' }), { scale: 1 });
  await mac.execute(normalizeAction({ type: 'keypress', keys: ['CMD', 'l'] }), { scale: 1 });
  await mac.execute(normalizeAction({ type: 'scroll', x: 5, y: 5, scroll_y: 300 }), { scale: 1 });
  assert.equal(mac.executed.length, 4);
  assert.match(mac.executed[0], /^cliclick m:200,100 c:200,100/);
  assert.match(mac.executed[1], /^osascript -e tell application "System Events"/);
  assert.match(mac.executed[3], /osascript -l JavaScript/);
  assert.ok(logs.every(l => l.startsWith('[dry-run]')));
});

test('generated JXA scripts are syntactically valid JavaScript', async () => {
  const { toMacCommands } = await import('../src/actions.mjs');
  const scripts = [
    ...toMacCommands(normalizeAction({ type: 'click', x: 1, y: 2 }), { cliclick: false }),
    ...toMacCommands(normalizeAction({ type: 'double_click', x: 1, y: 2, button: 'left' }), { cliclick: false }),
    ...toMacCommands(normalizeAction({ type: 'drag', path: [[1, 1], [5, 5], [9, 9]] }), { cliclick: false }),
    ...toMacCommands(normalizeAction({ type: 'scroll', x: 1, y: 2, scroll_y: -250, scroll_x: 40 }))
  ].filter(c => c.tool === 'jxa').map(c => c.script);
  assert.equal(scripts.length, 4);
  for (const s of [...scripts, ESC_WATCHER_JXA]) assert.doesNotThrow(() => new Function(s), s.slice(0, 60));
});

test('macOS backend honours the stop controller between commands', async () => {
  const stop = new StopController({});
  const mac = new MacBackend({ dryRun: true, useCliclick: true, stop, log: () => {} });
  stop.trigger('test');
  await assert.rejects(() => mac.execute(normalizeAction({ type: 'click', x: 1, y: 1 })), StopError);
  assert.equal(mac.executed.length, 0);
});

test('macOS dry-run screenshot falls back to a valid placeholder image if capture is not permitted', async () => {
  const mac = new MacBackend({ dryRun: true, useCliclick: false, log: () => {} });
  mac.points = { width: 1440, height: 900 };
  const shot = await mac.screenshot();
  assert.ok(shot.buffer.length > 100);
  assert.ok(shot.width > 0 && shot.height > 0 && shot.scale > 0);
  assert.equal(shot.buffer[0], 0xff);
});

test('CLI parsing: defaults, validation and the documented flags', () => {
  const o = parseCli(['https://example.com', '--brief', 'look at pricing', '--max-steps', '12', '--canvas', 'https://ignura.com/astrahack/', '--dry-run'], {});
  assert.equal(o.target, 'https://example.com');
  assert.equal(o.backend, 'cdp');
  assert.equal(o.maxSteps, 12);
  assert.equal(o.canvas, 'https://ignura.com/astrahack/');
  assert.equal(o.dryRun, true);
  assert.equal(o.model, 'gpt-6-astra');
  assert.equal(o.verify.enabled, true);
  assert.equal(parseCli(['x.test', '--no-verify'], {}).verify.enabled, false);
  assert.equal(parseCli(['x.test', '--no-record'], {}).record, false);
  assert.equal(parseCli(['x.test'], { ASTRA_MODEL: 'gpt-6.1-sol', CANVAS_URL: 'http://c', AGENT_PORT: '9000' }).model, 'gpt-6.1-sol');
  assert.equal(parseCli(['x.test'], { CANVAS_URL: 'http://c', AGENT_PORT: '9000' }).canvas, 'http://c');
  assert.equal(parseCli(['x.test'], { AGENT_PORT: '9000' }).port, 9000);
  assert.equal(parseCli(['--app', '9222'], {}).cdpPort, 9222);
  assert.equal(parseCli(['--mock'], {}).mock, true);
  assert.deepEqual(parseCli(['x.test', '--allow-host', 'auth.x.test', '--allow-host', 'cdn.x.test'], {}).allowHosts, ['auth.x.test', 'cdn.x.test']);
  assert.throws(() => parseCli([], {}), /url/);
  assert.throws(() => parseCli(['x.test', '--backend', 'vnc'], {}), /backend/);
  assert.throws(() => parseCli(['x.test', '--max-steps', '0'], {}), /max-steps/);
  assert.throws(() => parseCli(['x.test', '--backend', 'macos', '--app', '9222'], {}), /--mac-app/);
});

test('browser origin policy: same site and allow-listed hosts only', () => {
  assert.equal(siteOf('app.shop.example.com'), 'example.com');
  const policy = { startHost: 'www.example.com', allowHosts: ['accounts.google.com'] };
  assert.equal(hostAllowed('https://app.example.com/x', policy), true);
  assert.equal(hostAllowed('https://accounts.google.com/o/oauth', policy), true);
  assert.equal(hostAllowed('https://evil.test/', policy), false);
  assert.equal(hostAllowed('javascript:alert(1)', policy), false);
  assert.equal(hostAllowed('about:blank', policy), true);
  assert.equal(hostAllowed('file:///etc/passwd', policy), false);
  assert.equal(hostAllowed('http://127.0.0.1:3000/', { startHost: '127.0.0.1', allowHosts: [] }), true);
});
