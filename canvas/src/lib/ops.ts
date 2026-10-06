import { z } from "zod";

// THE CONTRACT. Agents/MCP -> POST /api/ops -> server log -> SSE /api/events -> canvas client.
// Coordinates are canvas pixels. Ids are caller-chosen strings so ops can reference each other.

const id = z.string().min(1).max(64);
const color = z.enum(["black","grey","white","red","orange","yellow","green","blue","violet"]).default("black");
const severity = z.enum(["critical","high","medium","low","info"]);

// ---- markup ops: let an agent mark up the board like a human with a marker ----------------------
// ADDITIVE block (draw, arrow_to, highlight, add_text, group, lock, order). Coordinates are canvas px
// unless noted. "Fractions" are 0..1 of a target image/video's bounds (resolved by the client, so
// they survive resizing and never depend on the sender knowing the real rendered size).
const markColor = z.enum(["black","grey","white","red","orange","yellow","green","blue","violet","light-red","light-green","light-blue","light-violet"]);
const strokeSize = z.enum(["s","m","l","xl"]);
const pt = z.object({ x: z.number(), y: z.number() });
// a spot on an element: (fx,fy) fractions of its bounds; optional dx,dy px offset from that spot
const onTarget = z.object({ target: id, fx: z.number(), fy: z.number(), dx: z.number().optional(), dy: z.number().optional() });
const endpoint = z.union([id, pt, onTarget]);

export const markupOps = [
  // freehand stroke. space "canvas": points are canvas px. space "target": points are fractions of
  // `target`. With a `target` the stroke is attached (moves with it). animate = draw in progressively.
  z.object({ type: z.literal("draw"), id: id.optional(), points: z.array(pt).min(2).max(500), color: markColor.optional(), size: strokeSize.optional(), style: z.enum(["pen","highlighter"]).optional(), animate: z.boolean().optional(), target: id.optional(), space: z.enum(["canvas","target"]).optional() }),
  // arrow between any two things: element ids (bound, stays attached), raw canvas points, or a spot on an element
  z.object({ type: z.literal("arrow_to"), id: id.optional(), from: endpoint, to: endpoint, label: z.string().optional(), color: markColor.optional(), bend: z.number().optional(), size: strokeSize.optional(), attach: id.optional() }),
  // soft translucent fill over a region of a target image/video (fractions of the target), no label tab
  z.object({ type: z.literal("highlight"), id: id.optional(), target: id, box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }), kind: z.enum(["rectangle","ellipse"]).optional(), color: markColor.optional(), label: z.string().optional(), opacity: z.number().min(0.05).max(1).optional() }),
  // text label. x,y = top-left in canvas px; or give `target` (+ `at` fractions and/or `offset` px) to anchor it to an element so it moves with it
  z.object({ type: z.literal("add_text"), id: id.optional(), text: z.string(), x: z.number().optional(), y: z.number().optional(), w: z.number().positive().optional(), size: strokeSize.optional(), color: markColor.optional(), align: z.enum(["start","middle","end"]).optional(), font: z.enum(["draw","sans","serif","mono"]).optional(), target: id.optional(), at: z.object({ fx: z.number(), fy: z.number() }).optional(), offset: pt.optional() }),
  z.object({ type: z.literal("group"), id: id.optional(), ids: z.array(id).min(1), label: z.string().optional(), ungroup: z.boolean().optional() }),
  z.object({ type: z.literal("lock"), ids: z.array(id).min(1), locked: z.boolean().default(true) }),
  z.object({ type: z.literal("order"), ids: z.array(id).min(1), to: z.enum(["front","back","forward","backward"]) }),
] as const;

export const OpSchema =z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_image"), id: id.optional(), src: z.string(), x: z.number(), y: z.number(), w: z.number().optional(), h: z.number().optional(), label: z.string().optional(), step: z.number().int().optional() }),
  z.object({ type: z.literal("add_video"), id: id.optional(), src: z.string(), x: z.number(), y: z.number(), w: z.number().default(640), h: z.number().default(360), label: z.string().optional(), autoplay: z.boolean().default(false), seekTo: z.number().optional() }),
  z.object({ type: z.literal("add_shape"), id: id.optional(), kind: z.enum(["rectangle","ellipse","line","text","note"]), x: z.number(), y: z.number(), w: z.number().optional(), h: z.number().optional(), text: z.string().optional(), color: color.optional() }),
  z.object({ type: z.literal("add_arrow"), id: id.optional(), from: id, to: id, label: z.string().optional(), color: color.optional() }),
  // box is fractions (0..1) of the target image/video so it survives resizing
  z.object({ type: z.literal("annotate"), id: id.optional(), target: id, box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }), label: z.string().optional(), severity: severity.default("medium") }),
  z.object({ type: z.literal("add_finding"), id: id.optional(), x: z.number(), y: z.number(), title: z.string(), severity, expected: z.string().optional(), actual: z.string().optional(), verified: z.boolean().default(false), target: id.optional(), timestamp: z.number().optional() }),
  z.object({ type: z.literal("update"), id, props: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("move"), id, x: z.number(), y: z.number() }),
  z.object({ type: z.literal("delete"), id }),
  z.object({ type: z.literal("focus"), ids: z.array(id).optional(), box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional() }),
  z.object({ type: z.literal("clear") }),
  ...markupOps,
  // Additive (agent presence): the agent's avatar glides to (x, y) in canvas pixels, with an optional name tag.
  z.object({ type: z.literal("cursor"), x: z.number(), y: z.number(), label: z.string().max(40).optional() }),
  // Additive: a speech bubble the agent leaves on the board. Pass `target` (an element id) to hang it beside that
  // element, or x/y for an absolute spot. With neither it lands beside the agent's last cursor position.
  z.object({ type: z.literal("say"), id: id.optional(), text: z.string().min(1).max(600), x: z.number().optional(), y: z.number().optional(), target: id.optional() }),
]);
export type Op = z.infer<typeof OpSchema>;

// `src` = id of the browser tab that posted a human edit (never set for agents). A tab skips envelopes carrying its own
// `src`: its edits are already on screen, and re-applying an echo would snap back anything it moved since.
export const EnvelopeSchema = z.object({ seq: z.number().int(), ts: z.number(), op: OpSchema, src: z.string().optional() });
export type Envelope = z.infer<typeof EnvelopeSchema>;

// HTTP API (owned by the server workstream). Every route takes `?board=<id>` (^[a-zA-Z0-9-]{1,64}$, default `main`):
// one independent op log per board; a run publishes to the board named after its run id.
// `?client=<tabId>` on POST /api/ops stamps the envelopes' `src` (human edits made in the canvas).
//   POST   /api/ops     body: Op | Op[]          -> { ok, seqs:number[] }  (assigns missing ids, returns them in `ids`)
//   GET    /api/state                              -> { seq, ops: Envelope[] }
//   GET    /api/events?since=N                     -> SSE of Envelope (replays > since, then live)
//   POST   /api/upload   multipart `file`          -> { url }  (served from /uploads/*)
//   DELETE /api/state                              -> clears log (emits clear)
