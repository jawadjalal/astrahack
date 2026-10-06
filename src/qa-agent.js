import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { attach, launchBrowser } from './cdp.js';
import { navigate, observe, screenshot } from './runner.js';
import { createResponse, outputText } from './openai.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const blockedLabel = /\b(delete|remove account|purchase|buy now|place order|pay|send|publish|post|invite|upload)\b/i;

const assessmentSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    productUnderstanding: { type: 'string' },
    observedFeatures: { type: 'array', items: { type: 'string' } },
    journeysExercised: { type: 'array', items: { type: 'string' } },
    issues: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        summary: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        expected: { type: 'string' }, actual: { type: 'string' },
        reproduction: { type: 'array', items: { type: 'string' } }, evidenceStep: { type: 'integer' }
      },
      required: ['summary', 'severity', 'expected', 'actual', 'reproduction', 'evidenceStep']
    } },
    limitations: { type: 'array', items: { type: 'string' } }
  },
  required: ['productUnderstanding', 'observedFeatures', 'journeysExercised', 'issues', 'limitations']
};

const keyCodes = { ENTER: 13, TAB: 9, ESC: 27, ESCAPE: 27, BACKSPACE: 8, SPACE: 32, ARROWDOWN: 40, ARROWUP: 38, ARROWLEFT: 37, ARROWRIGHT: 39 };

async function dispatchKey(cdp, keys) {
  if (!Array.isArray(keys) || keys.length !== 1) throw new Error('Only single key presses are supported in this QA adapter');
  const key = String(keys[0]).toUpperCase();
  const code = keyCodes[key];
  if (!code) throw new Error(`Unsupported key: ${key}`);
  const params = { key: key === 'ENTER' ? 'Enter' : key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

function coordinates(action) {
  if (!Number.isFinite(action.x) || !Number.isFinite(action.y) || action.x < 0 || action.y < 0 || action.x > 3000 || action.y > 3000) {
    throw new Error('Invalid screen coordinates');
  }
}

async function guardClick(cdp, action, origin) {
  coordinates(action);
  const target = await cdp.eval(`(() => {
    const el = document.elementFromPoint(${action.x}, ${action.y});
    const anchor = el?.closest('a[href]');
    const button = el?.closest('button,[role="button"],input[type="submit"]');
    return {href: anchor?.href || null, label: (button?.innerText || button?.getAttribute('aria-label') || button?.value || '').trim()};
  })()`);
  if (target?.href && new URL(target.href).origin !== origin) throw new Error(`External link blocked: ${target.href}`);
  if (blockedLabel.test(target?.label || '')) throw new Error(`Consequential action blocked: ${target.label}`);
}

export async function executeComputerAction(cdp, action, origin) {
  switch (action.type) {
    case 'screenshot': return;
    case 'wait': await sleep(500); return;
    case 'move':
      coordinates(action);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: action.x, y: action.y }); return;
    case 'scroll':
      coordinates(action);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: action.x, y: action.y, deltaX: action.scroll_x || 0, deltaY: action.scroll_y || 0 }); return;
    case 'click':
    case 'double_click': {
      await guardClick(cdp, action, origin);
      const count = action.type === 'double_click' ? 2 : 1;
      const button = action.button || 'left';
      if (!['left', 'right', 'middle'].includes(button)) throw new Error(`Unsupported button: ${button}`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: action.x, y: action.y, button, clickCount: count });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: action.x, y: action.y, button, clickCount: count });
      return;
    }
    case 'type':
      if (typeof action.text !== 'string' || action.text.length > 1000) throw new Error('Invalid typed text');
      await cdp.send('Input.insertText', { text: action.text }); return;
    case 'keypress': await dispatchKey(cdp, action.keys); return;
    default: throw new Error(`Unsupported computer action: ${action.type}`);
  }
}

export async function runQaAgent({ url, chrome, output, brief = '', model = 'gpt-6-astra', maxTurns = 12, maxActions = 40, headless = true, request = createResponse }) {
  if (!url || !chrome || !output) throw new Error('url, chrome, and output are required');
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 50) throw new Error('maxTurns must be 1–50');
  const origin = new URL(url).origin;
  const out = resolve(output);
  await mkdir(join(out, 'screenshots'), { recursive: true });
  const report = {
    schemaVersion: 1, target: url, model, startedAt: new Date().toISOString(), finishedAt: null,
    status: 'running', brief, steps: [], assessment: null, assets: [], limitations: [
      'QA agent sees one Chromium viewport at a time; native dialogs and other app surfaces are outside this adapter.'
    ]
  };
  const save = () => writeFile(join(out, 'qa-agent.json'), JSON.stringify(report, null, 2) + '\n');
  let browser;
  let cdp;
  try {
    browser = await launchBrowser({ executable: chrome, headless });
    cdp = await attach(browser.port);
    await navigate(cdp, url);
    const initial = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const initialPath = 'screenshots/000-initial.png';
    await writeFile(join(out, initialPath), Buffer.from(initial.data, 'base64'));
    report.assets.push({ type: 'screenshot', path: initialPath, purpose: 'initial QA view' });
    report.initialObservation = await observe(cdp);
    let input = [{ role: 'user', content: [
      { type: 'input_text', text: `Explore this product through its UI and exercise important read-only user journeys. Record observable failures with exact steps and evidence step numbers. Do not submit purchases, publish, delete, invite, send messages, or enter secrets. Stay on ${origin}. Site brief: ${brief || 'No brief provided.'}` },
      { type: 'input_image', image_url: `data:image/png;base64,${initial.data}`, detail: 'original' }
    ] }];
    let previousResponseId;
    let actionsUsed = 0;
    for (let turn = 0; turn < maxTurns; turn++) {
      const response = await request({
        model, reasoning: { effort: 'low' }, tools: [{ type: 'computer' }],
        text: { format: { type: 'json_schema', name: 'qa_assessment', strict: true, schema: assessmentSchema } },
        input, ...(previousResponseId ? { previous_response_id: previousResponseId } : {})
      });
      const calls = (response.output || []).filter(item => item.type === 'computer_call');
      if (!calls.length) {
        const final = outputText(response);
        if (!final) throw new Error('Astra returned no QA assessment');
        report.assessment = JSON.parse(final);
        for (const issue of report.assessment.issues || []) {
          const step = report.steps.find(item => item.index === issue.evidenceStep);
          issue.evidence = step?.screenshot || null;
          if (!step) issue.verification = 'unverified evidence reference';
        }
        report.status = 'completed';
        break;
      }
      input = [];
      for (const call of calls) {
        if (!Array.isArray(call.actions)) throw new Error('Computer call has no actions');
        for (const action of call.actions) {
          if (++actionsUsed > maxActions) throw new Error(`Action limit (${maxActions}) reached`);
          const entry = { index: actionsUsed, type: action.type, action: action.type === 'type' ? { type: 'type', text: '[redacted]' } : action, startedAt: new Date().toISOString() };
          report.steps.push(entry);
          try {
            await executeComputerAction(cdp, action, origin);
            await sleep(200);
            const current = new URL(await cdp.eval('location.href'));
            if (current.origin !== origin) {
              await navigate(cdp, url);
              throw new Error(`Navigation left allowed origin: ${current.href}`);
            }
            entry.status = 'passed';
          } catch (error) { entry.status = 'blocked_or_failed'; entry.error = error.message; }
          entry.finishedAt = new Date().toISOString();
          entry.observation = await observe(cdp);
          const asset = `screenshots/${String(actionsUsed).padStart(3, '0')}-${action.type}.png`;
          await screenshot(cdp, join(out, asset));
          entry.screenshot = asset;
          report.assets.push({ type: 'screenshot', path: asset, step: actionsUsed });
        }
        const latest = await cdp.send('Page.captureScreenshot', { format: 'png' });
        input.push({ type: 'computer_call_output', call_id: call.call_id, output: {
          type: 'computer_screenshot', image_url: `data:image/png;base64,${latest.data}`, detail: 'original'
        } });
      }
      previousResponseId = response.id;
      await save();
    }
    if (report.status === 'running') report.status = 'limit_reached';
  } catch (error) {
    report.status = 'error';
    report.error = error.message;
  } finally {
    report.finishedAt = new Date().toISOString();
    await save();
    cdp?.close();
    await browser?.close();
  }
  return { out, report };
}
