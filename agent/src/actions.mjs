// Action vocabulary of the OpenAI `computer` tool and pure translators to backend commands.
// Everything here is side-effect free so it can be unit tested without a browser or a Mac.
//
// Model actions (from the Responses API computer_call.actions[]):
//   click{x,y,button?,keys?} double_click{x,y,keys?} drag{path,keys?} move{x,y,keys?}
//   scroll{x,y,scroll_x,scroll_y,keys?} keypress{keys[]} type{text} wait screenshot

export const ACTION_TYPES = ['click', 'double_click', 'drag', 'move', 'scroll', 'keypress', 'type', 'wait', 'screenshot'];

export const MAX_COORD = 10000;
export const MAX_TYPE_LENGTH = 2000;
export const MAX_ACTIONS_PER_BATCH = 12;

const num = (v, name) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a finite number`);
  return v;
};
const coord = (v, name) => {
  num(v, name);
  if (v < 0 || v > MAX_COORD) throw new Error(`${name}=${v} is outside the screen`);
  return v;
};

const KEY_ALIASES = {
  ENTER: 'Enter', RETURN: 'Enter', ESC: 'Escape', ESCAPE: 'Escape', TAB: 'Tab', SPACE: ' ', BACKSPACE: 'Backspace',
  DELETE: 'Delete', DEL: 'Delete', HOME: 'Home', END: 'End', PAGEUP: 'PageUp', PAGEDOWN: 'PageDown',
  UP: 'ArrowUp', ARROWUP: 'ArrowUp', DOWN: 'ArrowDown', ARROWDOWN: 'ArrowDown',
  LEFT: 'ArrowLeft', ARROWLEFT: 'ArrowLeft', RIGHT: 'ArrowRight', ARROWRIGHT: 'ArrowRight',
  CTRL: 'Control', CONTROL: 'Control', SHIFT: 'Shift', OPTION: 'Alt', ALT: 'Alt',
  META: 'Meta', CMD: 'Meta', COMMAND: 'Meta', SUPER: 'Meta', WIN: 'Meta'
};
const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

export function canonicalKey(key) {
  const raw = String(key);
  const alias = KEY_ALIASES[raw.toUpperCase()];
  if (alias) return alias;
  if (/^F([1-9]|1[0-2])$/i.test(raw)) return raw.toUpperCase();
  return raw.length === 1 ? raw : raw[0].toUpperCase() + raw.slice(1);
}

export const isModifier = key => MODIFIERS.has(canonicalKey(key));

// Validate and canonicalize a raw model action. Throws on anything we should not execute.
export function normalizeAction(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('action must be an object');
  const type = raw.type;
  if (!ACTION_TYPES.includes(type)) throw new Error(`unsupported action type: ${type}`);
  const keys = Array.isArray(raw.keys) ? raw.keys.map(canonicalKey) : undefined;
  switch (type) {
    case 'click': {
      const button = raw.button || 'left';
      if (!['left', 'right', 'wheel', 'middle'].includes(button)) throw new Error(`unsupported mouse button: ${button}`);
      return { type, x: coord(raw.x, 'x'), y: coord(raw.y, 'y'), button: button === 'middle' ? 'wheel' : button, ...(keys?.length ? { keys } : {}) };
    }
    case 'double_click':
    case 'move':
      return { type, x: coord(raw.x, 'x'), y: coord(raw.y, 'y'), ...(keys?.length ? { keys } : {}) };
    case 'scroll':
      return {
        type, x: coord(raw.x ?? 0, 'x'), y: coord(raw.y ?? 0, 'y'),
        scroll_x: num(raw.scroll_x ?? 0, 'scroll_x'), scroll_y: num(raw.scroll_y ?? 0, 'scroll_y'), ...(keys?.length ? { keys } : {})
      };
    case 'drag': {
      if (!Array.isArray(raw.path) || raw.path.length < 2) throw new Error('drag needs a path of at least two points');
      const path = raw.path.map(p => {
        const [x, y] = Array.isArray(p) ? p : [p?.x, p?.y];
        return { x: coord(x, 'path.x'), y: coord(y, 'path.y') };
      });
      return { type, path, ...(keys?.length ? { keys } : {}) };
    }
    case 'keypress': {
      if (!keys?.length) throw new Error('keypress needs keys[]');
      return { type, keys };
    }
    case 'type': {
      if (typeof raw.text !== 'string') throw new Error('type needs text');
      if (raw.text.length > MAX_TYPE_LENGTH) throw new Error(`typed text longer than ${MAX_TYPE_LENGTH} chars`);
      return { type, text: raw.text };
    }
    case 'wait': return { type, ms: Math.min(Math.max(num(raw.ms ?? 1500, 'ms'), 0), 10000) };
    case 'screenshot': return { type };
  }
}

// ---- secrets: the model types placeholders, the harness substitutes the real value ----

export const SECRET_PLACEHOLDERS = {
  '{{TEST_EMAIL}}': 'AGENT_TEST_EMAIL',
  '{{TEST_PASSWORD}}': 'AGENT_TEST_PASSWORD',
  '{{TEST_NAME}}': 'AGENT_TEST_NAME',
  '{{TEST_PHONE}}': 'AGENT_TEST_PHONE'
};

export function substituteSecrets(text, env = process.env) {
  let out = text;
  let used = false;
  for (const [token, name] of Object.entries(SECRET_PLACEHOLDERS)) {
    if (out.includes(token)) {
      used = true;
      out = out.split(token).join(env[name] ?? '');
    }
  }
  return { text: out, used };
}

// What we log/stream: never the substituted value.
export function describeAction(action) {
  switch (action.type) {
    case 'click': return `${action.button && action.button !== 'left' ? action.button + '-' : ''}click (${Math.round(action.x)}, ${Math.round(action.y)})`;
    case 'double_click': return `double-click (${Math.round(action.x)}, ${Math.round(action.y)})`;
    case 'move': return `move (${Math.round(action.x)}, ${Math.round(action.y)})`;
    case 'scroll': return `scroll ${action.scroll_y ? (action.scroll_y > 0 ? 'down' : 'up') + ' ' + Math.abs(Math.round(action.scroll_y)) : ''}${action.scroll_x ? ' ' + (action.scroll_x > 0 ? 'right' : 'left') + ' ' + Math.abs(Math.round(action.scroll_x)) : ''}`.trim();
    case 'drag': return `drag (${Math.round(action.path[0].x)}, ${Math.round(action.path[0].y)}) -> (${Math.round(action.path.at(-1).x)}, ${Math.round(action.path.at(-1).y)})`;
    case 'keypress': return `press ${action.keys.join('+')}`;
    case 'type': {
      const shown = action.text.length > 28 ? action.text.slice(0, 28) + '...' : action.text;
      return `type "${shown}"`;
    }
    case 'wait': return 'wait';
    case 'screenshot': return 'look';
    default: return action.type;
  }
}

export const describeBatch = actions => actions.map(describeAction).join(', then ');

// The point the model is "pointing at" on the screenshot it just saw, or null.
export function pointOf(action) {
  if (action.type === 'drag') return action.path[0];
  if (['click', 'double_click', 'move', 'scroll'].includes(action.type)) return { x: action.x, y: action.y };
  return null;
}

// ---- CDP translation ----

const CDP_KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' }, Tab: { code: 'Tab', vk: 9 }, Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 }, Delete: { code: 'Delete', vk: 46 }, ' ': { code: 'Space', vk: 32, text: ' ' },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 }, ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowRight: { code: 'ArrowRight', vk: 39 }, ArrowDown: { code: 'ArrowDown', vk: 40 },
  Home: { code: 'Home', vk: 36 }, End: { code: 'End', vk: 35 }, PageUp: { code: 'PageUp', vk: 33 }, PageDown: { code: 'PageDown', vk: 34 }
};
const CDP_MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' };

export function cdpKeyEvents(keys) {
  const mods = keys.filter(isModifier);
  const mains = keys.filter(k => !isModifier(k));
  const modifiers = mods.reduce((bits, k) => bits | CDP_MODIFIER_BITS[k], 0);
  const events = [];
  for (const m of mods) events.push({ method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: m, code: m + 'Left', modifiers } });
  const shortcut = (modifiers & (2 | 4)) !== 0;
  for (const key of mains.length ? mains : []) {
    let info = CDP_KEYS[key];
    if (!info && key.length === 1) {
      const upper = key.toUpperCase();
      info = { code: /[a-z]/i.test(key) ? `Key${upper}` : /\d/.test(key) ? `Digit${key}` : '', vk: upper.charCodeAt(0), text: key };
    }
    if (!info && /^F\d+$/.test(key)) info = { code: key, vk: 111 + Number(key.slice(1)) };
    if (!info) throw new Error(`unsupported key: ${key}`);
    const base = { key, code: info.code, windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk, modifiers };
    const commands = shortcut && EDIT_COMMANDS[key.toLowerCase()] ? [EDIT_COMMANDS[key.toLowerCase()]] : undefined;
    const text = !shortcut && !(modifiers & 1) && info.text ? info.text : undefined;
    events.push({ method: 'Input.dispatchKeyEvent', params: { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}), ...(commands ? { commands } : {}) } });
    events.push({ method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...base } });
  }
  for (const m of mods.slice().reverse()) events.push({ method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: m, code: m + 'Left', modifiers: 0 } });
  return events;
}

// Returns an ordered list of {method, params} or {sleep: ms}. `scale` = screenshot px per CSS px.
export function toCdpCommands(action, { scale = 1 } = {}) {
  const s = v => v / scale;
  const mod = action.keys ? action.keys.filter(isModifier).reduce((b, k) => b | CDP_MODIFIER_BITS[k], 0) : 0;
  const mouse = (type, x, y, extra = {}) => ({ method: 'Input.dispatchMouseEvent', params: { type, x: s(x), y: s(y), modifiers: mod, ...extra } });
  switch (action.type) {
    case 'screenshot': return [];
    case 'wait': return [{ sleep: action.ms ?? 1500 }];
    case 'move': return [mouse('mouseMoved', action.x, action.y)];
    case 'click':
    case 'double_click': {
      const button = action.button === 'wheel' ? 'middle' : action.button || 'left';
      const n = action.type === 'double_click' ? 2 : 1;
      const out = [mouse('mouseMoved', action.x, action.y)];
      for (let i = 1; i <= n; i++) {
        out.push(mouse('mousePressed', action.x, action.y, { button, clickCount: i }));
        out.push(mouse('mouseReleased', action.x, action.y, { button, clickCount: i }));
      }
      return out;
    }
    case 'drag': {
      const [first, ...rest] = action.path;
      const out = [mouse('mouseMoved', first.x, first.y), mouse('mousePressed', first.x, first.y, { button: 'left', clickCount: 1 })];
      for (const p of rest) out.push(mouse('mouseMoved', p.x, p.y, { button: 'left', buttons: 1 }));
      const last = action.path.at(-1);
      out.push(mouse('mouseReleased', last.x, last.y, { button: 'left', clickCount: 1 }));
      return out;
    }
    case 'scroll':
      return [mouse('mouseMoved', action.x, action.y), mouse('mouseWheel', action.x, action.y, { deltaX: action.scroll_x || 0, deltaY: action.scroll_y || 0 })];
    case 'keypress': return cdpKeyEvents(action.keys);
    case 'type': {
      const out = [];
      action.text.split('\n').forEach((line, i) => {
        if (i > 0) out.push(...cdpKeyEvents(['Enter']));
        if (line) out.push({ method: 'Input.insertText', params: { text: line } });
      });
      return out;
    }
  }
  throw new Error(`cannot translate ${action.type}`);
}

// ---- macOS translation ----
// Commands: {tool:'cliclick', args:[..]} | {tool:'osascript', args:['-e', script]} | {tool:'jxa', script} | {sleep}

export const MAC_KEY_CODES = {
  Enter: 36, Tab: 48, ' ': 49, Backspace: 51, Escape: 53, Delete: 117,
  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126, Home: 115, End: 119, PageUp: 116, PageDown: 121,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111
};
const MAC_MODIFIER_WORDS = { Control: 'control', Shift: 'shift', Alt: 'option', Meta: 'command' };
const CLICLICK_MODS = { Control: 'ctrl', Shift: 'shift', Alt: 'alt', Meta: 'cmd' };

export const asString = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const jxaLiteral = v => JSON.stringify(v);

function jxaMouseScript(events) {
  // events: [{kind:'down'|'up'|'move'|'drag', button:'left'|'right'|'center', x, y, clicks?}] in screen points
  return `ObjC.import('CoreGraphics');
const post = (type, x, y, button, clicks) => {
  const e = $.CGEventCreateMouseEvent(null, type, {x, y}, button);
  if (clicks) $.CGEventSetIntegerValueField(e, $.kCGMouseEventClickState, clicks);
  $.CGEventPost($.kCGHIDEventTap, e);
};
const ev = ${jxaLiteral(events)};
const B = {left: $.kCGMouseButtonLeft, right: $.kCGMouseButtonRight, center: $.kCGMouseButtonCenter};
const T = {
  left: {down: $.kCGEventLeftMouseDown, up: $.kCGEventLeftMouseUp, drag: $.kCGEventLeftMouseDragged},
  right: {down: $.kCGEventRightMouseDown, up: $.kCGEventRightMouseUp, drag: $.kCGEventRightMouseDragged},
  center: {down: $.kCGEventOtherMouseDown, up: $.kCGEventOtherMouseUp, drag: $.kCGEventOtherMouseDragged}
};
for (const e of ev) {
  const type = e.kind === 'move' ? $.kCGEventMouseMoved : T[e.button || 'left'][e.kind];
  post(type, e.x, e.y, B[e.button || 'left'], e.clicks);
  delay(0.03);
}`;
}

function jxaScrollScript(x, y, dx, dy) {
  return `ObjC.import('CoreGraphics');
const m = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, {x: ${x}, y: ${y}}, $.kCGMouseButtonLeft);
$.CGEventPost($.kCGHIDEventTap, m);
delay(0.05);
const e = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitPixel, 2, ${-Math.round(dy)}, ${-Math.round(dx)});
$.CGEventPost($.kCGHIDEventTap, e);`;
}

function systemEvents(lines) {
  return { tool: 'osascript', args: ['-e', `tell application "System Events"\n${lines.join('\n')}\nend tell`] };
}

export function macKeypress(keys) {
  const mods = keys.filter(isModifier);
  const mains = keys.filter(k => !isModifier(k));
  const using = mods.length ? ` using {${mods.map(m => MAC_MODIFIER_WORDS[m] + ' down').join(', ')}}` : '';
  if (!mains.length) throw new Error('keypress needs a non-modifier key');
  return mains.map(key => {
    if (MAC_KEY_CODES[key] !== undefined) return systemEvents([`key code ${MAC_KEY_CODES[key]}${using}`]);
    if (key.length === 1) return systemEvents([`keystroke ${asString(key.toLowerCase())}${using}`]);
    throw new Error(`unsupported key: ${key}`);
  });
}

// `scale` = screenshot px per screen point (Retina downscale handled by the backend).
export function toMacCommands(action, { scale = 1, cliclick = true } = {}) {
  const p = v => Math.round(v / scale);
  const holdDown = action.keys?.filter(isModifier).map(k => CLICLICK_MODS[k]).filter(Boolean) ?? [];
  const wrap = cmds => holdDown.length && cliclick ? [`kd:${holdDown.join(',')}`, ...cmds, `ku:${holdDown.join(',')}`] : cmds;
  switch (action.type) {
    case 'screenshot': return [];
    case 'wait': return [{ sleep: action.ms ?? 1500 }];
    case 'move':
      return cliclick ? [{ tool: 'cliclick', args: wrap([`m:${p(action.x)},${p(action.y)}`]) }]
        : [{ tool: 'jxa', script: jxaMouseScript([{ kind: 'move', x: p(action.x), y: p(action.y) }]) }];
    case 'click':
    case 'double_click': {
      const x = p(action.x); const y = p(action.y);
      if (cliclick && action.button !== 'wheel') {
        const verb = action.type === 'double_click' ? 'dc' : action.button === 'right' ? 'rc' : 'c';
        return [{ tool: 'cliclick', args: wrap([`m:${x},${y}`, `${verb}:${x},${y}`]) }];
      }
      const button = action.button === 'right' ? 'right' : action.button === 'wheel' ? 'center' : 'left';
      const clicks = action.type === 'double_click' ? 2 : 1;
      const events = [{ kind: 'move', x, y }];
      for (let i = 1; i <= clicks; i++) events.push({ kind: 'down', button, x, y, clicks: i }, { kind: 'up', button, x, y, clicks: i });
      return [{ tool: 'jxa', script: jxaMouseScript(events) }];
    }
    case 'drag': {
      const pts = action.path.map(pt => ({ x: p(pt.x), y: p(pt.y) }));
      if (cliclick) {
        const [a, ...rest] = pts;
        const last = rest.pop() ?? a;
        return [{ tool: 'cliclick', args: wrap([`dd:${a.x},${a.y}`, ...rest.map(r => `dm:${r.x},${r.y}`), `du:${last.x},${last.y}`]) }];
      }
      const [a, ...rest] = pts;
      const events = [{ kind: 'move', ...a }, { kind: 'down', button: 'left', ...a, clicks: 1 }, ...rest.map(r => ({ kind: 'drag', button: 'left', ...r })), { kind: 'up', button: 'left', ...pts.at(-1), clicks: 1 }];
      return [{ tool: 'jxa', script: jxaMouseScript(events) }];
    }
    case 'scroll':
      // cliclick has no wheel support; CGEvent scroll wheel via JXA (positive scroll_y = scroll down)
      return [{ tool: 'jxa', script: jxaScrollScript(p(action.x), p(action.y), action.scroll_x / scale, action.scroll_y / scale) }];
    case 'keypress': return macKeypress(action.keys);
    case 'type': {
      const out = [];
      action.text.split('\n').forEach((line, i) => {
        if (i > 0) out.push(systemEvents([`key code ${MAC_KEY_CODES.Enter}`]));
        if (line) out.push(systemEvents([`keystroke ${asString(line)}`]));
      });
      return out;
    }
  }
  throw new Error(`cannot translate ${action.type}`);
}

// ---- risky UI targets (shared label guard) ----

export const RISKY_LABEL = /\b(pay now|place (your )?order|complete (the )?purchase|confirm (the )?purchase|buy now|delete (my |your )?account|permanently delete|close (my |your )?account)\b/i;
export const isRiskyLabel = label => RISKY_LABEL.test(label || '');
