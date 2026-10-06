import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAction, canonicalKey, toCdpCommands, toMacCommands, cdpKeyEvents, describeAction, describeBatch,
  substituteSecrets, isRiskyLabel, pointOf, MAC_KEY_CODES
} from '../src/actions.mjs';

test('normalizeAction validates and canonicalizes each action type', () => {
  assert.deepEqual(normalizeAction({ type: 'click', x: 10, y: 20 }), { type: 'click', x: 10, y: 20, button: 'left' });
  assert.equal(normalizeAction({ type: 'click', x: 1, y: 1, button: 'right' }).button, 'right');
  assert.equal(normalizeAction({ type: 'click', x: 1, y: 1, button: 'middle' }).button, 'wheel');
  assert.deepEqual(normalizeAction({ type: 'click', x: 1, y: 1, keys: ['SHIFT'] }).keys, ['Shift']);
  assert.deepEqual(normalizeAction({ type: 'scroll', x: 5, y: 6, scroll_y: 300 }), { type: 'scroll', x: 5, y: 6, scroll_x: 0, scroll_y: 300 });
  assert.deepEqual(normalizeAction({ type: 'drag', path: [[1, 2], { x: 3, y: 4 }] }).path, [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  assert.deepEqual(normalizeAction({ type: 'keypress', keys: ['CTRL', 'a'] }).keys, ['Control', 'a']);
  assert.equal(normalizeAction({ type: 'wait' }).ms, 1500);
  assert.equal(normalizeAction({ type: 'wait', ms: 999999 }).ms, 10000);
  assert.deepEqual(normalizeAction({ type: 'screenshot' }), { type: 'screenshot' });
});

test('normalizeAction rejects anything unsafe or malformed', () => {
  assert.throws(() => normalizeAction(null), /object/);
  assert.throws(() => normalizeAction({ type: 'shell', cmd: 'rm -rf /' }), /unsupported action/);
  assert.throws(() => normalizeAction({ type: 'click', x: -1, y: 5 }), /outside/);
  assert.throws(() => normalizeAction({ type: 'click', x: 'a', y: 5 }), /finite/);
  assert.throws(() => normalizeAction({ type: 'click', x: 1, y: 1, button: 'back' }), /button/);
  assert.throws(() => normalizeAction({ type: 'drag', path: [[1, 1]] }), /two points/);
  assert.throws(() => normalizeAction({ type: 'keypress', keys: [] }), /keys/);
  assert.throws(() => normalizeAction({ type: 'type', text: 'x'.repeat(5000) }), /longer/);
  assert.throws(() => normalizeAction({ type: 'type' }), /text/);
});

test('key names map to canonical names', () => {
  assert.equal(canonicalKey('ENTER'), 'Enter');
  assert.equal(canonicalKey('esc'), 'Escape');
  assert.equal(canonicalKey('CMD'), 'Meta');
  assert.equal(canonicalKey('arrowleft'), 'ArrowLeft');
  assert.equal(canonicalKey('a'), 'a');
  assert.equal(canonicalKey('f5'), 'F5');
});

test('CDP click, double click and right click translate to mouse events scaled to CSS pixels', () => {
  const click = toCdpCommands({ type: 'click', x: 200, y: 100, button: 'left' }, { scale: 0.5 });
  assert.deepEqual(click.map(c => c.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(click[1].params.x, 400);
  assert.equal(click[1].params.y, 200);
  assert.equal(click[1].params.clickCount, 1);
  const dbl = toCdpCommands({ type: 'double_click', x: 5, y: 5 });
  assert.deepEqual(dbl.map(c => c.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased', 'mousePressed', 'mouseReleased']);
  assert.equal(dbl[3].params.clickCount, 2);
  assert.equal(toCdpCommands({ type: 'click', x: 1, y: 1, button: 'right' })[1].params.button, 'right');
  assert.equal(toCdpCommands({ type: 'click', x: 1, y: 1, button: 'wheel' })[1].params.button, 'middle');
});

test('CDP modifiers, scroll, drag and wait', () => {
  assert.equal(toCdpCommands({ type: 'click', x: 1, y: 1, button: 'left', keys: ['Shift', 'Meta'] })[1].params.modifiers, 8 | 4);
  const scroll = toCdpCommands({ type: 'scroll', x: 10, y: 20, scroll_x: 0, scroll_y: 400 });
  assert.equal(scroll[1].params.type, 'mouseWheel');
  assert.equal(scroll[1].params.deltaY, 400);
  const drag = toCdpCommands({ type: 'drag', path: [{ x: 1, y: 1 }, { x: 5, y: 5 }, { x: 9, y: 9 }] });
  assert.deepEqual(drag.map(c => c.params.type), ['mouseMoved', 'mousePressed', 'mouseMoved', 'mouseMoved', 'mouseReleased']);
  assert.deepEqual(toCdpCommands({ type: 'wait', ms: 700 }), [{ sleep: 700 }]);
  assert.deepEqual(toCdpCommands({ type: 'screenshot' }), []);
});

test('CDP typing inserts text and turns newlines into Enter', () => {
  const cmds = toCdpCommands({ type: 'type', text: 'hello\nworld' });
  assert.equal(cmds[0].method, 'Input.insertText');
  assert.equal(cmds[0].params.text, 'hello');
  assert.ok(cmds.some(c => c.params.key === 'Enter'));
  assert.equal(cmds.at(-1).params.text, 'world');
});

test('CDP keypress: named keys, characters, and edit shortcuts', () => {
  const enter = cdpKeyEvents(['Enter']);
  assert.equal(enter[0].params.type, 'keyDown');
  assert.equal(enter[0].params.windowsVirtualKeyCode, 13);
  const back = cdpKeyEvents(['Alt', 'ArrowLeft']);
  assert.equal(back[0].params.key, 'Alt');
  assert.equal(back[1].params.modifiers, 1);
  assert.equal(back[1].params.windowsVirtualKeyCode, 37);
  const selectAll = cdpKeyEvents(['Control', 'a']);
  assert.deepEqual(selectAll.find(e => e.params.commands)?.params.commands, ['selectAll']);
  assert.throws(() => cdpKeyEvents(['NotAKey']), /unsupported key/);
});

test('macOS translation uses cliclick for mouse when available', () => {
  assert.deepEqual(toMacCommands({ type: 'click', x: 200, y: 100, button: 'left' }, { scale: 2 }), [{ tool: 'cliclick', args: ['m:100,50', 'c:100,50'] }]);
  assert.deepEqual(toMacCommands({ type: 'click', x: 10, y: 10, button: 'right' })[0].args, ['m:10,10', 'rc:10,10']);
  assert.deepEqual(toMacCommands({ type: 'double_click', x: 10, y: 10 })[0].args, ['m:10,10', 'dc:10,10']);
  assert.deepEqual(toMacCommands({ type: 'move', x: 7, y: 8 })[0].args, ['m:7,8']);
  assert.deepEqual(toMacCommands({ type: 'click', x: 1, y: 1, button: 'left', keys: ['Shift'] })[0].args, ['kd:shift', 'm:1,1', 'c:1,1', 'ku:shift']);
  const drag = toMacCommands({ type: 'drag', path: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] })[0];
  assert.deepEqual(drag.args, ['dd:1,1', 'dm:2,2', 'du:3,3']);
});

test('macOS translation falls back to CGEvent JXA without cliclick, and scroll always uses JXA', () => {
  const click = toMacCommands({ type: 'click', x: 40, y: 50, button: 'left' }, { cliclick: false });
  assert.equal(click[0].tool, 'jxa');
  assert.match(click[0].script, /CGEventCreateMouseEvent/);
  assert.match(click[0].script, /"x":40,"y":50/);
  const wheel = toMacCommands({ type: 'click', x: 1, y: 1, button: 'wheel' }, { cliclick: true });
  assert.equal(wheel[0].tool, 'jxa');
  const scroll = toMacCommands({ type: 'scroll', x: 100, y: 100, scroll_x: 0, scroll_y: 300 }, { scale: 1 });
  assert.equal(scroll[0].tool, 'jxa');
  assert.match(scroll[0].script, /CGEventCreateScrollWheelEvent/);
  assert.match(scroll[0].script, /-300/, 'scrolling down is a negative wheel delta');
});

test('macOS typing and key presses go through System Events', () => {
  const typed = toMacCommands({ type: 'type', text: 'say "hi"\nnext' });
  assert.equal(typed[0].tool, 'osascript');
  assert.match(typed[0].args[1], /keystroke "say \\"hi\\""/);
  assert.match(typed[1].args[1], new RegExp(`key code ${MAC_KEY_CODES.Enter}`));
  assert.match(typed[2].args[1], /keystroke "next"/);
  const combo = toMacCommands({ type: 'keypress', keys: ['Meta', 'l'] });
  assert.match(combo[0].args[1], /keystroke "l" using \{command down\}/);
  const esc = toMacCommands({ type: 'keypress', keys: ['Escape'] });
  assert.match(esc[0].args[1], /key code 53/);
  assert.throws(() => toMacCommands({ type: 'keypress', keys: ['Meta'] }), /non-modifier/);
});

test('secret placeholders are substituted for execution but never appear in descriptions', () => {
  const env = { AGENT_TEST_EMAIL: 'qa+astra@example.test', AGENT_TEST_PASSWORD: 'hunter2-test' };
  const sub = substituteSecrets('{{TEST_EMAIL}} / {{TEST_PASSWORD}}', env);
  assert.equal(sub.text, 'qa+astra@example.test / hunter2-test');
  assert.equal(sub.used, true);
  assert.equal(substituteSecrets('plain', env).used, false);
  const described = describeAction({ type: 'type', text: '{{TEST_PASSWORD}}' });
  assert.ok(!described.includes('hunter2'));
  assert.equal(substituteSecrets('{{TEST_NAME}}', {}).text, '');
});

test('descriptions and pointers', () => {
  assert.equal(describeAction({ type: 'click', x: 10.4, y: 20.6, button: 'left' }), 'click (10, 21)');
  assert.equal(describeAction({ type: 'scroll', x: 0, y: 0, scroll_x: 0, scroll_y: -200 }), 'scroll up 200');
  assert.equal(describeBatch([{ type: 'keypress', keys: ['Enter'] }, { type: 'wait', ms: 1 }]), 'press Enter, then wait');
  assert.deepEqual(pointOf({ type: 'drag', path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }), { x: 1, y: 2 });
  assert.equal(pointOf({ type: 'type', text: 'x' }), null);
});

test('risky-label guard catches purchases and account deletion, not ordinary buttons', () => {
  assert.ok(isRiskyLabel('Place order'));
  assert.ok(isRiskyLabel('Pay now'));
  assert.ok(isRiskyLabel('Delete my account'));
  assert.ok(!isRiskyLabel('Get started'));
  assert.ok(!isRiskyLabel('Send message'));
  assert.ok(!isRiskyLabel(''));
});
