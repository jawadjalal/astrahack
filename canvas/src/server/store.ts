import { list as blobList, put, del } from "@vercel/blob";
import type { Envelope, Op } from "@/lib/ops";

// Op log with two backends behind one async API:
//  - memory (default, local dev): globalThis array, strict incrementing seq.
//  - blob   (CANVAS_STORE=blob, on Vercel): each append is one immutable blob `ops/<seq>.json`
//    holding Envelope[]. seq is time-based (ms*1000) so instances agree on order without a counter.
//    A single shared poller per instance turns other instances' writes into live events.

type Listener = (env: Envelope) => void;
type State = {
  log: Envelope[];
  seq: number;
  listeners: Set<Listener>;
  seen: Set<number>;
  cache: Map<string, Envelope[]>;
  poller: ReturnType<typeof setInterval> | null;
  polling: boolean;
};

const g = globalThis as unknown as { __canvasStore?: State };
const state: State = (g.__canvasStore ??= {
  log: [], seq: 0, listeners: new Set(), seen: new Set(), cache: new Map(), poller: null, polling: false,
});

export const useBlob = () => process.env.CANVAS_STORE === "blob";

const CREATES = new Set(["add_image", "add_video", "add_shape", "add_arrow", "annotate", "add_finding", "draw", "arrow_to", "highlight", "add_text", "group", "say"]);
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const PREFIX = "ops/";
const POLL_MS = 2000;
const SLACK = 5_000_000; // 5s in seq units; re-read this window to catch late-landing blobs

function shortId(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `n_${s}`;
}

function prepare(op: Op): Op {
  return CREATES.has(op.type) && !("id" in op && op.id) ? ({ ...op, id: shortId() } as Op) : op;
}

function notify(env: Envelope) {
  if (state.seen.has(env.seq)) return;
  state.seen.add(env.seq);
  if (state.seen.size > 5000) state.seen = new Set([...state.seen].slice(-2500));
  for (const fn of [...state.listeners]) {
    try { fn(env); } catch { /* a dead subscriber must not break writers */ }
  }
}

// ---------- blob backend ----------
const pad = (n: number) => String(n).padStart(17, "0");
const seqOf = (pathname: string) => Number(pathname.slice(PREFIX.length).replace(".json", ""));

async function listMetas(): Promise<{ pathname: string; url: string; seq: number }[]> {
  const out: { pathname: string; url: string; seq: number }[] = [];
  let cursor: string | undefined;
  do {
    const r = await blobList({ prefix: PREFIX, cursor, limit: 1000 });
    for (const b of r.blobs) out.push({ pathname: b.pathname, url: b.url, seq: seqOf(b.pathname) });
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => a.seq - b.seq);
}

async function readBlob(url: string): Promise<Envelope[]> {
  const hit = state.cache.get(url);
  if (hit) return hit;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  const envs = (await res.json()) as Envelope[];
  state.cache.set(url, envs);
  return envs;
}

async function blobListSince(since: number): Promise<Envelope[]> {
  const metas = await listMetas();
  const picked = metas.filter((m, i) => m.seq > since || (metas[i + 1]?.seq ?? Infinity) > since);
  const out: Envelope[] = [];
  for (let i = 0; i < picked.length; i += 16) {
    const chunk = await Promise.all(picked.slice(i, i + 16).map((m) => readBlob(m.url)));
    for (const envs of chunk) for (const e of envs) if (e.seq > since) out.push(e);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

async function blobAppend(ops: Op[]): Promise<Envelope[]> {
  const first = Math.max(state.seq + 1, Date.now() * 1000);
  const ts = Date.now();
  const envs: Envelope[] = ops.map((op, i) => ({ seq: first + i, ts, op: prepare(op) }));
  state.seq = first + envs.length - 1;
  await put(`${PREFIX}${pad(first)}.json`, JSON.stringify(envs), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  const clearEnv = [...envs].reverse().find((e) => e.op.type === "clear");
  if (clearEnv) {
    const old = (await listMetas()).filter((m) => m.seq < first);
    if (old.length) await del(old.map((m) => m.url));
  }
  envs.forEach(notify);
  return envs;
}

async function pollOnce() {
  if (state.polling) return;
  state.polling = true;
  try {
    const newest = Math.max(0, ...state.seen);
    for (const e of await blobListSince(Math.max(0, newest - SLACK))) notify(e);
  } catch { /* transient blob error; next tick retries */ }
  finally { state.polling = false; }
}

// ---------- public API ----------
export async function appendMany(ops: Op[]): Promise<Envelope[]> {
  if (useBlob()) return blobAppend(ops);
  return ops.map((op) => {
    const stored = prepare(op);
    const env: Envelope = { seq: ++state.seq, ts: Date.now(), op: stored };
    if (stored.type === "clear") state.log = [env];
    else state.log.push(env);
    notify(env);
    return env;
  });
}

export async function append(op: Op): Promise<Envelope> {
  return (await appendMany([op]))[0];
}

export async function list(since?: number): Promise<Envelope[]> {
  const s = since && since > 0 ? since : 0;
  if (useBlob()) return blobListSince(s);
  return s ? state.log.filter((e) => e.seq > s) : [...state.log];
}

export async function currentSeq(): Promise<number> {
  if (!useBlob()) return state.seq;
  return (await blobListSince(0)).at(-1)?.seq ?? 0;
}

export async function clear(): Promise<Envelope> {
  return append({ type: "clear" });
}

export function subscribe(fn: Listener): () => void {
  state.listeners.add(fn);
  if (useBlob() && !state.poller) {
    state.poller = setInterval(pollOnce, POLL_MS);
  }
  return () => {
    state.listeners.delete(fn);
    if (!state.listeners.size && state.poller) {
      clearInterval(state.poller);
      state.poller = null;
    }
  };
}

// Id an op carries (assigned if it was a creating op), or null (update/move/delete/focus/clear).
export function opId(op: Op): string | null {
  return "id" in op && typeof op.id === "string" ? op.id : null;
}
