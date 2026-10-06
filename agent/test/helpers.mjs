import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLACEHOLDER_SHOT } from '../src/placeholder.mjs';
import { CanvasStreamer } from '../src/canvas.mjs';

export const tmp = prefix => mkdtemp(join(tmpdir(), prefix));

// The real canvas contract, when canvas deps are installed (Node 22 strips the TypeScript types itself).
export async function loadOpSchema() {
  try {
    const url = pathToFileURL(fileURLToPath(new URL('../../canvas/src/lib/ops.ts', import.meta.url))).href;
    return (await import(url)).OpSchema;
  } catch { return null; }
}

// A canvas server in a function: validates ops against OpSchema when available, records everything.
export function fakeCanvasFetch({ schema, knownOps = ['say', 'cursor'], failOps = false } = {}) {
  const log = { ops: [], uploads: [], invalid: [] };
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (path.endsWith('/api/state')) return reply(200, { seq: 0, ops: [] });
    if (path.endsWith('/api/upload')) {
      const file = init.body.get('file');
      log.uploads.push({ name: file.name, size: file.size, type: file.type });
      return reply(200, { url: `/uploads/${log.uploads.length}-${file.name}` });
    }
    if (path.endsWith('/api/ops')) {
      if (failOps) return reply(500, { ok: false });
      const body = JSON.parse(init.body);
      const items = Array.isArray(body) ? body : [body];
      const issues = [];
      items.forEach((op, index) => {
        if (['say', 'cursor'].includes(op.type) && !knownOps.includes(op.type)) { issues.push({ index, issues: [{ code: 'invalid_union', message: 'No matching discriminator' }] }); return; }
        if (schema) {
          const r = schema.safeParse(op);
          if (!r.success) {
            issues.push({ index, issues: r.error.issues });
            if (Object.keys(op).length > 1) log.invalid.push({ op, issues: r.error.issues }); // a bare {type} is the agent's capability probe
            return;
          }
        }
        log.ops.push(op);
      });
      if (issues.length) return reply(400, { ok: false, error: 'invalid op(s)', issues });
      return reply(200, { ok: true });
    }
    return reply(404, {});
  };
  return { fetchImpl, log };
}

export class FakeBackend {
  constructor({ onExecute } = {}) {
    this.name = 'fake';
    this.executed = [];
    this.resets = 0;
    this.onExecute = onExecute;
    this.startUrl = 'http://fake.test/';
  }
  async open() {}
  async close() {}
  async screenshot() { return { ...PLACEHOLDER_SHOT }; }
  async frame() { return null; }
  async state() { return { url: 'http://fake.test/' + this.executed.length, title: `Screen ${this.executed.length}` }; }
  async execute(action) { this.executed.push(action); await this.onExecute?.(action, this); return { commands: 1 }; }
  async settle() { return { notes: [] }; }
  async reset() { this.resets++; }
}

export const newCanvas = (fetchImpl, extra = {}) => new CanvasStreamer({ url: 'http://canvas.test/astrahack', fetchImpl, log: () => {}, retries: 0, ...extra });
