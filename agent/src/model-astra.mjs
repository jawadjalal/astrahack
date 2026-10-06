// GPT-6 Astra through the OpenAI Responses API (https://developers.openai.com/api/docs/guides/tools-computer-use).
//
// API shape used here (from the docs, not from memory):
//   POST /v1/responses  { model, instructions, tools:[{type:"computer"}, ...function tools], input, previous_response_id, reasoning:{effort} }
//   output item  { type:"computer_call", call_id, actions:[{type:"click",button,x,y}, {type:"type",text}, ...], status }
//   reply item   { type:"computer_call_output", call_id, output:{ type:"computer_screenshot", image_url:"data:image/..;base64,..", detail:"original" } }
//   model id     gpt-6-astra (reasoning.effort: low|medium|high|xhigh|max). Docs recommend code execution for Astra and keep the
//                `computer` tool "supported as an alternative" (their examples use gpt-6.1-sol), so if the API rejects the computer
//                tool for the chosen model we transparently fall back to an equivalent function tool (`computer_actions`).
// `instructions` are NOT carried over by previous_response_id, so they are sent on every request.

import { createResponse } from '../../src/openai.js';
import { COMPUTER_FUNCTION_TOOL } from './prompt.mjs';

const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));
const RETRYABLE = /OpenAI API (408|409|429|500|502|503|504)|fetch failed|timed out|aborted|ECONNRESET|socket/i;

export const DEFAULT_MODEL = 'gpt-6-astra';

export function textOf(item) {
  return (item.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n').trim();
}

// Normalize a Responses API response into what the loop consumes.
export function parseTurn(response, { functionComputer = false } = {}) {
  const turn = { responseId: response.id, thoughts: [], computerCalls: [], functionCalls: [], finalText: '', usage: response.usage || null, raw: response };
  const messages = [];
  for (const item of response.output || []) {
    if (item.type === 'message') {
      const text = textOf(item);
      if (text) messages.push({ text, phase: item.phase });
    } else if (item.type === 'computer_call') {
      const actions = Array.isArray(item.actions) ? item.actions : item.action ? [item.action] : [];
      turn.computerCalls.push({ callId: item.call_id, actions, pendingSafetyChecks: item.pending_safety_checks || [], viaFunction: false });
    } else if (item.type === 'function_call') {
      let args = {};
      try { args = JSON.parse(item.arguments || '{}'); } catch { args = { _parseError: true, _raw: String(item.arguments).slice(0, 200) }; }
      if (functionComputer && item.name === COMPUTER_FUNCTION_TOOL.name) {
        turn.computerCalls.push({ callId: item.call_id, actions: Array.isArray(args.actions) ? args.actions : [], pendingSafetyChecks: [], viaFunction: true });
      } else {
        turn.functionCalls.push({ callId: item.call_id, name: item.name, args });
      }
    }
  }
  const hasCalls = turn.computerCalls.length || turn.functionCalls.length;
  turn.thoughts = messages.filter(m => m.phase === 'commentary' || hasCalls).map(m => m.text);
  turn.finalText = hasCalls ? '' : messages.filter(m => m.phase !== 'commentary').map(m => m.text).join('\n');
  return turn;
}

export class AstraSession {
  constructor({ model = DEFAULT_MODEL, instructions, functionTools = [], mode = 'computer', effort = 'low', request, sleep = sleepMs, maxRetries = 4, log = () => {} }) {
    this.model = model;
    this.instructions = instructions;
    this.functionTools = functionTools;
    this.mode = mode; // 'computer' | 'function'
    this.effort = effort;
    this.request = request || (payload => createResponse(payload));
    this.sleep = sleep;
    this.maxRetries = maxRetries;
    this.log = log;
    this.previousResponseId = null;
    this.usage = { input: 0, output: 0, requests: 0 };
  }

  tools() {
    return [...(this.mode === 'computer' ? [{ type: 'computer' }] : [COMPUTER_FUNCTION_TOOL]), ...this.functionTools];
  }

  // Build the `input` array for the next request.
  buildInput({ text, screenshotDataUrl, computerOutputs = [], functionOutputs = [], userTexts = [] }) {
    const input = [];
    if (text || screenshotDataUrl) {
      const content = [];
      if (text) content.push({ type: 'input_text', text });
      if (screenshotDataUrl) content.push({ type: 'input_image', image_url: screenshotDataUrl, detail: 'original' });
      input.push({ role: 'user', content });
    }
    for (const out of computerOutputs) {
      if (out.viaFunction || this.mode === 'function') {
        input.push({
          type: 'function_call_output', call_id: out.callId,
          output: [
            ...(out.note ? [{ type: 'input_text', text: out.note }] : []),
            { type: 'input_image', image_url: out.imageDataUrl, detail: 'original' }
          ]
        });
      } else {
        input.push({
          type: 'computer_call_output', call_id: out.callId,
          output: { type: 'computer_screenshot', image_url: out.imageDataUrl, detail: 'original' },
          ...(out.acknowledgedSafetyChecks?.length ? { acknowledged_safety_checks: out.acknowledgedSafetyChecks } : {})
        });
        if (out.note) userTexts = [...userTexts, out.note];
      }
    }
    for (const out of functionOutputs) input.push({ type: 'function_call_output', call_id: out.callId, output: typeof out.output === 'string' ? out.output : JSON.stringify(out.output) });
    if (userTexts.length) input.push({ role: 'user', content: userTexts.map(t => ({ type: 'input_text', text: t })) });
    return input;
  }

  async post(payload) {
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.request(payload);
      } catch (error) {
        lastError = error;
        if (!RETRYABLE.test(error.message) || attempt === this.maxRetries) break;
        const wait = 2000 * 2 ** attempt;
        this.log(`model request failed (${error.message}); retry ${attempt + 1}/${this.maxRetries} in ${wait}ms`);
        await this.sleep(wait);
      }
    }
    throw lastError;
  }

  async send(feedback) {
    const input = this.buildInput(feedback);
    const make = () => ({
      model: this.model,
      instructions: this.instructions,
      tools: this.tools(),
      input,
      reasoning: { effort: this.effort },
      ...(this.previousResponseId ? { previous_response_id: this.previousResponseId } : {})
    });
    let response;
    try {
      response = await this.post(make());
    } catch (error) {
      // Computer tool not accepted for this model on the very first request: use the function-tool equivalent.
      const toolRejected = this.mode === 'computer' && !this.previousResponseId && /400/.test(error.message) && /computer|tool/i.test(error.message);
      if (!toolRejected) throw error;
      this.log(`computer tool rejected for ${this.model} (${error.message}); falling back to the computer_actions function tool`);
      this.mode = 'function';
      response = await this.post(make());
    }
    this.previousResponseId = response.id;
    this.usage.requests++;
    this.usage.input += response.usage?.input_tokens || 0;
    this.usage.output += response.usage?.output_tokens || 0;
    return parseTurn(response, { functionComputer: this.mode === 'function' });
  }
}

export function createAstraSession(options) {
  return new AstraSession(options);
}
