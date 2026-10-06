const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const blockedLabel = /\b(delete|remove account|purchase|buy now|place order|pay|send|publish|post|invite|upload)\b/i;
const modifierKeys = {
  ALT: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, bit: 1 },
  CTRL: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, bit: 2 },
  META: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, bit: 4 },
  SHIFT: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, bit: 8 }
};
const aliases = { CONTROL: 'CTRL', CMD: 'META', COMMAND: 'META', OPTION: 'ALT', ESC: 'ESCAPE', RETURN: 'ENTER', ' ': 'SPACE', SPACEBAR: 'SPACE', UP: 'ARROWUP', DOWN: 'ARROWDOWN', LEFT: 'ARROWLEFT', RIGHT: 'ARROWRIGHT', DEL: 'DELETE' };
const namedKeys = {
  ENTER: ['Enter', 'Enter', 13, '\r'], TAB: ['Tab', 'Tab', 9], ESCAPE: ['Escape', 'Escape', 27],
  BACKSPACE: ['Backspace', 'Backspace', 8], SPACE: [' ', 'Space', 32, ' '], DELETE: ['Delete', 'Delete', 46],
  INSERT: ['Insert', 'Insert', 45], HOME: ['Home', 'Home', 36], END: ['End', 'End', 35],
  PAGEUP: ['PageUp', 'PageUp', 33], PAGEDOWN: ['PageDown', 'PageDown', 34],
  ARROWLEFT: ['ArrowLeft', 'ArrowLeft', 37], ARROWUP: ['ArrowUp', 'ArrowUp', 38],
  ARROWRIGHT: ['ArrowRight', 'ArrowRight', 39], ARROWDOWN: ['ArrowDown', 'ArrowDown', 40]
};

function normalizeKey(value) {
  if (typeof value !== 'string' || !value.length) throw new Error('Invalid key');
  const key = value.toUpperCase();
  return aliases[key] || key;
}

function modifiers(keys = []) {
  if (!Array.isArray(keys)) throw new Error('Modifiers must be an array');
  const names = [...new Set(keys.map(normalizeKey))];
  if (names.some(key => !modifierKeys[key])) throw new Error(`Unsupported mouse modifier: ${keys.join(', ')}`);
  return names.reduce((mask, key) => mask | modifierKeys[key].bit, 0);
}

function mouseModifiers(action) {
  if (action.keys !== undefined && action.modifiers !== undefined) throw new Error('Use either keys or modifiers, not both');
  return modifiers(action.keys ?? action.modifiers);
}

function coordinates(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > 3000 || point.y > 3000) {
    throw new Error('Invalid screen coordinates');
  }
}

async function guardClick(cdp, point, origin) {
  coordinates(point);
  const target = await cdp.eval(`(() => {
    const el = document.elementFromPoint(${point.x}, ${point.y});
    const anchor = el?.closest('a[href]');
    const button = el?.closest('button,[role="button"],input[type="submit"]');
    const control = button || anchor;
    return {href: anchor?.href || null, label: (control?.innerText || control?.getAttribute('aria-label') || control?.value || '').trim()};
  })()`);
  if (target?.href && new URL(target.href).origin !== origin) throw new Error(`External link blocked: ${target.href}`);
  if (blockedLabel.test(target?.label || '')) throw new Error(`Consequential action blocked: ${target.label}`);
}

function keyParams(key, mask) {
  let entry = namedKeys[key];
  if (/^[A-Z]$/.test(key)) {
    const text = mask & 8 ? key : key.toLowerCase();
    entry = [text, `Key${key}`, key.charCodeAt(0), text];
  } else if (/^[0-9]$/.test(key)) {
    const text = mask & 8 ? ')!@#$%^&*('[Number(key)] : key;
    entry = [text, `Digit${key}`, key.charCodeAt(0), text];
  } else if (/^F([1-9]|1[0-2])$/.test(key)) {
    entry = [key, key, 111 + Number(key.slice(1))];
  }
  if (!entry) throw new Error(`Unsupported key: ${key}`);
  const [name, code, windowsVirtualKeyCode, text] = entry;
  return { key: name, code, windowsVirtualKeyCode, ...(text && !(mask & 7) ? { text } : {}) };
}

async function dispatchKey(cdp, keys) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 5) throw new Error('A keypress requires one key with optional modifiers');
  const names = keys.map(normalizeKey);
  const chord = [...new Set(names.filter(key => modifierKeys[key]))];
  const normal = names.filter(key => !modifierKeys[key]);
  if (normal.length !== 1) throw new Error('A keypress requires exactly one non-modifier key');
  const mask = modifiers(chord);
  const params = keyParams(normal[0], mask);
  const pressed = [];
  let activeMask = 0;
  try {
    for (const name of chord) {
      const { bit, ...modifier } = modifierKeys[name];
      activeMask |= bit;
      pressed.push(name);
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...modifier, modifiers: activeMask });
    }
    try {
      await cdp.send('Input.dispatchKeyEvent', {
        type: params.text ? 'keyDown' : 'rawKeyDown', ...params, modifiers: mask,
        // CDP editor commands make select-all work on either desktop platform.
        ...(normal[0] === 'A' && (mask === 2 || mask === 4) ? { commands: ['selectAll'] } : {})
      });
    } finally {
      const { text, ...released } = params;
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...released, modifiers: mask });
    }
  } finally {
    for (const name of pressed.reverse()) {
      const { bit, ...modifier } = modifierKeys[name];
      activeMask &= ~bit;
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...modifier, modifiers: activeMask });
    }
  }
}

export async function executeComputerAction(cdp, action, origin) {
  if (!action || typeof action !== 'object') throw new Error('Invalid computer action');
  switch (action.type) {
    case 'screenshot': return;
    case 'wait': await sleep(500); return;
    case 'move':
      coordinates(action);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: action.x, y: action.y, modifiers: mouseModifiers(action) }); return;
    case 'scroll': {
      coordinates(action);
      const deltaX = action.scroll_x ?? 0;
      const deltaY = action.scroll_y ?? 0;
      if (![deltaX, deltaY].every(value => Number.isFinite(value) && Math.abs(value) <= 10000)) throw new Error('Scroll deltas must be finite numbers between -10000 and 10000');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: action.x, y: action.y, deltaX, deltaY, modifiers: mouseModifiers(action) }); return;
    }
    case 'click':
    case 'double_click': {
      const mask = mouseModifiers(action);
      const button = action.button ?? 'left';
      if (!['left', 'right', 'middle'].includes(button)) throw new Error(`Unsupported button: ${button}`);
      await guardClick(cdp, action, origin);
      const params = { x: action.x, y: action.y, button, modifiers: mask };
      for (let count = 1; count <= (action.type === 'double_click' ? 2 : 1); count++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...params, clickCount: count });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...params, clickCount: count });
      }
      return;
    }
    case 'drag': {
      const mask = mouseModifiers(action);
      if (action.button !== undefined && action.button !== 'left') throw new Error('Drag supports only the left mouse button');
      if (!Array.isArray(action.path) || action.path.length < 2 || action.path.length > 200) throw new Error('Drag requires 2–200 path points');
      action.path.forEach(coordinates);
      const start = action.path[0];
      await guardClick(cdp, start, origin);
      await guardClick(cdp, action.path.at(-1), origin);
      let position = start;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, modifiers: mask });
      try {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1, modifiers: mask });
        for (const point of action.path.slice(1)) {
          position = point;
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'left', buttons: 1, modifiers: mask });
        }
      } finally {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: position.x, y: position.y, button: 'left', clickCount: 1, modifiers: mask });
      }
      return;
    }
    case 'type':
      if (typeof action.text !== 'string' || action.text.length > 1000) throw new Error('Invalid typed text');
      await cdp.send('Input.insertText', { text: action.text }); return;
    case 'keypress': await dispatchKey(cdp, action.keys); return;
    default: throw new Error(`Unsupported computer action: ${action.type}`);
  }
}
