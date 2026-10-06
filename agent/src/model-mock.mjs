// `--mock`: a scripted fake model with the same session interface as the real one, so the whole pipeline
// (loop, canvas streaming, findings, verify, steering, reports) runs with NO API key.
// The default script tears down the built-in PocketPay demo (agent/src/demo-site.mjs). Click targets are
// CSS selectors resolved to screenshot pixels through backend.locate() when the backend has it (cdp).

let callCounter = 0;
const nextId = p => `${p}_mock_${++callCounter}`;

const computer = (actions, thought) => ({ thought, computer: actions });
const tools = (calls, thought) => ({ thought, calls });

export const EXPLORE_SCRIPT = [
  tools([{ name: 'record_cold_open', args: { what_it_is: 'A demo wallet app for sending money instantly', who_for: 'People who want to pay friends quickly', primary_action: 'Get started (create an account)', unclear: 'No pricing, no mention of fees or limits' } }], 'Cold open: reading the landing page like a stranger.'),
  computer([{ type: 'click', selector: '#cta' }], 'Trying the main task: tapping Get started.'),
  computer([{ type: 'click', selector: '#email' }, { type: 'type', text: 'not-an-email' }, { type: 'click', selector: '#password' }, { type: 'type', text: '{{TEST_PASSWORD}}' }, { type: 'click', selector: '#submit' }], 'Breaking it: signing up with an invalid email.'),
  tools([
    { name: 'track_state', args: { label: 'wallet balance', value: '$100.00', context: 'before sending $10' } },
    { name: 'record_finding', args: { title: 'Signup accepts an invalid email address', severity: 'high', expected: 'The form rejects "not-an-email" with a clear validation message', actual: 'Account was created and the wallet opened with "not-an-email" as the user', repro_steps: ['Open the home page', 'Click Get started', 'Type not-an-email in Email', 'Click Create account'], box: { x: 0, y: 0, w: 1, h: 0.12 } } }
  ], 'The wallet opened with a bad email. Recording that, then reading the balance before the transfer.'),
  computer([{ type: 'click', selector: '#send' }], 'Sending $10 to see how state changes.'),
  tools([
    { name: 'track_state', args: { label: 'wallet balance', value: '$90.00', context: 'after sending $10' } },
    { name: 'record_finding', args: { title: 'Sent money does not appear in Recent activity', severity: 'critical', expected: 'A "Sent $10 to Sam" row appears in Recent activity after the transfer', actual: 'Balance dropped to $90.00 but Recent activity still reads "No activity yet"', repro_steps: ['Create an account', 'Click Send $10 to Sam', 'Read Recent activity'], box: { x: 0.2, y: 0.55, w: 0.6, h: 0.3 } } }
  ], 'Balance changed but the activity list is empty. That is a trust problem.'),
  computer([{ type: 'click', selector: '#send' }, { type: 'click', selector: '#send' }], 'Pushing the limit: sending twice more.'),
  computer([{ type: 'scroll', x: 640, y: 500, scroll_x: 0, scroll_y: 600 }], 'Scrolling to look for settings and help.'),
  computer([{ type: 'click', selector: 'footer a' }], 'Following the footer Settings link.'),
  tools([
    { name: 'record_finding', args: { title: 'Footer Settings link leads to a 404', severity: 'medium', expected: 'Settings page opens', actual: 'A 404 "This page could not be found" screen is shown', repro_steps: ['Open any page', 'Click Settings in the footer'] } },
    { name: 'record_finding', args: { title: 'Landing headline might have a typo', severity: 'low', expected: 'Headline copy is flawless', actual: 'I thought "instantly" looked odd, but could not point to a typo', repro_steps: ['Open the home page', 'Read the headline'] } },
    { name: 'note_coverage', args: { screen: 'Landing page', status: 'visited', detail: 'cold open' } },
    { name: 'note_coverage', args: { screen: 'Signup', status: 'visited', detail: 'tried invalid email' } },
    { name: 'note_coverage', args: { screen: 'Wallet', status: 'visited', detail: 'sent money three times' } },
    { name: 'note_coverage', args: { screen: 'Settings', status: 'unreachable', detail: 'link is a 404' } },
    { name: 'note_coverage', args: { screen: 'Payment methods', status: 'unreachable', detail: 'no entry point found in the UI' } }
  ], 'Recording the dead link, plus coverage.'),
  tools([{ name: 'finish', args: { summary: 'PocketPay lets a new user reach a working wallet in 3 screens, but trust is undermined: signup accepts garbage emails and transfers do not show in activity. Settings is a dead link.', time_to_value: '3 screens, about 4 actions to the first transfer' } }], 'Wrapping up the teardown.')
];

const verifyPlans = [
  { match: /invalid email/i, actions: [[{ type: 'click', selector: '#cta' }], [{ type: 'click', selector: '#email' }, { type: 'type', text: 'not-an-email' }, { type: 'click', selector: '#submit' }]], reproduced: true, seen: 'After submitting "not-an-email" the wallet opened without any validation message.' },
  { match: /recent activity/i, actions: [[{ type: 'click', selector: '#cta' }], [{ type: 'click', selector: '#submit' }], [{ type: 'click', selector: '#send' }]], reproduced: true, seen: 'Balance went to $90.00 and Recent activity still says "No activity yet".' },
  { match: /settings/i, actions: [[{ type: 'click', selector: 'footer a' }]], reproduced: true, seen: 'A 404 page ("This page could not be found") is displayed.' },
  { match: /typo/i, actions: [[{ type: 'screenshot' }]], reproduced: false, seen: 'The headline reads "Send money to anyone, instantly." with no typo.' }
];

export class MockSession {
  constructor({ kind, backend, script, delay = 0, log = () => {} }) {
    this.kind = kind;
    this.delay = delay;
    this.backend = backend;
    this.script = script || EXPLORE_SCRIPT;
    this.i = 0;
    this.usage = { requests: 0, input: 0, output: 0 };
    this.plan = null;
    this.log = log;
  }

  async resolve(actions, shotScale = 1) {
    const out = [];
    for (const a of actions) {
      if (!a.selector) { out.push(a); continue; }
      const p = (await this.backend?.locate?.(a.selector)) ?? { x: 200, y: 200 };
      const { selector, ...rest } = a;
      out.push({ ...rest, x: p.x, y: p.y });
    }
    return out;
  }

  turn({ thought, computer: acts, calls }) {
    return {
      responseId: nextId('resp'), thoughts: thought ? [thought] : [], finalText: '', usage: null,
      computerCalls: acts ? [{ callId: nextId('call'), actions: acts, pendingSafetyChecks: [], viaFunction: false }] : [],
      functionCalls: (calls || []).map(c => ({ callId: nextId('fc'), name: c.name, args: c.args }))
    };
  }

  async send(feedback) {
    this.usage.requests++;
    if (this.delay) await new Promise(resolve => setTimeout(resolve, this.delay)); // simulate model latency
    if (this.kind === 'verify') return this.verifySend(feedback);
    const steer = (feedback.userTexts || []).find(t => t.startsWith('HUMAN STEER:'));
    const step = this.script[Math.min(this.i, this.script.length - 1)];
    this.i++;
    let thought = step.thought;
    if (steer) thought = `Acknowledging the human: ${steer.replace('HUMAN STEER: ', '')}. ${thought}`;
    if (step.computer) return this.turn({ thought, computer: await this.resolve(step.computer) });
    return this.turn({ thought, calls: step.calls });
  }

  async verifySend({ text, computerOutputs, functionOutputs }) {
    if (!this.plan) {
      const title = (text || '').match(/Verify finding (F\d+): (.*)/);
      this.id = title?.[1] || 'F?';
      this.plan = verifyPlans.find(p => p.match.test(title?.[2] || '')) || { actions: [[{ type: 'screenshot' }]], reproduced: false, seen: 'Could not follow the steps.' };
      this.k = 0;
    }
    if (this.k < this.plan.actions.length) {
      const batch = await this.resolve(this.plan.actions[this.k++]);
      return this.turn({ thought: `Replaying step ${this.k}.`, computer: batch });
    }
    return this.turn({ thought: 'Checking the final screen.', calls: [{ name: 'confirm_finding', args: { finding_id: this.id, reproduced: this.plan.reproduced, observation: this.plan.seen } }] });
  }
}

export function createMockSession(kind, { backend, log, delay } = {}) {
  return new MockSession({ kind, backend, log, delay });
}
