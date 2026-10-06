import test from 'node:test';
import assert from 'node:assert/strict';
import { AstraSession, parseTurn, DEFAULT_MODEL } from '../src/model-astra.mjs';
import { EXPLORE_FUNCTION_TOOLS } from '../src/prompt.mjs';

const resp = (output, id = 'resp_1') => ({ id, status: 'completed', output, usage: { input_tokens: 100, output_tokens: 20 } });

test('default model id comes from the docs', () => {
  assert.equal(DEFAULT_MODEL, 'gpt-6-astra');
});

test('parseTurn reads computer_call actions, function calls and commentary', () => {
  const turn = parseTurn(resp([
    { type: 'reasoning', id: 'rs_1', summary: [] },
    { type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'Trying the CTA.' }] },
    { type: 'computer_call', call_id: 'call_1', status: 'completed', actions: [{ type: 'click', button: 'left', x: 405, y: 157 }, { type: 'type', text: 'penguin' }] },
    { type: 'function_call', call_id: 'fc_1', name: 'record_finding', arguments: '{"title":"x"}' }
  ]));
  assert.equal(turn.responseId, 'resp_1');
  assert.deepEqual(turn.thoughts, ['Trying the CTA.']);
  assert.equal(turn.computerCalls.length, 1);
  assert.deepEqual(turn.computerCalls[0].actions.map(a => a.type), ['click', 'type']);
  assert.deepEqual(turn.functionCalls, [{ callId: 'fc_1', name: 'record_finding', args: { title: 'x' } }]);
  assert.equal(turn.finalText, '');
});

test('parseTurn: a final message with no calls is the final text; bad JSON args do not throw', () => {
  const done = parseTurn(resp([{ type: 'message', content: [{ type: 'output_text', text: 'All done.' }] }]));
  assert.equal(done.finalText, 'All done.');
  assert.equal(done.computerCalls.length + done.functionCalls.length, 0);
  const bad = parseTurn(resp([{ type: 'function_call', call_id: 'f', name: 'finish', arguments: '{oops' }]));
  assert.equal(bad.functionCalls[0].args._parseError, true);
});

test('parseTurn in function mode turns computer_actions into a computer call', () => {
  const turn = parseTurn(resp([{ type: 'function_call', call_id: 'c1', name: 'computer_actions', arguments: JSON.stringify({ actions: [{ type: 'wait' }] }) }]), { functionComputer: true });
  assert.equal(turn.computerCalls.length, 1);
  assert.equal(turn.computerCalls[0].viaFunction, true);
  assert.equal(turn.functionCalls.length, 0);
});

test('request payload: computer tool, function tools, instructions each time, previous_response_id after the first turn', async () => {
  const payloads = [];
  const request = async p => { payloads.push(p); return resp([{ type: 'computer_call', call_id: `call_${payloads.length}`, actions: [{ type: 'screenshot' }] }], `resp_${payloads.length}`); };
  const session = new AstraSession({ instructions: 'SYSTEM', functionTools: EXPLORE_FUNCTION_TOOLS, effort: 'medium', request });
  await session.send({ text: 'go', screenshotDataUrl: 'data:image/jpeg;base64,AAA' });
  const first = payloads[0];
  assert.equal(first.model, 'gpt-6-astra');
  assert.equal(first.instructions, 'SYSTEM');
  assert.deepEqual(first.reasoning, { effort: 'medium' });
  assert.deepEqual(first.tools[0], { type: 'computer' });
  assert.ok(first.tools.some(t => t.type === 'function' && t.name === 'record_finding'));
  assert.equal(first.previous_response_id, undefined);
  assert.deepEqual(first.input[0].content[1], { type: 'input_image', image_url: 'data:image/jpeg;base64,AAA', detail: 'original' });

  await session.send({ computerOutputs: [{ callId: 'call_1', imageDataUrl: 'data:image/jpeg;base64,BBB' }], functionOutputs: [{ callId: 'fc_9', output: { ok: true } }], userTexts: ['HUMAN STEER: skip onboarding'] });
  const second = payloads[1];
  assert.equal(second.previous_response_id, 'resp_1');
  assert.equal(second.instructions, 'SYSTEM', 'instructions are not carried by previous_response_id, so they are resent');
  assert.deepEqual(second.input[0], { type: 'computer_call_output', call_id: 'call_1', output: { type: 'computer_screenshot', image_url: 'data:image/jpeg;base64,BBB', detail: 'original' } });
  assert.deepEqual(second.input[1], { type: 'function_call_output', call_id: 'fc_9', output: '{"ok":true}' });
  assert.deepEqual(second.input[2], { role: 'user', content: [{ type: 'input_text', text: 'HUMAN STEER: skip onboarding' }] });
  assert.equal(session.usage.requests, 2);
  assert.equal(session.usage.input, 200);
});

test('harness notes on a computer output are passed to the model as user text', async () => {
  const payloads = [];
  const session = new AstraSession({ instructions: 's', request: async p => { payloads.push(p); return resp([]); } });
  await session.send({ text: 'x' });
  await session.send({ computerOutputs: [{ callId: 'c', imageDataUrl: 'data:image/jpeg;base64,Z', note: 'Navigation was blocked.' }] });
  assert.equal(payloads[1].input.at(-1).content[0].text, 'Navigation was blocked.');
});

test('safety checks are acknowledged only when present', async () => {
  const session = new AstraSession({ instructions: 's', request: async () => resp([]) });
  const input = session.buildInput({ computerOutputs: [{ callId: 'c', imageDataUrl: 'data:x', acknowledgedSafetyChecks: [{ id: 'sc_1', code: 'malicious_instructions' }] }] });
  assert.deepEqual(input[0].acknowledged_safety_checks, [{ id: 'sc_1', code: 'malicious_instructions' }]);
});

test('retries rate limits and server errors with backoff, but not client errors', async () => {
  let calls = 0;
  const waits = [];
  const session = new AstraSession({
    instructions: 's', sleep: async ms => { waits.push(ms); },
    request: async () => { calls++; if (calls < 3) throw new Error('OpenAI API 429: slow down'); return resp([]); }
  });
  await session.send({ text: 'x' });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 4000]);

  let bad = 0;
  const strict = new AstraSession({ instructions: 's', sleep: async () => {}, request: async () => { bad++; throw new Error('OpenAI API 401: bad key'); } });
  await assert.rejects(() => strict.send({ text: 'x' }), /401/);
  assert.equal(bad, 1);
});

test('falls back to the computer_actions function tool when the computer tool is rejected for the model', async () => {
  const seen = [];
  const request = async p => {
    seen.push(p);
    if (p.tools.some(t => t.type === 'computer')) throw new Error("OpenAI API 400: Tool 'computer' is not supported with this model");
    return resp([{ type: 'function_call', call_id: 'c1', name: 'computer_actions', arguments: '{"actions":[{"type":"screenshot"}]}' }], 'resp_f');
  };
  const session = new AstraSession({ instructions: 's', request, log: () => {} });
  const turn = await session.send({ text: 'x' });
  assert.equal(session.mode, 'function');
  assert.equal(turn.computerCalls.length, 1);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].tools[0].name, 'computer_actions');
  const input = session.buildInput({ computerOutputs: [{ callId: 'c1', imageDataUrl: 'data:image/jpeg;base64,Q', viaFunction: true }] });
  assert.equal(input[0].type, 'function_call_output');
  assert.equal(input[0].output[0].type, 'input_image');
});
