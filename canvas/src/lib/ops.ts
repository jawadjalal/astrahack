import { z } from "zod";

// THE CONTRACT. Agents/MCP -> POST /api/ops -> server log -> SSE /api/events -> canvas client.
// Coordinates are canvas pixels. Ids are caller-chosen strings so ops can reference each other.

const id = z.string().min(1).max(64);
const color = z.enum(["black","grey","white","red","orange","yellow","green","blue","violet"]).default("black");
const severity = z.enum(["critical","high","medium","low","info"]);

export const OpSchema = z.discriminatedUnion("type", [
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
]);
export type Op = z.infer<typeof OpSchema>;

export const EnvelopeSchema = z.object({ seq: z.number().int(), ts: z.number(), op: OpSchema });
export type Envelope = z.infer<typeof EnvelopeSchema>;

// HTTP API (owned by the server workstream)
//   POST   /api/ops      body: Op | Op[]          -> { ok, seqs:number[] }  (assigns missing ids, returns them in `ids`)
//   GET    /api/state                              -> { seq, ops: Envelope[] }
//   GET    /api/events?since=N                     -> SSE of Envelope (replays > since, then live)
//   POST   /api/upload   multipart `file`          -> { url }  (served from /uploads/*)
//   DELETE /api/state                              -> clears log (emits clear)
