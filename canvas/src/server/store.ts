import { list as blobList, put, del } from "@vercel/blob";
import type { Envelope, Op } from "../lib/ops";
import { DEFAULT_BOARD, isBoardId } from "../lib/board.mjs";

// Op log, one per board, with two backends behind one async API:
//  - memory (default, local dev): per-board array, strict incrementing seq.
//  - blob   (CANVAS_STORE=blob, on Vercel): each append is one immutable blob holding Envelope[].
//    The `main` board keeps the original `ops/<seq>.json` layout; every other board lives under
//    `boards/<id>/ops/<seq>.json`. seq is time-based (ms*1000) so instances agree on order without a
//    counter. One shared poller per (instance, board) turns other instances' writes into live events.

type Listener = (env: Envelope) => void;
type Board = {
  id: string;
  log: Envelope[];
  seq: number;
  listeners: Set<Listener>;
  seen: Set<number>;
  poller: ReturnType<typeof setInterval> | null;
  polling: boolean;
};

/** The slice of @vercel/blob this store uses, injectable so tests can run the blob path offline. */
export type BlobApi = {
  list(prefix: string, cursor?: string): Promise<{ blobs: { pathname: string; url: string }[]; hasMore: boolean; cursor?: string }>;
  put(pathname: string, body: string): Promise<void>;
  del(urls: string[]): Promise<void>;
  read(url: string): Promise<Envelope[] | null>;
};

const realBlob: BlobApi = {
  async list(prefix, cursor) {
    const r = await blobList({ prefix, cursor, limit: 1000 });
    return { blobs: r.blobs.map((b) => ({ pathname: b.pathname, url: b.url })), hasMore: r.hasMore, cursor: r.hasMore ? r.cursor : undefined };
  },
  async put(pathname, body) {
    await put(pathname, body, { access: "public", addRandomSuffix: false, contentType: "application/json", cacheControlMaxAge: 60 });
  },
  async del(urls) {
    await del(urls);
  },
  async read(url) {
    const res = await fetch(url, { cache: "no-store" });
    return res.ok ? ((await res.json()) as Envelope[]) : null;
  },
};

type Global = { __canvasBoards?: Map<string, Board>; __canvasBlobCache?: Map<string, Envelope[]>; __canvasBlobApi?: BlobApi };
const g = globalThis as unknown as Global;
const boards = (g.__canvasBoards ??= new Map<string, Board>());
const cache = (g.__canvasBlobCache ??= new Map<string, Envelope[]>());
const blob = (): BlobApi => g.__canvasBlobApi ?? realBlob;

export const useBlob = () => process.env.CANVAS_STORE === "blob";

const CREATES = new Set(["add_image", "add_video", "add_shape", "add_arrow", "annotate", "add_finding", "draw", "arrow_to", "highlight", "add_text", "group", "say"]);
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const POLL_MS = 2000;
const SLACK = 5_000_000; // 5s in seq units; re-read this window to catch late-landing blobs
const CACHE_MAX = 4000;

function shortId(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `n_${s}`;
}

function prepare(op: Op): Op {
  return CREATES.has(op.type) && !("id" in op && op.id) ? ({ ...op, id: shortId() } as Op) : op;
}

function boardOf(id: string = DEFAULT_BOARD): Board {
  if (!isBoardId(id)) throw new Error(`invalid board id: ${id}`);
  let b = boards.get(id);
  if (!b) {
    b = { id, log: [], seq: 0, listeners: new Set(), seen: new Set(), poller: null, polling: false };
    boards.set(id, b);
  }
  return b;
}

/** Blob pathname prefix of a board's op log. `main` keeps the pre-board layout. */
export const prefixOf = (board: string) => (board === DEFAULT_BOARD ? "ops/" : `boards/${board}/ops/`);

function notify(b: Board, env: Envelope) {
  if (b.seen.has(env.seq)) return;
  b.seen.add(env.seq);
  if (b.seen.size > 5000) b.seen = new Set([...b.seen].slice(-2500));
  for (const fn of [...b.listeners]) {
    try { fn(env); } catch { /* a dead subscriber must not break writers */ }
  }
}

// ---------- blob backend ----------
const pad = (n: number) => String(n).padStart(17, "0");

async function listMetas(b: Board): Promise<{ pathname: string; url: string; seq: number }[]> {
  const prefix = prefixOf(b.id);
  const out: { pathname: string; url: string; seq: number }[] = [];
  let cursor: string | undefined;
  do {
    const r = await blob().list(prefix, cursor);
    for (const m of r.blobs) {
      const rest = m.pathname.slice(prefix.length);
      const seq = Number(rest.replace(".json", ""));
      // stray names and nested paths are not this board's op blobs
      if (Number.isFinite(seq) && !rest.includes("/")) out.push({ pathname: m.pathname, url: m.url, seq });
    }
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out.sort((a, c) => a.seq - c.seq);
}

async function readBlob(url: string): Promise<Envelope[]> {
  const hit = cache.get(url);
  if (hit) return hit;
  const envs = (await blob().read(url)) ?? [];
  if (envs.length) {
    if (cache.size > CACHE_MAX) cache.clear();
    cache.set(url, envs);
  }
  return envs;
}

async function blobListSince(b: Board, since: number): Promise<Envelope[]> {
  const metas = await listMetas(b);
  const picked = metas.filter((m, i) => m.seq > since || (metas[i + 1]?.seq ?? Infinity) > since);
  const out: Envelope[] = [];
  for (let i = 0; i < picked.length; i += 16) {
    const chunk = await Promise.all(picked.slice(i, i + 16).map((m) => readBlob(m.url)));
    for (const envs of chunk) for (const e of envs) if (e.seq > since) out.push(e);
  }
  return out.sort((a, c) => a.seq - c.seq);
}

async function blobAppend(b: Board, ops: Op[], src?: string): Promise<Envelope[]> {
  const first = Math.max(b.seq + 1, Date.now() * 1000);
  const ts = Date.now();
  const envs: Envelope[] = ops.map((op, i) => ({ seq: first + i, ts, op: prepare(op), ...(src ? { src } : {}) }));
  b.seq = first + envs.length - 1;
  await blob().put(`${prefixOf(b.id)}${pad(first)}.json`, JSON.stringify(envs));
  const clearEnv = [...envs].reverse().find((e) => e.op.type === "clear");
  if (clearEnv) {
    const old = (await listMetas(b)).filter((m) => m.seq < first);
    if (old.length) await blob().del(old.map((m) => m.url));
  }
  envs.forEach((e) => notify(b, e));
  return envs;
}

async function pollOnce(b: Board) {
  if (b.polling) return;
  b.polling = true;
  try {
    const newest = Math.max(0, ...b.seen);
    for (const e of await blobListSince(b, Math.max(0, newest - SLACK))) notify(b, e);
  } catch { /* transient blob error; next tick retries */ }
  finally { b.polling = false; }
}

// ---------- public API ----------
export async function appendMany(ops: Op[], board: string = DEFAULT_BOARD, src?: string): Promise<Envelope[]> {
  const b = boardOf(board);
  if (useBlob()) return blobAppend(b, ops, src);
  return ops.map((op) => {
    const stored = prepare(op);
    const env: Envelope = { seq: ++b.seq, ts: Date.now(), op: stored, ...(src ? { src } : {}) };
    if (stored.type === "clear") b.log = [env];
    else b.log.push(env);
    notify(b, env);
    return env;
  });
}

export async function append(op: Op, board: string = DEFAULT_BOARD, src?: string): Promise<Envelope> {
  return (await appendMany([op], board, src))[0];
}

export async function list(since?: number, board: string = DEFAULT_BOARD): Promise<Envelope[]> {
  const b = boardOf(board);
  const s = since && since > 0 ? since : 0;
  if (useBlob()) return blobListSince(b, s);
  return s ? b.log.filter((e) => e.seq > s) : [...b.log];
}

export async function currentSeq(board: string = DEFAULT_BOARD): Promise<number> {
  const b = boardOf(board);
  if (!useBlob()) return b.seq;
  return (await blobListSince(b, 0)).at(-1)?.seq ?? 0;
}

export async function clear(board: string = DEFAULT_BOARD, src?: string): Promise<Envelope> {
  return append({ type: "clear" }, board, src);
}

export function subscribe(fn: Listener, board: string = DEFAULT_BOARD): () => void {
  const b = boardOf(board);
  b.listeners.add(fn);
  if (useBlob() && !b.poller) b.poller = setInterval(() => void pollOnce(b), POLL_MS);
  return () => {
    b.listeners.delete(fn);
    if (!b.listeners.size && b.poller) {
      clearInterval(b.poller);
      b.poller = null;
    }
  };
}

// Id an op carries (assigned if it was a creating op), or null (update/move/delete/focus/clear).
export function opId(op: Op): string | null {
  return "id" in op && typeof op.id === "string" ? op.id : null;
}

// ---------- test hooks ----------
/** Swap the blob client (null restores the real one). Tests only. */
export function __setBlobApiForTests(api: BlobApi | null) {
  if (api) g.__canvasBlobApi = api;
  else delete g.__canvasBlobApi;
  cache.clear();
}

/** Forget every board (stops pollers). Tests only. */
export function __resetStoreForTests() {
  for (const b of boards.values()) if (b.poller) clearInterval(b.poller);
  boards.clear();
  cache.clear();
}
