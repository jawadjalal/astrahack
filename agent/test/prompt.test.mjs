import test from 'node:test';
import assert from 'node:assert/strict';
import { FUNCTIONAL_DEFINITION } from '../../src/findings-filter.js';
import { EXPLORE_FUNCTION_TOOLS, TEARDOWN_METHOD, exploreFunctionTools, explorePrompt } from '../src/prompt.mjs';

const args = { target: 'https://x.test', brief: '', maxSteps: 10, identityHint: 'none', backend: 'cdp' };
const recordFinding = tools => tools.find(t => t.name === 'record_finding');

test('the explore prompt states the functional definition and forbids design opinions by default', () => {
  const p = explorePrompt(args);
  assert.ok(p.includes(FUNCTIONAL_DEFINITION));
  assert.match(p, /Do not report design or usability opinions/);
  assert.doesNotMatch(TEARDOWN_METHOD, /low = polish/);
  assert.doesNotMatch(TEARDOWN_METHOD, /error messages that blame the user/);
});

test('--include-design allows labeled design observations at severity info', () => {
  const p = explorePrompt({ ...args, includeDesign: true });
  assert.ok(p.includes(FUNCTIONAL_DEFINITION));
  assert.match(p, /severity "info"/);
  assert.doesNotMatch(p, /Do not report design or usability opinions/);
});

test('record_finding requires a category and repro steps; only functional is offered by default', () => {
  const tool = recordFinding(EXPLORE_FUNCTION_TOOLS);
  assert.deepEqual(tool.parameters.properties.category.enum, ['functional']);
  for (const key of ['category', 'expected', 'actual', 'repro_steps']) assert.ok(tool.parameters.required.includes(key), key);
  assert.equal(exploreFunctionTools(), EXPLORE_FUNCTION_TOOLS);
  assert.deepEqual(recordFinding(exploreFunctionTools({ includeDesign: true })).parameters.properties.category.enum, ['functional', 'usability', 'visual']);
});
