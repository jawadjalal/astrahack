// Mid-run steering. A human says "skip onboarding, show me settings" and the next model turn includes it.
// Three equivalent inboxes feed one queue:
//   1. HTTP on the agent process:  POST http://127.0.0.1:$AGENT_PORT/steer  {"text":"..."}   (or GET /steer?text=...)
//   2. A line typed (or piped) on STDIN of the agent process
//   3. A line appended to <run dir>/steer.txt
// Also: GET /status (live JSON), POST /stop (hard stop).

import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { existsSync, statSync, readFileSync } from 'node:fs';

export class SteerInbox {
  constructor({ log = () => {}, max = 20 } = {}) {
    this.queue = [];
    this.history = [];
    this.log = log;
    this.max = max;
    this.waiters = new Set();
  }

  push(text, source = 'api') {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!clean) return false;
    if (this.queue.length >= this.max) this.queue.shift();
    const entry = { text: clean, source, at: new Date().toISOString() };
    this.queue.push(entry);
    this.history.push(entry);
    this.log(`steer (${source}): ${clean}`);
    for (const fn of this.waiters) fn(entry);
    return true;
  }

  // Take everything queued; returns the strings the model should see.
  drain() {
    const out = this.queue.splice(0);
    return out.map(e => `HUMAN STEER: ${e.text}`);
  }

  get pending() { return this.queue.length; }
}

export async function startSteerServer({ inbox, port = 7788, getStatus = () => ({}), onStop = () => {}, log = () => {} }) {
  if (port === 'off' || port === false || port === null) return { port: null, close: async () => {} };
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return send(204, {});
    if (url.pathname === '/status') return send(200, getStatus());
    if (url.pathname === '/stop') { onStop('http /stop'); return send(200, { ok: true }); }
    if (url.pathname === '/steer') {
      if (req.method === 'GET') return send(200, { ok: inbox.push(url.searchParams.get('text'), 'http') });
      let body = '';
      req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
      req.on('end', () => {
        let text = body;
        try { const j = JSON.parse(body); text = j.text ?? j.message ?? ''; } catch { /* plain text body */ }
        send(200, { ok: inbox.push(text, 'http') });
      });
      return;
    }
    send(404, { error: 'POST /steer {text} | GET /status | POST /stop' });
  };
  const listen = p => new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(p, '127.0.0.1', () => resolve(server));
  });
  let server;
  try { server = await listen(Number(port)); } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    log(`agent port ${port} is busy; using a random free port`);
    server = await listen(0);
  }
  const actual = server.address().port;
  log(`steer: POST http://127.0.0.1:${actual}/steer {"text":"..."}  (also STDIN lines and the steer file)`);
  return { port: actual, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

export function watchSteerFile(path, inbox, intervalMs = 400) {
  let offset = existsSync(path) ? statSync(path).size : 0;
  const timer = setInterval(() => {
    try {
      if (!existsSync(path)) return;
      const size = statSync(path).size;
      if (size < offset) offset = 0;
      if (size === offset) return;
      const chunk = readFileSync(path, 'utf8').slice(offset);
      offset = size;
      for (const line of chunk.split('\n')) inbox.push(line, 'file');
    } catch { /* retry next tick */ }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function watchStdin(inbox, input = process.stdin) {
  if (!input || input.destroyed) return () => {};
  const rl = createInterface({ input });
  rl.on('line', line => inbox.push(line, 'stdin'));
  rl.on('error', () => {});
  return () => { rl.close(); };
}
