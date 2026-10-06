#!/usr/bin/env node
// Smoke test for a deployed (or local) canvas. Safe on a live board: it only adds ops whose ids start with
// `smoke-` and removes exactly those again with `delete` ops. It never sends `clear` or DELETE /api/state.
//
//   npm run smoke:prod                                   # https://ignura.com/astrahack
//   npm run smoke:prod -- --canvas http://localhost:3100 # any canvas
//   npm run smoke:prod -- --no-upload                    # skip the upload check
//
// Checks: POST /api/ops (valid and invalid), GET /api/state read-back, GET /api/events (SSE) delivers the new
// ops, POST /api/upload of a 1x1 PNG and the returned url loads, cleanup leaves the board as it was.
// The uploaded 1x1 PNG (68 bytes) stays in storage; there is no delete route for uploads.
import { DEPLOYED_URL, errText, fetchT, parseFlags, sleep, trimUrl } from './lib/common.mjs';

const flags = parseFlags(process.argv.slice(2), {
  canvas: { type: 'string' }, 'no-upload': { type: 'boolean' }, 'sse-wait': { type: 'number', default: 20 }, help: { type: 'boolean' },
});
if (flags.help) { console.log('usage: npm run smoke:prod -- [--canvas URL] [--no-upload] [--sse-wait seconds]'); process.exit(0); }

const BASE = trimUrl(flags.canvas || process.env.SMOKE_CANVAS_URL || DEPLOYED_URL);
const api = (p) => `${BASE}/api${p}`;
const RUN = `smoke-${Date.now().toString(36)}`;
const FAR = -90000; // far off-screen, in case cleanup is ever interrupted
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const rows = [];
let failed = 0;
const record = (name, pass, detail = '', ms) => {
  rows.push({ name, pass });
  if (!pass) failed++;
  console.log(`  [${pass ? ' ok ' : 'FAIL'}] ${name}${detail ? `: ${detail}` : ''}${ms != null ? ` (${ms} ms)` : ''}`);
  return pass;
};
const timed = async (fn) => { const t = Date.now(); const v = await fn(); return [v, Date.now() - t]; };

// Which ids are alive on the board after replaying an op log (same rule as the canvas client).
function aliveIds(envs) {
  const s = new Set();
  for (const { op } of envs) {
    if (op.type === 'clear') s.clear();
    else if (op.type === 'delete') s.delete(op.id);
    else if (typeof op.id === 'string' && !['update', 'move'].includes(op.type)) s.add(op.id);
  }
  return s;
}
const getState = async () => {
  const res = await fetchT(api('/state'), { cache: 'no-store' }, 20000);
  if (!res.ok) throw new Error(`GET /api/state -> HTTP ${res.status}`);
  return res.json();
};
const post = (body) => fetchT(api('/ops'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 20000);

async function untilAlive(pred, seconds = 20) {
  const end = Date.now() + seconds * 1000;
  let last;
  do {
    last = await getState();
    if (pred(aliveIds(last.ops), last)) return last;
    await sleep(1000);
  } while (Date.now() < end);
  return null;
}

// ---- SSE reader: collect Envelope frames until aborted
function openSse(since) {
  const ac = new AbortController();
  const seen = [];
  const info = { status: 0, type: '', cors: '' };
  const ready = (async () => {
    const res = await fetch(`${api('/events')}?since=${since}`, { signal: ac.signal, headers: { Accept: 'text/event-stream' } });
    info.status = res.status; info.type = res.headers.get('content-type') || ''; info.cors = res.headers.get('access-control-allow-origin') || '';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (line) try { seen.push(JSON.parse(line.slice(6))); } catch { /* partial */ }
      }
    }
  })().catch(() => { /* aborted */ });
  return { seen, info, close: () => ac.abort(), ready };
}

const created = []; // ids we added; removed in finally
let baselineAlive = new Set();

async function main() {
  console.log(`smoke test: ${BASE}  (ids ${RUN}-*)\n`);

  // 0. reachability + baseline
  let base;
  try { [base] = await timed(getState); } catch (e) { record('GET /api/state', false, errText(e)); return; }
  baselineAlive = aliveIds(base.ops);
  const blob = base.seq > 1e12;
  record('GET /api/state', true, `seq ${base.seq}, ${base.ops.length} log entries, ${baselineAlive.size} elements on the board, ${blob ? 'Blob-backed (time-based seq)' : base.seq ? 'in-memory store (seq counts 1,2,3...)' : 'empty board, store type unknown'}`);

  // Leftovers from an interrupted earlier run
  const stale = [...baselineAlive].filter((id) => id.startsWith('smoke-'));
  if (stale.length) {
    await post(stale.map((id) => ({ type: 'delete', id })));
    console.log(`        removed ${stale.length} leftover smoke- element(s) from an earlier run`);
    for (const id of stale) baselineAlive.delete(id);
  }

  // 1. SSE first, so the writes below must arrive live
  const sse = openSse(base.seq);

  // 2. invalid op is rejected without side effects
  try {
    const [r, ms] = await timed(() => post([{ type: 'add_shape', kind: 'rectangle', id: `${RUN}-bad`, x: FAR, y: FAR }, { type: 'bogus' }]));
    const body = await r.json().catch(() => ({}));
    record('POST /api/ops rejects an invalid batch (400, nothing applied)', r.status === 400 && body.ok === false, `HTTP ${r.status}`, ms);
  } catch (e) { record('POST /api/ops rejects an invalid batch', false, errText(e)); }

  // 3. valid ops
  const ids = { note: `${RUN}-note`, box: `${RUN}-box`, arrow: `${RUN}-arrow`, finding: `${RUN}-finding` };
  const ops = [
    { type: 'add_shape', id: ids.note, kind: 'note', x: FAR, y: FAR, text: 'smoke test (auto-deleted)', color: 'grey' },
    { type: 'add_shape', id: ids.box, kind: 'rectangle', x: FAR + 400, y: FAR, w: 200, h: 120, color: 'grey' },
    { type: 'add_arrow', id: ids.arrow, from: ids.note, to: ids.box, label: 'smoke' },
    { type: 'add_finding', id: ids.finding, x: FAR, y: FAR + 300, title: 'smoke test finding', severity: 'info', verified: false, target: ids.box },
  ];
  created.push(...Object.values(ids));
  let seqs = [];
  try {
    const [r, ms] = await timed(() => post(ops));
    const body = await r.json().catch(() => ({}));
    seqs = body.seqs || [];
    const idsBack = body.ids || [];
    const same = Object.values(ids).every((id, i) => idsBack[i] === id);
    record('POST /api/ops accepts valid ops', r.ok && body.ok && seqs.length === ops.length && same, `HTTP ${r.status}, ${seqs.length} seqs, ids echoed ${same ? 'ok' : 'WRONG'}`, ms);
  } catch (e) { record('POST /api/ops accepts valid ops', false, errText(e)); }

  // 4. read back through /api/state (blob listing can lag a moment)
  try {
    const t = Date.now();
    const st = await untilAlive((alive) => Object.values(ids).every((id) => alive.has(id)));
    const stored = st ? st.ops.filter((e) => typeof e.op.id === 'string' && e.op.id.startsWith(RUN)) : [];
    const ordered = stored.every((e, i, a) => i === 0 || e.seq > a[i - 1].seq);
    record('GET /api/state returns the new ops, in seq order', !!st && ordered, st ? `${stored.length} found after ${Date.now() - t} ms` : 'not visible after 20 s');
  } catch (e) { record('GET /api/state returns the new ops', false, errText(e)); }

  // 5. SSE delivered them
  try {
    const want = new Set(seqs);
    const end = Date.now() + flags['sse-wait'] * 1000;
    while (Date.now() < end && ![...want].every((s) => sse.seen.some((e) => e.seq === s))) await sleep(500);
    const got = [...want].filter((s) => sse.seen.some((e) => e.seq === s)).length;
    const hdr = sse.info.status === 200 && /text\/event-stream/.test(sse.info.type);
    record('GET /api/events (SSE) streams the new ops', hdr && got === want.size && want.size > 0, `HTTP ${sse.info.status}, ${got}/${want.size} ops received${sse.info.cors === '*' ? ', CORS *' : ', no CORS header'}`);
  } catch (e) { record('GET /api/events (SSE)', false, errText(e)); }
  sse.close();

  // 6. upload + the url loads
  if (flags['no-upload']) console.log('  [skip] POST /api/upload (--no-upload)');
  else {
    try {
      const fd = new FormData();
      fd.append('file', new Blob([PNG_1X1], { type: 'image/png' }), `${RUN}.png`);
      const [r, ms] = await timed(() => fetchT(api('/upload'), { method: 'POST', body: fd }, 30000));
      const body = await r.json().catch(() => ({}));
      if (!record('POST /api/upload returns a url', r.ok && typeof body.url === 'string', r.ok ? body.url : `HTTP ${r.status} ${body.error || ''}`, ms)) throw new Error('no url');
      const url = new URL(body.url, `${BASE}/`).href;
      const img = await fetchT(url, { cache: 'no-store' }, 20000);
      const bytes = Buffer.from(await img.arrayBuffer());
      const isPng = bytes.length > 8 && bytes.subarray(0, 8).equals(PNG_1X1.subarray(0, 8));
      record('uploaded url loads and is the PNG we sent', img.ok && isPng, `HTTP ${img.status}, ${img.headers.get('content-type')}, ${bytes.length} bytes, ${bytes.equals(PNG_1X1) ? 'identical' : 'DIFFERENT bytes'}`);
      const imgId = `${RUN}-img`;
      created.push(imgId);
      const pr = await post({ type: 'add_image', id: imgId, src: body.url, x: FAR, y: FAR + 600, w: 40, label: 'smoke' });
      const st = await untilAlive((alive) => alive.has(imgId));
      const op = st?.ops.find((e) => e.op.id === imgId)?.op;
      record('add_image keeps the upload url unchanged', pr.ok && op?.src === body.url, op ? 'src stored verbatim' : 'op not visible');
    } catch (e) { if (e.message !== 'no url') record('upload check', false, errText(e)); }
  }
}

async function cleanup() {
  if (!created.length) return;
  try {
    const r = await post([...created].reverse().map((id) => ({ type: 'delete', id })));
    const st = await untilAlive((alive) => created.every((id) => !alive.has(id)));
    const alive = st ? aliveIds(st.ops) : new Set();
    const leftovers = created.filter((id) => alive.has(id));
    const lost = [...baselineAlive].filter((id) => !alive.has(id));
    const clears = st ? st.ops.filter((e) => e.op.type === 'clear' && e.ts > Date.now() - 600000).length : 0;
    record(`cleanup removed all ${created.length} smoke- elements`, r.ok && !!st && !leftovers.length, leftovers.length ? `still alive: ${leftovers.join(', ')}` : 'none left');
    record(`board intact: ${baselineAlive.size} pre-existing elements still there`, !lost.length, lost.length ? `MISSING: ${lost.slice(0, 5).join(', ')}` : `no clear op, ${clears === 0 ? 'nothing wiped' : `${clears} clear op(s) in the last 10 min (not ours)`}`);
  } catch (e) { record('cleanup', false, errText(e)); }
}

try { await main(); } catch (e) { record('smoke test', false, errText(e)); }
finally { await cleanup(); }

console.log(`\n${failed ? `${failed} check(s) FAILED` : `all ${rows.length} checks passed`} against ${BASE}`);
if (failed) console.log('If the deployed canvas fails: ask @jawadjalal (canvas/deploy). Check the Vercel project has CANVAS_STORE=blob and a linked Blob store.');
process.exit(failed ? 1 : 0);
