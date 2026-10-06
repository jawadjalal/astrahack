// Hard stop. Any of these ends the run at the next action boundary (not just the next model turn):
//   Ctrl-C (SIGINT/SIGTERM), a STOP file, POST /stop on the agent port, or (macOS backend) holding Esc.
// A second Ctrl-C exits immediately.

import { existsSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';

export class StopError extends Error {
  constructor(reason) { super(`stopped: ${reason}`); this.name = 'StopError'; this.reason = reason; }
}

// Holding Esc ~150ms stops the agent. Reads key state (no Input Monitoring permission needed) in a tiny
// long-lived JXA process. The agent's own synthetic Escape key presses are muted so they cannot trip it.
export const ESC_WATCHER_JXA = `ObjC.import('CoreGraphics');
let held = 0;
while (true) {
  const down = $.CGEventSourceKeyState($.kCGEventSourceStateCombinedSessionState, 53);
  held = down ? held + 1 : 0;
  if (held >= 3) { console.log('ESC'); held = 0; delay(1.5); }
  delay(0.05);
}`;

export class StopController {
  constructor({ files = [], log = () => {}, exit = code => process.exit(code) } = {}) {
    this.files = files;
    this.log = log;
    this.exit = exit;
    this.stopped = false;
    this.reason = null;
    this.listeners = new Set();
    this.muteUntil = 0;
    this.sigints = 0;
  }

  install({ signals = true, pollMs = 250 } = {}) {
    for (const f of this.files) {
      if (existsSync(f)) {
        try { unlinkSync(f); this.log(`removed stale stop file ${f}`); } catch { /* ignore */ }
      }
    }
    if (signals) {
      this.onSignal = signal => {
        this.sigints++;
        if (this.sigints > 1) { this.log('second interrupt: exiting now'); this.exit(130); return; }
        this.trigger(`${signal} (Ctrl-C again to force quit)`);
      };
      process.on('SIGINT', this.onSignal);
      process.on('SIGTERM', this.onSignal);
    }
    this.timer = setInterval(() => {
      for (const f of this.files) if (existsSync(f)) this.trigger(`stop file ${f}`);
    }, pollMs);
    this.timer.unref?.();
    return this;
  }

  startEscWatcher() {
    if (process.platform !== 'darwin') return;
    try {
      this.esc = spawn('osascript', ['-l', 'JavaScript', '-e', ESC_WATCHER_JXA], { stdio: ['ignore', 'pipe', 'pipe'] });
      const onData = data => { if (String(data).includes('ESC') && Date.now() > this.muteUntil) this.trigger('Esc key'); };
      this.esc.stdout.on('data', onData);
      this.esc.stderr.on('data', onData);
      this.esc.on('error', error => this.log(`esc watcher unavailable: ${error.message}`));
      this.log('hold Esc, create a STOP file, or press Ctrl-C to stop the agent');
    } catch (error) { this.log(`esc watcher unavailable: ${error.message}`); }
  }

  mute(ms = 600) { this.muteUntil = Date.now() + ms; }

  trigger(reason) {
    if (this.stopped) return;
    this.stopped = true;
    this.reason = reason;
    this.log(`STOP requested: ${reason}`);
    for (const fn of this.listeners) { try { fn(reason); } catch { /* ignore */ } }
  }

  onStop(fn) { this.listeners.add(fn); }

  check() { if (this.stopped) throw new StopError(this.reason); }

  dispose() {
    clearInterval(this.timer);
    this.esc?.kill();
    if (this.onSignal) { process.off('SIGINT', this.onSignal); process.off('SIGTERM', this.onSignal); }
  }
}
