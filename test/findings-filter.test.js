import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CATEGORIES, FUNCTIONAL_DEFINITION, assessFinding, categoryOf, filterFindings, findingRulesPrompt,
  hasEvidence, isFunctionalFinding, missingRequirements, normalizeCategory, reproductionOf
} from '../src/findings-filter.js';

const finding = (over = {}) => ({
  summary: 'Sign up button does nothing', severity: 'high', category: 'functional',
  expected: 'Tapping Create account creates the account', actual: 'No spinner, no error, same screen',
  reproduction: ['Open the sign up screen', 'Fill a valid email and password', 'Tap Create account'], evidenceRefs: ['Q002'], ...over
});

test('the canvas copy of the filter is identical to src/findings-filter.js', async () => {
  const [a, b] = await Promise.all([
    readFile(new URL('../src/findings-filter.js', import.meta.url), 'utf8'),
    readFile(new URL('../canvas/src/lib/findings-filter.mjs', import.meta.url), 'utf8')
  ]);
  assert.equal(b, a, 'run: cp src/findings-filter.js canvas/src/lib/findings-filter.mjs');
});

test('categories are functional, usability and visual; aliases normalize', () => {
  assert.deepEqual(CATEGORIES, ['functional', 'usability', 'visual']);
  assert.equal(normalizeCategory('Functional'), 'functional');
  assert.equal(normalizeCategory('UX'), 'usability');
  assert.equal(normalizeCategory('cosmetic'), 'visual');
  assert.equal(normalizeCategory('banana'), null);
  assert.equal(normalizeCategory(undefined), null);
});

test('real broken behavior passes', () => {
  const samples = [
    ['Sign up button does nothing', 'Account is created', 'Nothing happens after the tap'],
    ['Reminder count not updated after completing a task', 'Banner reads 2', 'Banner still reads 3'],
    ['Paywall close button unresponsive', 'The paywall closes', 'The paywall stays open'],
    ['Checkout returns HTTP 500', 'Order page loads', 'HTTP 500 after Place order'],
    ['Signup accepts an invalid email', 'Validation message', 'Account created with not-an-email'],
    ['Footer Settings link leads to a 404', 'Settings opens', 'A 404 page'],
    ['Wrong total after removing an item', '$10.00', '$20.00'],
    ['Back button loses the form state', 'Fields keep their values', 'Fields are empty after going back']
  ];
  for (const [summary, expected, actual] of samples) {
    assert.equal(isFunctionalFinding(finding({ summary, expected, actual, category: undefined })), true, summary);
    assert.equal(isFunctionalFinding(finding({ summary, expected, actual })), true, summary);
  }
});

test('design opinions are dropped by heuristics even when labeled functional', () => {
  const samples = [
    ['Button color is off-brand', 'Brand blue', 'Looks green'],
    ['Font is too small on mobile', 'Readable text', 'Tiny text'],
    ['Possibly unclear pricing CTA', 'A clear action', 'Ambiguous wording'],
    ['Consider moving the CTA higher', 'CTA above the fold', 'CTA below the fold'],
    ['Spacing between cards is inconsistent', 'Even gaps', 'Uneven padding'],
    ['Close icon has low contrast', 'Visible icon', 'Icon at 28% opacity'],
    ['The page could be more modern', 'A modern look', 'Feels dated'],
    ['Landing headline might have a typo', 'Flawless copy', 'I thought instantly looked odd'],
    ['Users would prefer a darker theme', 'Dark theme', 'Light theme only']
  ];
  for (const [summary, expected, actual] of samples) {
    const verdict = assessFinding(finding({ summary, expected, actual }));
    assert.equal(verdict.keep, false, summary);
    assert.notEqual(verdict.category, 'functional', summary);
    assert.match(verdict.reasons[0], /design or taste opinion/, summary);
  }
});

test('a broken behavior that mentions a design word stays functional', () => {
  const v = assessFinding(finding({ summary: 'Submit button does nothing and its color never changes', actual: 'No effect on tap' }));
  assert.equal(v.keep, true);
  assert.equal(v.category, 'functional');
  // weak signals do not rescue styling complaints
  assert.equal(assessFinding(finding({ summary: 'Padding is inconsistent', actual: 'Uneven padding' })).keep, false);
  assert.equal(assessFinding(finding({ summary: 'Wrong color on the badge', actual: 'Green not blue' })).keep, false);
});

test('an explicit usability or visual category is dropped by default and never overruled to functional', () => {
  for (const category of ['usability', 'visual']) {
    const v = assessFinding(finding({ category, summary: 'Checkout does nothing', actual: 'Nothing happens' }));
    assert.equal(v.keep, false);
    assert.equal(v.category, category);
    assert.match(v.reasons[0], /design observation/);
  }
});

test('includeDesign keeps design findings, forces severity info and leaves functional ones untouched', () => {
  const design = finding({ category: 'visual', severity: 'high', summary: 'Heading font looks dated' });
  const { kept, dropped } = filterFindings([finding(), design], { includeDesign: true });
  assert.equal(dropped.length, 0);
  assert.deepEqual(kept.map(f => [f.category, f.severity]), [['functional', 'high'], ['visual', 'info']]);
  assert.equal(filterFindings([design]).kept.length, 0);
});

test('inferred categories: wording and layout talk is visual or usability', () => {
  assert.equal(categoryOf({ summary: 'Headline wording is vague', expected: 'clear', actual: 'vague' }), 'usability');
  assert.equal(categoryOf({ summary: 'Hero color palette is dull', expected: 'x', actual: 'y' }), 'visual');
  assert.equal(categoryOf({ summary: 'Save does nothing', expected: 'x', actual: 'y' }), 'functional');
});

test('findings without steps, evidence, or expected and actual are rejected', () => {
  assert.deepEqual(missingRequirements(finding()), []);
  assert.match(assessFinding(finding({ reproduction: [] })).reasons.join(), /reproduction steps/);
  assert.match(assessFinding(finding({ reproduction: ['  '] })).reasons.join(), /reproduction steps/);
  assert.match(assessFinding(finding({ expected: '' })).reasons.join(), /expected and actual/);
  assert.match(assessFinding(finding({ actual: undefined })).reasons.join(), /expected and actual/);
  assert.match(assessFinding(finding({ evidenceRefs: [] })).reasons.join(), /evidence/);
  assert.match(assessFinding(finding({ evidenceRefs: [], evidenceStep: -1 })).reasons.join(), /evidence/);
  assert.equal(assessFinding(finding({ evidenceRefs: [], evidenceStep: 3 })).keep, true);
  assert.equal(assessFinding(finding({ evidenceRefs: [], evidence: 'screenshots/003.png' })).keep, true);
  assert.equal(assessFinding({}).keep, false);
  assert.equal(assessFinding(null).keep, false);
});

test('the step list is read from every producer shape', () => {
  assert.equal(reproductionOf({ reproduction: ['a'] }).length, 1);
  assert.equal(reproductionOf({ repro: ['a'] }).length, 1);
  assert.equal(reproductionOf({ repro_steps: ['a'] }).length, 1);
  assert.equal(reproductionOf({ stepsToReproduce: [{ action: 'goto', url: '/' }] }).length, 1);
  assert.equal(reproductionOf({ steps: [] }).length, 0);
  assert.equal(hasEvidence({ screenshot: 'a.jpg' }), true);
  assert.equal(hasEvidence({ evidenceStep: 0 }), true);
  assert.equal(hasEvidence({}), false);
});

test('filterFindings keeps order, reports reasons, and tolerates non-arrays', () => {
  const list = [finding({ summary: 'A does nothing' }), finding({ summary: 'Prefer a bigger logo', actual: 'Looks small' }), finding({ summary: 'B fails', reproduction: [] })];
  const { kept, dropped } = filterFindings(list);
  assert.deepEqual(kept.map(f => f.summary), ['A does nothing']);
  assert.equal(dropped.length, 2);
  assert.match(dropped[1].reasons[0], /missing reproduction steps/);
  assert.deepEqual(filterFindings(undefined), { kept: [], dropped: [] });
});

test('every prompt carries the definition; includeDesign changes the rule, not the definition', () => {
  const strict = findingRulesPrompt();
  assert.ok(strict.includes(FUNCTIONAL_DEFINITION));
  assert.match(strict, /Do not report design or usability opinions/);
  assert.match(strict, /category "functional"/);
  assert.match(strict, /EXPECTED versus ACTUAL/);
  const wide = findingRulesPrompt({ includeDesign: true });
  assert.ok(wide.includes(FUNCTIONAL_DEFINITION));
  assert.match(wide, /severity "info"/);
  assert.doesNotMatch(wide, /Do not report design or usability opinions/);
});
