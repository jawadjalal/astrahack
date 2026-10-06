import type { Envelope, Op } from "./ops";

// The Activity panel's rows, derived from ops in plain language. Elements remember a friendly name
// (label / title / text) so later ops ("Marked region on Signup") can refer to them.

export type ActivityKind = "image" | "video" | "shape" | "arrow" | "annotate" | "finding" | "say" | "edit" | "focus" | "clear";

export type ActivityRow = {
  key: string;
  seq: number;
  ts: number;
  kind: ActivityKind;
  text: string;
  /** element ids the row focuses when clicked */
  ids: string[];
  severity?: string;
  verified?: boolean;
};

const names = new Map<string, string>();
const clip = (s: string, n = 64) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const nameOf = (id: string | undefined) => (id ? names.get(id) ?? id : "an element");

export function resetNames() {
  names.clear();
}

/** Turn one op into a row, or null for ops that are not worth listing (cursor moves, focus, bare updates). */
export function describeOp(env: Envelope): ActivityRow | null {
  const op: Op = env.op;
  const base = { key: `${env.seq}`, seq: env.seq, ts: env.ts };
  const id = ("id" in op && op.id) || `op${env.seq}`;
  switch (op.type) {
    case "add_image": {
      const n = op.label ?? "screenshot";
      names.set(id, n);
      return { ...base, kind: "image", text: op.step != null ? `Added screenshot: ${n} (step ${op.step})` : `Added screenshot: ${n}`, ids: [id] };
    }
    case "add_video": {
      const n = op.label ?? "recording";
      names.set(id, n);
      return { ...base, kind: "video", text: `Added video: ${n}`, ids: [id] };
    }
    case "add_shape": {
      const n = op.text ? clip(op.text, 40) : op.kind;
      names.set(id, n);
      const what = op.kind === "note" ? "Left a note" : op.kind === "text" ? "Wrote" : `Drew a ${op.kind}`;
      return { ...base, kind: "shape", text: op.text ? `${what}: ${clip(op.text, 56)}` : what, ids: [id] };
    }
    case "add_arrow":
      return { ...base, kind: "arrow", text: `Connected ${nameOf(op.from)} to ${nameOf(op.to)}${op.label ? ` (${clip(op.label, 30)})` : ""}`, ids: [id, op.from, op.to] };
    case "annotate":
      return { ...base, kind: "annotate", text: `Marked ${op.label ? `"${clip(op.label, 40)}"` : "a region"} on ${nameOf(op.target)}`, ids: [id], severity: op.severity };
    case "add_finding": {
      names.set(id, op.title);
      return { ...base, kind: "finding", text: `Flagged ${op.severity}: ${clip(op.title)}`, ids: [id], severity: op.severity, verified: op.verified };
    }
    case "draw":
      return { ...base, kind: "shape", text: op.target ? `${op.style === "highlighter" ? "Highlighted" : "Drew"} on ${nameOf(op.target)}` : op.style === "highlighter" ? "Highlighted something" : "Sketched a mark", ids: [id] };
    case "arrow_to": {
      const ref = (e: typeof op.from) => (typeof e === "string" ? nameOf(e) : "target" in e ? nameOf(e.target) : "a spot");
      names.set(id, op.label ?? "arrow");
      const ids = [id, ...[op.from, op.to].filter((e): e is string => typeof e === "string")];
      return { ...base, kind: "arrow", text: `Pointed from ${ref(op.from)} to ${ref(op.to)}${op.label ? ` (${clip(op.label, 30)})` : ""}`, ids };
    }
    case "highlight":
      return { ...base, kind: "annotate", text: `Highlighted ${op.label ? `"${clip(op.label, 40)}"` : "a region"} on ${nameOf(op.target)}`, ids: [id] };
    case "add_text":
      names.set(id, clip(op.text, 40));
      return { ...base, kind: "shape", text: `Wrote: ${clip(op.text, 56)}`, ids: [id] };
    case "group":
      return { ...base, kind: "edit", text: op.ungroup ? "Ungrouped elements" : `Grouped ${op.ids.length} elements${op.label ? ` as "${clip(op.label, 30)}"` : ""}`, ids: op.ids };
    case "lock":
      return { ...base, kind: "edit", text: op.locked ? `Locked ${op.ids.length} element${op.ids.length > 1 ? "s" : ""}` : `Unlocked ${op.ids.length} element${op.ids.length > 1 ? "s" : ""}`, ids: op.ids };
    case "say":
      return { ...base, kind: "say", text: `Said: "${clip(op.text, 70)}"`, ids: [id] };
    case "delete":
      return { ...base, kind: "edit", text: `Removed ${nameOf(op.id)}`, ids: [] };
    case "clear":
      names.clear();
      return { ...base, kind: "clear", text: "Cleared the board", ids: [] };
    case "move":
      return { ...base, kind: "edit", text: `Moved ${nameOf(op.id)}`, ids: [op.id] };
    case "update": {
      const t = typeof op.props.label === "string" ? op.props.label : typeof op.props.text === "string" ? op.props.text : null;
      if (t) names.set(op.id, t);
      return { ...base, kind: "edit", text: `Updated ${nameOf(op.id)}`, ids: [op.id] };
    }
    default:
      return null; // focus, cursor
  }
}

// ---- tiny store so Canvas can push rows and the panel can subscribe ----
type Listener = (rows: ActivityRow[]) => void;
let rows: ActivityRow[] = [];
const listeners = new Set<Listener>();
const MAX_ROWS = 300;

export const activity = {
  get: () => rows,
  push(env: Envelope) {
    const r = describeOp(env);
    if (!r) return;
    rows = r.kind === "clear" ? [r] : [...rows, r].slice(-MAX_ROWS);
    for (const l of [...listeners]) l(rows);
  },
  reset() {
    rows = [];
    resetNames();
    for (const l of [...listeners]) l(rows);
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};
