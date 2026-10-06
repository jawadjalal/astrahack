import type { Envelope, Op } from "@/lib/ops";

// In-memory op log. Lives on globalThis so it survives Next hot reload and is
// shared across route handlers in the same Node process.

type Listener = (env: Envelope) => void;
type State = { log: Envelope[]; seq: number; listeners: Set<Listener> };

const g = globalThis as unknown as { __canvasStore?: State };
const state: State = (g.__canvasStore ??= { log: [], seq: 0, listeners: new Set() });

const CREATES = new Set(["add_image", "add_video", "add_shape", "add_arrow", "annotate", "add_finding"]);
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function shortId(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `n_${s}`;
}

export function append(op: Op): Envelope {
  let stored: Op = op;
  if (CREATES.has(op.type) && !("id" in op && op.id)) {
    stored = { ...op, id: shortId() } as Op;
  }
  const env: Envelope = { seq: ++state.seq, ts: Date.now(), op: stored };
  if (stored.type === "clear") state.log = [env];
  else state.log.push(env);
  for (const fn of [...state.listeners]) {
    try {
      fn(env);
    } catch {
      /* a dead subscriber must not break writers */
    }
  }
  return env;
}

export function list(since?: number): Envelope[] {
  return since && since > 0 ? state.log.filter((e) => e.seq > since) : [...state.log];
}

export function currentSeq(): number {
  return state.seq;
}

export function clear(): Envelope {
  return append({ type: "clear" });
}

export function subscribe(fn: Listener): () => void {
  state.listeners.add(fn);
  return () => {
    state.listeners.delete(fn);
  };
}

// Id an op carries (assigned if it was a creating op), or null (update/move/delete/focus/clear).
export function opId(op: Op): string | null {
  return "id" in op && typeof op.id === "string" ? op.id : null;
}
