import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { executeComputerAction } from '../src/computer-actions.js';
import { attach, launchBrowser } from '../src/cdp.js';
import { navigate } from '../src/runner.js';

const origin = 'https://site.test';
const chrome = process.env.ASTRAHACK_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
function recorder(target = {}) {
  const events = [];
  return { events, eval: async () => target, send: async (method, params) => { events.push({ method, ...params }); } };
}

test('key chords use browser key names, modifier events, and portable select-all', async () => {
  const cdp = recorder();
  await executeComputerAction(cdp, { type: 'keypress', keys: ['CTRL', 'A'] }, origin);
  assert.deepEqual(cdp.events.map(event => [event.type, event.key, event.modifiers]), [
    ['rawKeyDown', 'Control', 2], ['rawKeyDown', 'a', 2], ['keyUp', 'a', 2], ['keyUp', 'Control', 0]
  ]);
  assert.deepEqual(cdp.events[1].commands, ['selectAll']);
  assert.equal(cdp.events[1].code, 'KeyA');
  cdp.events.length = 0;
  await executeComputerAction(cdp, { type: 'keypress', keys: ['Shift', 'Tab'] }, origin);
  assert.equal(cdp.events[1].key, 'Tab');
  assert.equal(cdp.events[1].modifiers, 8);
  cdp.events.length = 0;
  await executeComputerAction(cdp, { type: 'keypress', keys: ['ArrowDown'] }, origin);
  assert.equal(cdp.events[0].key, 'ArrowDown');
  assert.equal(cdp.events[0].windowsVirtualKeyCode, 40);
});

test('unsupported key chords and mouse modifiers fail before browser input', async () => {
  const cdp = recorder();
  for (const keys of [[], ['SHIFT'], ['A', 'B'], ['NotAKey'], ['CTRL', 12]]) {
    await assert.rejects(executeComputerAction(cdp, { type: 'keypress', keys }, origin));
  }
  for (const options of [{ keys: ['A'] }, { modifiers: 'SHIFT' }, { keys: [], modifiers: [] }]) {
    await assert.rejects(executeComputerAction(cdp, { type: 'click', x: 10, y: 10, ...options }, origin));
  }
  assert.equal(cdp.events.length, 0);
});

test('double click sends two full clicks and preserves mouse modifiers', async () => {
  const cdp = recorder();
  await executeComputerAction(cdp, { type: 'double_click', x: 10, y: 20, keys: ['SHIFT', 'CTRL'] }, origin);
  assert.deepEqual(cdp.events.map(event => [event.type, event.clickCount]), [
    ['mousePressed', 1], ['mouseReleased', 1], ['mousePressed', 2], ['mouseReleased', 2]
  ]);
  assert.ok(cdp.events.every(event => event.modifiers === 10));
});

test('click and drag retain origin and consequential-control guards', async () => {
  for (const action of [{ type: 'click', x: 10, y: 10 }, { type: 'drag', path: [{ x: 10, y: 10 }, { x: 20, y: 20 }] }]) {
    for (const [target, message] of [[{ href: 'https://other.test/' }, /External link blocked/], [{ label: 'Delete account' }, /Consequential action blocked/]]) {
      const cdp = recorder(target);
      await assert.rejects(executeComputerAction(cdp, action, origin), message);
      assert.equal(cdp.events.length, 0);
    }
  }
});

test('scroll rejects non-finite, oversized, and nonnumeric deltas', async () => {
  const cdp = recorder();
  for (const value of [NaN, Infinity, -Infinity, 10001, -10001, '20']) {
    await assert.rejects(executeComputerAction(cdp, { type: 'scroll', x: 20, y: 20, scroll_y: value }, origin), /Scroll deltas/);
  }
  assert.equal(cdp.events.length, 0);
  await executeComputerAction(cdp, { type: 'scroll', x: 20, y: 20, scroll_y: -800 }, origin);
  assert.equal(cdp.events[0].deltaX, 0);
  assert.equal(cdp.events[0].deltaY, -800);
});

test('drag validates its full path and releases the mouse after a failed move', async () => {
  const cdp = recorder();
  await assert.rejects(executeComputerAction(cdp, { type: 'drag', path: [{ x: 5, y: 5 }, { x: Infinity, y: 5 }] }, origin), /coordinates/);
  assert.equal(cdp.events.length, 0);
  const send = cdp.send;
  cdp.send = async (method, params) => {
    await send(method, params);
    if (params.type === 'mouseMoved' && params.buttons === 1) throw new Error('Fixture input failure');
  };
  await assert.rejects(executeComputerAction(cdp, { type: 'drag', path: [{ x: 5, y: 5 }, { x: 30, y: 30 }] }, origin), /Fixture input failure/);
  assert.equal(cdp.events.at(-1).type, 'mouseReleased');
  assert.equal(cdp.events.at(-1).x, 30);
});

test('keyboard modifiers are released after an input failure', async () => {
  const cdp = recorder();
  const send = cdp.send;
  cdp.send = async (method, params) => {
    await send(method, params);
    if (params.type === 'rawKeyDown' && params.key === 'a') throw new Error('Fixture input failure');
  };
  await assert.rejects(executeComputerAction(cdp, { type: 'keypress', keys: ['META', 'A'] }, origin), /Fixture input failure/);
  assert.equal(cdp.events.at(-1).key, 'Meta');
  assert.equal(cdp.events.at(-1).type, 'keyUp');
  assert.equal(cdp.events.at(-1).modifiers, 0);
});

test('real Chrome edits a field, shifts focus, double clicks, and drags using computer actions', { skip: !existsSync(chrome) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astrahack-actions-test-'));
  let browser;
  let cdp;
  try {
    const fixture = join(directory, 'fixture.html');
    await writeFile(fixture, `<!doctype html><title>Action fixture</title>
      <input id="field" value="original" style="position:absolute;left:20px;top:20px;width:200px;height:30px">
      <button id="button" style="position:absolute;left:20px;top:80px;width:200px;height:40px">Details</button>
      <div id="drag" style="position:absolute;left:350px;top:20px;width:200px;height:150px;background:#ccc;touch-action:none"></div>
      <script>
        window.events = {clicks:[], doubles:0, moves:0, releases:0};
        button.onclick = event => events.clicks.push({detail:event.detail, shift:event.shiftKey});
        button.ondblclick = () => events.doubles++;
        drag.onpointermove = event => {if (event.buttons === 1) events.moves++};
        drag.onpointerup = () => events.releases++;
      </script>`);
    browser = await launchBrowser({ executable: chrome });
    cdp = await attach(browser.port);
    await navigate(cdp, pathToFileURL(fixture).href);
    const act = action => executeComputerAction(cdp, action, 'null');
    await act({ type: 'click', x: 70, y: 35 });
    await act({ type: 'keypress', keys: ['CTRL', 'A'] });
    await act({ type: 'type', text: 'beta' });
    assert.equal(await cdp.eval('field.value'), 'beta');
    await act({ type: 'keypress', keys: ['META', 'A'] });
    await act({ type: 'type', text: 'gamma' });
    assert.equal(await cdp.eval('field.value'), 'gamma');
    await act({ type: 'keypress', keys: ['Tab'] });
    assert.equal(await cdp.eval('document.activeElement.id'), 'button');
    await act({ type: 'keypress', keys: ['SHIFT', 'Tab'] });
    assert.equal(await cdp.eval('document.activeElement.id'), 'field');
    await act({ type: 'double_click', x: 70, y: 100, keys: ['SHIFT'] });
    const clicks = await cdp.eval('events');
    assert.deepEqual(clicks.clicks, [{ detail: 1, shift: true }, { detail: 2, shift: true }]);
    assert.equal(clicks.doubles, 1);
    await act({ type: 'drag', path: [{ x: 370, y: 50 }, { x: 400, y: 70 }, { x: 450, y: 100 }] });
    const dragged = await cdp.eval('events');
    assert.ok(dragged.moves >= 2);
    assert.equal(dragged.releases, 1);
  } finally {
    cdp?.close();
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
