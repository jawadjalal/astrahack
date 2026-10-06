// Live streaming of the teardown to the agent-native canvas (contract: canvas/src/lib/ops.ts).
//   POST {CANVAS_URL}/api/upload  multipart `file` -> { url }
//   POST {CANVAS_URL}/api/ops     Op | Op[]
// CANVAS_URL may include a basePath (https://ignura.com/astrahack). Canvas failures never stop a run:
// every call is retried, then logged and dropped. Ops go through one serial queue so ids exist before
// arrows/annotations reference them and the loop never blocks on uploads.

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { boxAroundPoint } from './findings.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..', '..');

export const LAYOUT = { IMG_W: 520, GAP: 260, NOTE_W: 200, FINDING_W: 360, FINDING_STEP: 270, ROW_H: 1100, TOP: 0 };
export const PITCH = LAYOUT.IMG_W + LAYOUT.GAP;

export const normalizeCanvasUrl = url => String(url || 'http://localhost:3000').trim().replace(/\/+$/, '');
const isLocal = url => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
const trunc = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// Read which optional ops the local contract defines, and the field names they take.
export function readLocalOps(file = join(REPO_ROOT, 'canvas', 'src', 'lib', 'ops.ts')) {
  const out = { cursor: null, say: null };
  try {
    const src = readFileSync(file, 'utf8');
    for (const name of Object.keys(out)) {
      const m = src.match(new RegExp(`z\\.object\\(\\{[^\\n]*type:\\s*z\\.literal\\("${name}"\\)([^\\n]*)\\}\\)`));
      if (m) out[name] = [...m[1].matchAll(/(\w+):\s*z\./g)].map(k => k[1]);
    }
  } catch { /* contract file not present: no optional ops */ }
  return out;
}

export class CanvasStreamer {
  constructor({ url, fetchImpl = fetch, idPrefix = '', dryRun = false, log = () => {}, features, y0 = 0, retries = 2 } = {}) {
    this.base = normalizeCanvasUrl(url);
    this.fetch = fetchImpl;
    this.idPrefix = idPrefix;
    this.dryRun = dryRun;
    this.log = log;
    this.y0 = y0;
    this.retries = retries;
    this.enabled = true;
    this.chain = Promise.resolve();
    this.errors = [];
    this.posted = [];        // every op we sent (for tests / run log)
    this.urls = new Map();   // step id -> uploaded screenshot url
    this.sizes = new Map();  // step id -> {w,h} on canvas
    this.findingSlots = new Map();
    this.features = features ?? { cursor: null, say: null };
  }

  id(kind, n) { return `${this.idPrefix}${kind}-${n}`; }
  stepId(n) { return this.id('step', n); }

  // ----- transport -----

  async http(path, init) {
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await this.fetch(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(30000) });
        const text = await res.text();
        let body = {};
        try { body = JSON.parse(text); } catch { /* non-json body */ }
        if (!res.ok) {
          const err = new Error(`${init?.method || 'GET'} ${path} -> ${res.status} ${trunc(text, 200)}`);
          err.status = res.status; err.body = body;
          if (res.status >= 400 && res.status < 500 && res.status !== 429) throw Object.assign(err, { fatal: true });
          throw err;
        }
        return body;
      } catch (error) {
        lastError = error;
        if (error.fatal || attempt === this.retries) break;
        await sleep(500 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  async probe() {
    if (this.dryRun) { this.log('canvas: dry-run, nothing will be sent'); return true; }
    try {
      await this.http('/api/state');
    } catch (error) {
      this.enabled = false;
      this.log(`canvas: ${this.base} unreachable (${error.message}); continuing without live streaming`);
      return false;
    }
    const local = readLocalOps();
    for (const name of ['cursor', 'say']) {
      if (this.features[name] === null) this.features[name] = local[name] ? { fields: local[name] } : false;
      if (this.features[name] && !(await this.serverKnows(name))) {
        this.log(`canvas: server does not know op "${name}" yet; skipping it`);
        this.features[name] = false;
      }
    }
    this.log(`canvas: streaming to ${this.base}${this.features.say ? ' (say)' : ''}${this.features.cursor ? ' (cursor)' : ''}`);
    return true;
  }

  // POST an op with no fields: a known type fails on missing fields, an unknown type fails on the union discriminator.
  async serverKnows(type) {
    try {
      await this.http('/api/ops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type }) });
      return true;
    } catch (error) {
      const issues = error.body?.issues?.flatMap(i => i.issues ?? i) ?? [];
      return !issues.some(i => i.code === 'invalid_union' || /discriminator/i.test(i.message || ''));
    }
  }

  enqueue(task, label) {
    this.chain = this.chain.then(() => (this.enabled ? task() : undefined)).catch(error => {
      this.errors.push({ label, error: error.message });
      this.log(`canvas: ${label} failed: ${error.message}`);
    });
    return this.chain;
  }

  async flush() { await this.chain; }

  ops(list, label = 'ops') {
    const ops = list.filter(Boolean);
    if (!ops.length) return this.chain;
    return this.enqueue(async () => {
      this.posted.push(...ops);
      if (this.dryRun) return;
      await this.http('/api/ops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ops) });
    }, label);
  }

  // Optional ops degrade gracefully: one rejection disables the op for the rest of the run.
  optionalOp(name, op) {
    if (!this.features[name]) return;
    this.enqueue(async () => {
      this.posted.push(op);
      if (this.dryRun) return;
      try {
        await this.http('/api/ops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(op) });
      } catch (error) {
        if (error.status === 400) { this.features[name] = false; this.log(`canvas: op "${name}" rejected; disabled (${error.message})`); return; }
        throw error;
      }
    }, name);
  }

  async upload(buffer, filename, mime) {
    if (this.dryRun) return `dry-run://${filename}`;
    const send = async () => {
      const form = new FormData();
      form.append('file', new Blob([buffer], { type: mime }), filename);
      const json = await this.http('/api/upload', { method: 'POST', body: form });
      if (!json.url) throw new Error(`upload returned no url: ${JSON.stringify(json).slice(0, 120)}`);
      return json.url;
    };
    return send();
  }

  // Upload a file of any size. Big files on a deployed canvas must go direct to Blob (function bodies cap at ~4.5MB).
  async uploadFile(path, mime) {
    const buffer = await readFile(path);
    const name = basename(path);
    if (buffer.length <= 4 * 1024 * 1024 || isLocal(this.base) || this.dryRun) return this.upload(buffer, name, mime);
    const clientPath = join(REPO_ROOT, 'canvas', 'package.json');
    try {
      const require = createRequire(clientPath);
      const blobClient = await import(pathToFileURL(require.resolve('@vercel/blob/client')).href);
      const result = await blobClient.upload(`uploads/${name}`, new Blob([buffer], { type: mime }), {
        access: 'public', handleUploadUrl: `${this.base}/api/upload/token`, contentType: mime
      });
      return result.url;
    } catch (error) {
      this.log(`canvas: direct blob upload unavailable (${error.message}); trying /api/upload (may exceed the 4.5MB function limit)`);
      return this.upload(buffer, name, mime);
    }
  }

  // ----- layout -----

  stepXY(n, row = 0) { return { x: n * PITCH, y: this.y0 + row * LAYOUT.ROW_H }; }

  canvasPoint(n, row, shot, point) {
    const { x, y } = this.stepXY(n, row);
    const k = LAYOUT.IMG_W / shot.width;
    return { x: Math.round(x + point.x * k), y: Math.round(y + point.y * k) };
  }

  // ----- semantic helpers used by the loop -----

  // Add the screenshot for step n. kind 'step' => main row; for verify rows pass idKey/row.
  addStep({ n, shot, label, thought, arrowLabel, prev, row = 0, key, pointer, prevShot, finding = false }) {
    const id = key || this.stepId(n);
    const h = Math.round(LAYOUT.IMG_W * shot.height / shot.width);
    this.sizes.set(id, { w: LAYOUT.IMG_W, h });
    const { x, y } = this.stepXY(n, row);
    const done = this.enqueue(async () => {
      const url = await this.upload(shot.buffer, `${id}.jpg`, shot.mime || 'image/jpeg');
      this.urls.set(id, url);
      const ops = [{ type: 'add_image', id, src: url, x, y, w: LAYOUT.IMG_W, h, label: trunc(label, 70), step: n }];
      this.posted.push(...ops);
      if (!this.dryRun) await this.http('/api/ops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ops) });
    }, `step ${id}`);
    const follow = [];
    if (prev) {
      if (pointer && prevShot) {
        follow.push({ type: 'annotate', id: `${prev}-ptr-${n}`, target: prev, box: boxAroundPoint(pointer, prevShot), label: trunc(String(arrowLabel).split(', ')[0], 28), severity: 'info' });
      }
      follow.push({ type: 'add_arrow', id: `${prev}-to-${id}`, from: prev, to: id, label: trunc(arrowLabel, 48), color: 'blue' });
    }
    if (thought) follow.push({ type: 'add_shape', id: `${id}-think`, kind: 'note', x, y: y + h + 40, text: trunc(thought, 260), color: 'yellow' });
    if (follow.length) this.ops(follow, `step ${id} extras`);
    if (pointer && prevShot && this.features.cursor) {
      const prevN = Number(prev.match(/(\d+)$/)?.[1] ?? n - 1);
      this.optionalCursor(prevN, row, prevShot, pointer, arrowLabel);
    }
    if (thought) this.say(thought);
    this.focus([id]);
    return done;
  }

  optionalCursor(n, row, shot, point, label) {
    const f = this.features.cursor;
    if (!f) return;
    const at = this.canvasPoint(n, row, shot, point);
    const fields = f.fields || [];
    const op = { type: 'cursor', x: at.x, y: at.y, ...(fields.includes('label') ? { label: trunc(label, 40) } : {}) };
    this.optionalOp('cursor', op);
  }

  say(text) {
    const f = this.features.say;
    if (!f) return;
    const field = ['text', 'message', 'caption', 'content'].find(k => f.fields?.includes(k)) || 'text';
    this.optionalOp('say', { type: 'say', [field]: trunc(text, 200) });
  }

  focus(ids) { this.ops([{ type: 'focus', ids }], 'focus'); }

  addNote(id, x, y, text, color = 'yellow') {
    this.ops([{ type: 'add_shape', id: `${this.idPrefix}${id}`, kind: 'note', x, y, text: trunc(text, 400), color }], `note ${id}`);
  }

  addFinding(f, { stepKey, row = 0, n }) {
    const size = this.sizes.get(stepKey) || { w: LAYOUT.IMG_W, h: 325 };
    const { x, y } = this.stepXY(n, row);
    const slot = this.findingSlots.get(stepKey) ?? 0;
    this.findingSlots.set(stepKey, slot + 1);
    const ops = [{
      type: 'add_finding', id: `${this.idPrefix}finding-${f.id}`,
      x: x + LAYOUT.NOTE_W + 20, y: y + size.h + 40 + slot * LAYOUT.FINDING_STEP,
      title: f.title, severity: f.severity, expected: f.expected, actual: f.actual, verified: f.verified,
      target: stepKey, ...(f.timestamp != null ? { timestamp: f.timestamp } : {})
    }];
    if (f.box) ops.push({ type: 'annotate', id: `${this.idPrefix}ann-${f.id}`, target: stepKey, box: f.box, label: trunc(f.title, 48), severity: f.severity });
    this.ops(ops, `finding ${f.id}`);
    this.focus([`${this.idPrefix}finding-${f.id}`]);
  }

  updateFinding(f) {
    this.ops([{ type: 'update', id: `${this.idPrefix}finding-${f.id}`, props: { verified: f.verified } }], `verify ${f.id}`);
  }

  linkFindingToReplay(f, replayKey) {
    this.ops([{ type: 'add_arrow', id: `${this.idPrefix}replay-${f.id}`, from: `${this.idPrefix}finding-${f.id}`, to: replayKey, label: f.verified ? 'replayed: reproduced' : 'replayed: not reproduced', color: f.verified ? 'green' : 'grey' }], `link ${f.id}`);
  }

  async addVideo({ path, x, y, label }) {
    return this.enqueue(async () => {
      const src = await this.uploadFile(path, path.endsWith('.mp4') ? 'video/mp4' : 'video/webm');
      const op = { type: 'add_video', id: `${this.idPrefix}recording`, src, x, y, w: 640, h: 360, label: trunc(label, 70), autoplay: false };
      this.posted.push(op);
      if (!this.dryRun) await this.http('/api/ops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([op]) });
      this.videoUrl = src;
    }, 'video');
  }

  async clear() {
    if (this.dryRun || !this.enabled) return;
    try { await this.http('/api/state', { method: 'DELETE' }); } catch (error) { this.log(`canvas: clear failed: ${error.message}`); }
  }
}
