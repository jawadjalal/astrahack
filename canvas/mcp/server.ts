// astrahack-canvas MCP server (stdio). Lets any MCP-capable agent draw on the agent-native canvas.
// Talks to the canvas HTTP API (see src/lib/ops.ts): POST /api/ops, GET /api/state, POST /api/upload, DELETE /api/state.
// NEVER write to stdout here: stdout is the MCP transport. Log with console.error only.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { OpSchema, type Op } from "../src/lib/ops";

const BASE = (process.env.CANVAS_URL || "http://localhost:3000").replace(/\/+$/, "");
const START_HINT = `Start the canvas app with \`cd canvas && npm run dev\` (expected at ${BASE}; override with CANVAS_URL), then retry.`;

// ---------- HTTP helpers ----------

class CanvasError extends Error {}

async function http(path: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(BASE + path, init);
  } catch (e) {
    throw new CanvasError(`Cannot reach the canvas server at ${BASE} (${(e as Error).message}). ${START_HINT}`);
  }
  const text = await res.text();
  let json: any = undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* not json */ }
  if (!res.ok || (json && json.ok === false)) {
    throw new CanvasError(`Canvas server returned HTTP ${res.status} for ${path}: ${(json && (json.error || JSON.stringify(json))) || text.slice(0, 500)}`);
  }
  return json ?? {};
}

type PostResult = { seqs: number[]; ids: string[] };
async function postOps(ops: Op[]): Promise<PostResult> {
  const json = await http("/api/ops", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ops.length === 1 ? ops[0] : ops),
  });
  return { seqs: json.seqs ?? [], ids: json.ids ?? [] };
}

// Validate with the shared contract so the agent gets a precise error instead of a bare 400.
function validate(raw: unknown[]): Op[] {
  return raw.map((o, i) => {
    const r = OpSchema.safeParse(o);
    if (!r.success) {
      throw new CanvasError(`Op #${i} is invalid: ${r.error.issues.map((x) => `${x.path.join(".") || "(op)"}: ${x.message}`).join("; ")}`);
    }
    return r.data;
  });
}

const rid = (p: string) => `${p}-${randomBytes(3).toString("hex")}`;

// ---------- media handling ----------

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/mp4",
};
const EXT_BY_MIME: Record<string, string> = Object.fromEntries(Object.entries(MIME_BY_EXT).map(([e, m]) => [m, e]));

async function uploadBytes(bytes: Uint8Array, filename: string, mime: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([bytes as BlobPart], { type: mime }), filename);
  const json = await http("/api/upload", { method: "POST", body: form });
  if (!json.url) throw new CanvasError(`Upload succeeded but the server returned no url: ${JSON.stringify(json)}`);
  return json.url as string;
}

function localPath(p: string): string {
  if (p.startsWith("file://")) p = decodeURIComponent(new URL(p).pathname);
  if (p.startsWith("~/")) p = resolve(homedir(), p.slice(2));
  return resolve(p);
}

type Media = { src: string; size?: { w: number; h: number } };

// Best-effort intrinsic size so we can keep aspect ratio when the agent only gives a width.
function imageSize(b: Uint8Array): { w: number; h: number } | undefined {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: dv.getUint32(16), h: dv.getUint32(20) }; // PNG
    if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49) return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) }; // GIF
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) { // JPEG: walk to a SOF marker
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) };
        i += 2 + dv.getUint16(i + 2);
      }
    }
    if (b.length > 30 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") {
      const kind = String.fromCharCode(...b.slice(12, 16));
      if (kind === "VP8X") return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      if (kind === "VP8 ") return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
      if (kind === "VP8L") { const v = dv.getUint32(21, true); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    }
  } catch { /* ignore */ }
  return undefined;
}

async function resolveMedia(opts: { path_or_url?: string; base64?: string; mime?: string; kind: "image" | "video" }): Promise<Media> {
  const { path_or_url, base64, mime, kind } = opts;
  if (base64) {
    const m = mime || (kind === "image" ? "image/png" : "video/mp4");
    const clean = base64.replace(/^data:[^,]*,/, "");
    const bytes = Buffer.from(clean, "base64");
    const src = await uploadBytes(bytes, `${rid(kind)}${EXT_BY_MIME[m] ?? ""}`, m);
    return { src, size: kind === "image" ? imageSize(bytes) : undefined };
  }
  if (!path_or_url) throw new CanvasError("Provide either path_or_url or base64 (+ mime).");
  if (/^data:/i.test(path_or_url)) {
    const bytes = Buffer.from(path_or_url.slice(path_or_url.indexOf(",") + 1), "base64");
    return { src: path_or_url, size: kind === "image" ? imageSize(bytes) : undefined };
  }
  if (/^https?:\/\//i.test(path_or_url)) return { src: path_or_url };
  const p = localPath(path_or_url);
  let bytes: Buffer;
  try { bytes = await readFile(p); } catch (e) {
    throw new CanvasError(`Cannot read local file ${p}: ${(e as Error).message}. Use an absolute path, an http(s) URL, a data: URL, or base64.`);
  }
  const m = mime || MIME_BY_EXT[extname(p).toLowerCase()] || (kind === "image" ? "image/png" : "video/mp4");
  const src = await uploadBytes(bytes, basename(p), m);
  return { src, size: kind === "image" ? imageSize(bytes) : undefined };
}

// ---------- state replay ----------

type El = { id: string; type: string; x?: number; y?: number; w?: number; h?: number; label?: string; extra: Record<string, unknown>; seq: number };
const FALLBACK = { w: 640, h: 400 };

async function replay(): Promise<{ seq: number; els: Map<string, El> }> {
  const st = await http("/api/state");
  const els = new Map<string, El>();
  for (const env of (st.ops ?? []) as { seq: number; op: any }[]) {
    const op = env.op;
    const id: string | undefined = op.id ?? (op.type?.startsWith("add_") || op.type === "annotate" ? `#${env.seq}` : undefined);
    switch (op.type) {
      case "add_image": case "add_video": {
        const w = op.w ?? (op.type === "add_video" ? 640 : 900);
        const h = op.h ?? (op.w || op.type === "add_image" ? Math.round(w * (FALLBACK.h / FALLBACK.w)) : 360);
        els.set(id!, { id: id!, type: op.type === "add_image" ? "image" : "video", x: op.x, y: op.y, w, h, label: op.label, extra: { step: op.step, size_is_estimate: op.w == null || op.h == null || undefined }, seq: env.seq });
        break;
      }
      case "add_shape": {
        const dflt = op.kind === "text" || op.kind === "note" ? { w: 200, h: 100 } : { w: 200, h: 120 };
        els.set(id!, { id: id!, type: op.kind, x: op.x, y: op.y, w: op.w ?? dflt.w, h: op.h ?? dflt.h, label: op.text, extra: { color: op.color }, seq: env.seq });
        break;
      }
      case "add_arrow": els.set(id!, { id: id!, type: "arrow", label: op.label, extra: { from: op.from, to: op.to, color: op.color }, seq: env.seq }); break;
      case "annotate": els.set(id!, { id: id!, type: "annotation", label: op.label, extra: { target: op.target, box: op.box, severity: op.severity }, seq: env.seq }); break;
      case "add_finding":
        els.set(id!, { id: id!, type: "finding", x: op.x, y: op.y, w: 360, h: 200, label: op.title, extra: { severity: op.severity, verified: op.verified, expected: op.expected, actual: op.actual, target: op.target, timestamp: op.timestamp }, seq: env.seq });
        break;
      case "move": { const e = els.get(op.id); if (e) { e.x = op.x; e.y = op.y; } break; }
      case "update": {
        const e = els.get(op.id);
        if (e) {
          const p = op.props ?? {};
          for (const k of ["x", "y", "w", "h"] as const) if (typeof p[k] === "number") (e as any)[k] = p[k];
          if (typeof p.label === "string") e.label = p.label; else if (typeof p.text === "string") e.label = p.text;
          for (const [k, v] of Object.entries(p)) if (!["x", "y", "w", "h", "label", "text"].includes(k)) e.extra[k] = v;
          if (typeof p.w === "number" || typeof p.h === "number") delete e.extra.size_is_estimate;
        }
        break;
      }
      case "say": if (op.id) els.set(op.id, { id: op.id, type: "say", label: op.text, extra: { target: op.target }, seq: env.seq }); break;
      case "delete": els.delete(op.id); break;
      case "clear": els.clear(); break;
      default: break; // focus etc: no state
    }
  }
  return { seq: st.seq ?? 0, els };
}

const r0 = (n?: number) => (n == null ? "?" : String(Math.round(n)));
function describe(e: El): string {
  const pos = e.x != null ? ` at (${r0(e.x)},${r0(e.y)}) size ${r0(e.w)}x${r0(e.h)}${e.extra.size_is_estimate ? " (size estimated)" : ""}` : "";
  const label = e.label ? ` "${e.label.length > 80 ? e.label.slice(0, 77) + "..." : e.label}"` : "";
  const ex = Object.entries(e.extra).filter(([k, v]) => v !== undefined && k !== "size_is_estimate").map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ");
  return `- ${e.id} [${e.type}]${pos}${label}${ex ? " " + ex : ""}`;
}

// ---------- tool plumbing ----------

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (e: unknown): ToolResult => ({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
const wrap = <T,>(fn: (a: T) => Promise<string>) => async (a: T): Promise<ToolResult> => { try { return ok(await fn(a)); } catch (e) { return fail(e); } };

const server = new McpServer({ name: "astrahack-canvas", version: "0.1.0" });

const SEVERITY = z.enum(["critical", "high", "medium", "low", "info"]);
const COLOR = z.enum(["black", "grey", "white", "red", "orange", "yellow", "green", "blue", "violet"]);
const idArg = z.string().min(1).max(64);
const OPTIONAL_ID = idArg.optional().describe("Optional id of your choosing; other tools reference elements by id. Auto-generated if omitted (returned in the result).");

server.registerTool("canvas_add_screenshot", {
  description:
    "Place a screenshot (image) on the shared infinite canvas that a human is watching live. Accepts a local file path (it is uploaded for you), an http(s) URL, a data: URL, or raw base64 + mime. Coordinates are canvas pixels, origin top-left, +x right, +y down; (x,y) is the image's top-left corner. If you give only w, height keeps the aspect ratio when known. Typical screenshots: w=900. Leave ~160px gaps between screens. Returns the element id, which you pass to canvas_add_arrow, canvas_annotate, canvas_move, etc.",
  inputSchema: {
    path_or_url: z.string().optional().describe("Local file path (absolute or ~/...), http(s) URL, or data: URL. Omit if using base64."),
    base64: z.string().optional().describe("Raw base64 image bytes (alternative to path_or_url). Pair with mime."),
    mime: z.string().optional().describe("MIME type for base64 input, e.g. image/png."),
    x: z.number().describe("Canvas x of the top-left corner."),
    y: z.number().describe("Canvas y of the top-left corner."),
    w: z.number().positive().optional().describe("Display width in canvas px (default 900)."),
    h: z.number().positive().optional().describe("Display height in canvas px (default: keep aspect ratio)."),
    label: z.string().optional().describe("Caption shown with the screenshot, e.g. the screen or step name."),
    step: z.number().int().optional().describe("Step number in a flow (1-based); shown as a badge."),
    id: OPTIONAL_ID,
  },
}, wrap(async (a) => {
  const m = await resolveMedia({ path_or_url: a.path_or_url, base64: a.base64, mime: a.mime, kind: "image" });
  const w = a.w ?? (a.h && m.size ? Math.round(a.h * m.size.w / m.size.h) : 900);
  const h = a.h ?? (m.size ? Math.round(w * m.size.h / m.size.w) : undefined);
  const id = a.id ?? rid("img");
  const [op] = validate([{ type: "add_image", id, src: m.src, x: a.x, y: a.y, w, h, label: a.label, step: a.step }]);
  const r = await postOps([op]);
  return `Added screenshot id=${r.ids[0] ?? id} at (${a.x},${a.y}) size ${w}x${h ?? "auto"}${m.src.startsWith("data:") ? "" : ` src=${m.src}`}. Next screen to its right: x=${a.x + w + 160}.`;
}));

server.registerTool("canvas_add_video", {
  description:
    "Place a video (mp4/webm/mov) on the canvas, e.g. a screen recording of a bug. Local file paths are uploaded automatically; http(s)/data URLs are used as is; base64 + mime also works. Defaults to 640x360. seek_to makes the player jump to that second (useful to show the exact moment of a bug). Returns the element id.",
  inputSchema: {
    path_or_url: z.string().optional().describe("Local file path, http(s) URL, or data: URL. Omit if using base64."),
    base64: z.string().optional(), mime: z.string().optional().describe("e.g. video/mp4 (needed for base64 input)."),
    x: z.number(), y: z.number(),
    w: z.number().positive().optional().describe("Default 640."), h: z.number().positive().optional().describe("Default 360."),
    label: z.string().optional(),
    autoplay: z.boolean().optional().describe("Start playing automatically (muted). Default false."),
    seek_to: z.number().min(0).optional().describe("Initial playhead position in seconds."),
    id: OPTIONAL_ID,
  },
}, wrap(async (a) => {
  const m = await resolveMedia({ path_or_url: a.path_or_url, base64: a.base64, mime: a.mime, kind: "video" });
  const id = a.id ?? rid("vid");
  const [op] = validate([{ type: "add_video", id, src: m.src, x: a.x, y: a.y, w: a.w, h: a.h, label: a.label, autoplay: a.autoplay, seekTo: a.seek_to }]);
  const r = await postOps([op]);
  const o = op as Extract<Op, { type: "add_video" }>;
  return `Added video id=${r.ids[0] ?? id} at (${a.x},${a.y}) size ${o.w}x${o.h}${a.seek_to != null ? ` seek_to=${a.seek_to}s` : ""}.`;
}));

server.registerTool("canvas_add_shape", {
  description:
    "Add a basic shape or text to the canvas: rectangle, ellipse, line, text (free text), or note (sticky note). Use notes for commentary and text for headings/section titles. Coordinates are canvas px, top-left origin. Returns the element id (arrows can attach to it).",
  inputSchema: {
    kind: z.enum(["rectangle", "ellipse", "line", "text", "note"]),
    x: z.number(), y: z.number(),
    w: z.number().positive().optional(), h: z.number().positive().optional(),
    text: z.string().optional().describe("Text content (for text/note, or a label inside shapes)."),
    color: COLOR.optional(),
    id: OPTIONAL_ID,
  },
}, wrap(async (a) => {
  const id = a.id ?? rid(a.kind);
  const [op] = validate([{ type: "add_shape", id, kind: a.kind, x: a.x, y: a.y, w: a.w, h: a.h, text: a.text, color: a.color }]);
  const r = await postOps([op]);
  return `Added ${a.kind} id=${r.ids[0] ?? id} at (${a.x},${a.y}).`;
}));

server.registerTool("canvas_add_arrow", {
  description:
    "Draw an arrow connecting two existing elements by id (screenshots, notes, shapes, findings). The arrow stays attached when they move. Use it to show navigation flow between screens (e.g. Login -> Home), or from a finding card to the screenshot it concerns. `from` and `to` must already exist on the canvas.",
  inputSchema: {
    from: idArg.describe("Id of the source element."),
    to: idArg.describe("Id of the target element."),
    label: z.string().optional().describe("Text on the arrow, e.g. the action taken: 'tap Sign in'."),
    color: COLOR.optional(),
    id: OPTIONAL_ID,
  },
}, wrap(async (a) => {
  const id = a.id ?? rid("arrow");
  const [op] = validate([{ type: "add_arrow", id, from: a.from, to: a.to, label: a.label, color: a.color }]);
  const r = await postOps([op]);
  return `Added arrow id=${r.ids[0] ?? id} from ${a.from} to ${a.to}.`;
}));

server.registerTool("canvas_annotate", {
  description:
    "Draw a highlight box on a screenshot or video to point at a specific UI region (a bug, a notable control, a competitor's pattern). The box is given as FRACTIONS (0..1) of the target element, origin top-left, so it survives resizing. How to compute it from a screenshot you can see: measure the region in the screenshot's own pixels (px_x, px_y, px_w, px_h) and the screenshot's full size (W x H), then x=px_x/W, y=px_y/H, w=px_w/W, h=px_h/H. Example: a 200x48 button whose top-left is at (120,640) in a 390x844 screenshot -> {x:0.31, y:0.76, w:0.51, h:0.057}. x+w and y+h must be <= 1. Estimate generously rather than tightly. Severity colors the box (critical/high=red, medium=orange, low=yellow, info=blue).",
  inputSchema: {
    target: idArg.describe("Id of the screenshot/video to annotate."),
    box: z.object({
      x: z.number().min(0).max(1).describe("Left edge, fraction of target width."),
      y: z.number().min(0).max(1).describe("Top edge, fraction of target height."),
      w: z.number().min(0).max(1).describe("Width, fraction of target width."),
      h: z.number().min(0).max(1).describe("Height, fraction of target height."),
    }),
    label: z.string().optional().describe("Short callout text shown by the box."),
    severity: SEVERITY.default("medium"),
    id: OPTIONAL_ID,
  },
}, wrap(async (a) => {
  if (a.box.x + a.box.w > 1.001 || a.box.y + a.box.h > 1.001) throw new CanvasError(`box extends outside the target: x+w=${(a.box.x + a.box.w).toFixed(3)}, y+h=${(a.box.y + a.box.h).toFixed(3)} (both must be <= 1). Values are fractions of the target, not pixels.`);
  const id = a.id ?? rid("ann");
  const [op] = validate([{ type: "annotate", id, target: a.target, box: a.box, label: a.label, severity: a.severity }]);
  const r = await postOps([op]);
  return `Added ${a.severity} annotation id=${r.ids[0] ?? id} on ${a.target}.`;
}));

server.registerTool("canvas_add_finding", {
  description:
    "Add a finding card (a structured bug/UX issue) to the canvas: title, severity, expected vs actual, and whether it was verified by reproducing it. Optionally link it to the screenshot/video (target) and the video timestamp in seconds. Place the card near its screenshot (e.g. to its right or below) and follow with canvas_add_arrow from the card to the target if layout is not obvious. Returns the card id.",
  inputSchema: {
    x: z.number(), y: z.number(),
    title: z.string().describe("One-line summary, e.g. 'Checkout button unresponsive on second tap'."),
    severity: SEVERITY,
    expected: z.string().optional(), actual: z.string().optional(),
    verified: z.boolean().optional().describe("true only if you reproduced it. Default false."),
    target: idArg.optional().describe("Id of the screenshot/video this finding is about."),
    timestamp: z.number().min(0).optional().describe("Seconds into the target video."),
    id: OPTIONAL_ID,
  },
}, wrap(async (a) => {
  const id = a.id ?? rid("finding");
  const [op] = validate([{ type: "add_finding", id, x: a.x, y: a.y, title: a.title, severity: a.severity, expected: a.expected, actual: a.actual, verified: a.verified, target: a.target, timestamp: a.timestamp }]);
  const r = await postOps([op]);
  return `Added ${a.severity} finding id=${r.ids[0] ?? id} "${a.title}" at (${a.x},${a.y}).`;
}));

server.registerTool("canvas_move", {
  description: "Move an existing element so its top-left corner is at canvas (x,y). Arrows attached to it follow.",
  inputSchema: { id: idArg, x: z.number(), y: z.number() },
}, wrap(async (a) => {
  await postOps(validate([{ type: "move", id: a.id, x: a.x, y: a.y }]));
  return `Moved ${a.id} to (${a.x},${a.y}).`;
}));

server.registerTool("canvas_update", {
  description: "Update properties of an existing element by id, e.g. {label:'New caption'}, {text:'...'}, {w:600,h:400}, {color:'red'}, {severity:'high'}, {verified:true}. Property names mirror the add_* tool fields.",
  inputSchema: { id: idArg, props: z.record(z.string(), z.unknown()).describe("Properties to merge into the element.") },
}, wrap(async (a) => {
  await postOps(validate([{ type: "update", id: a.id, props: a.props }]));
  return `Updated ${a.id}: ${Object.keys(a.props).join(", ")}.`;
}));

server.registerTool("canvas_delete", {
  description: "Delete an element by id (attached arrows/annotations go with it).",
  inputSchema: { id: idArg },
}, wrap(async (a) => {
  await postOps(validate([{ type: "delete", id: a.id }]));
  return `Deleted ${a.id}.`;
}));

server.registerTool("canvas_focus", {
  description: "Pan/zoom the human's viewport to show specific elements (ids) or a canvas-pixel box. Call this at the end of a build, or when you want the human to look at a particular finding.",
  inputSchema: {
    ids: z.array(idArg).optional().describe("Elements to bring into view."),
    box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional().describe("Canvas-pixel rectangle to show (alternative to ids)."),
  },
}, wrap(async (a) => {
  if (!a.ids?.length && !a.box) throw new CanvasError("Provide ids or box.");
  await postOps(validate([{ type: "focus", ids: a.ids?.length ? a.ids : undefined, box: a.box }]));
  return a.ids?.length ? `Focused on ${a.ids.join(", ")}.` : `Focused on box (${a.box!.x},${a.box!.y}) ${a.box!.w}x${a.box!.h}.`;
}));

server.registerTool("canvas_cursor", {
  description:
    "Move your avatar (an orange Ignura cursor with a name tag) to a spot on the board so the human can see where you are looking. It glides there. Adding or editing elements already moves it automatically, so use this to point at something you have NOT changed (e.g. 'checking this button next'), or to set the name tag with `label`. Canvas pixels, top-left origin.",
  inputSchema: {
    x: z.number().describe("Canvas x to glide to."),
    y: z.number().describe("Canvas y to glide to."),
    label: z.string().max(40).optional().describe("Name tag next to the cursor, e.g. 'Iggy' or 'QA agent'. Sticks until changed."),
  },
}, wrap(async (a) => {
  await postOps(validate([{ type: "cursor", x: a.x, y: a.y, label: a.label }]));
  return `Cursor moved to (${a.x},${a.y})${a.label ? ` as "${a.label}"` : ""}.`;
}));

server.registerTool("canvas_say", {
  description:
    "Leave a speech bubble (a caption in your own voice) on the board: a short remark, a question for the human, or context for a finding. It stays on the canvas, shows in screenshots/exports, and your cursor glides to it. Pass `target` (an element id) to hang it off that element's top-right corner, OR x/y for an absolute spot (the bubble's tail points at x,y). With neither it appears beside your last cursor position. Keep it to a sentence or two.",
  inputSchema: {
    text: z.string().min(1).max(600).describe("What you want to say. Plain text."),
    target: idArg.optional().describe("Id of an existing element to attach the bubble to."),
    x: z.number().optional().describe("Canvas x the bubble's tail points at (when no target)."),
    y: z.number().optional().describe("Canvas y the bubble's tail points at (when no target)."),
    id: OPTIONAL_ID,
  },
}, wrap(async (a) => {
  const id = a.id ?? rid("say");
  const [op] = validate([{ type: "say", id, text: a.text, target: a.target, x: a.x, y: a.y }]);
  const r = await postOps([op]);
  return `Said it (id=${r.ids[0] ?? id})${a.target ? ` next to ${a.target}` : a.x != null ? ` at (${a.x},${a.y})` : ""}.`;
}));

server.registerTool("canvas_clear", {
  description: "Delete EVERYTHING on the canvas and reset the log. Destructive; only use to start a fresh board.",
  inputSchema: {},
}, wrap(async () => {
  await http("/api/state", { method: "DELETE" });
  return "Canvas cleared.";
}));

server.registerTool("canvas_get_state", {
  description:
    "Read the canvas as a compact list: every element's id, type, position (top-left), size, label and key properties, plus the overall bounding box and the next free x to the right. Derived from the op log. Use it before laying things out, to find ids, or to avoid overlapping existing content. Image/video sizes marked 'estimated' were not specified explicitly when added.",
  inputSchema: { include_annotations: z.boolean().optional().describe("Include arrows/annotations/findings (default true). Set false to list only placed media and shapes.") },
}, wrap(async (a) => {
  const { seq, els } = await replay();
  const all = [...els.values()];
  const list = a.include_annotations === false ? all.filter((e) => !["arrow", "annotation"].includes(e.type)) : all;
  if (!all.length) return `Canvas is empty (seq ${seq}). Free to start at (0,0).`;
  const placed = all.filter((e) => e.x != null);
  const minX = Math.min(...placed.map((e) => e.x!)), minY = Math.min(...placed.map((e) => e.y!));
  const maxX = Math.max(...placed.map((e) => e.x! + (e.w ?? 0))), maxY = Math.max(...placed.map((e) => e.y! + (e.h ?? 0)));
  const counts = Object.entries(all.reduce<Record<string, number>>((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {})).map(([k, v]) => `${v} ${k}`).join(", ");
  return [
    `Canvas seq ${seq}: ${counts}.`,
    placed.length ? `Bounds: x ${r0(minX)}..${r0(maxX)}, y ${r0(minY)}..${r0(maxY)}. Next free x to the right: ${r0(maxX + 160)}; next free y below: ${r0(maxY + 160)}.` : "",
    ...list.map(describe),
  ].filter(Boolean).join("\n");
}));

server.registerTool("canvas_layout_flow", {
  description:
    "Convenience layout for a user flow: take existing screenshot/video ids IN ORDER, line them up left-to-right (or top-down) with an even gap, and connect consecutive ones with arrows. Emits move + add_arrow ops in one call. Sizes come from the canvas state (falls back to 640x400 if unknown). Default start is the position of the first element. Use arrow_labels (length = ids.length-1) to caption the transitions.",
  inputSchema: {
    ids: z.array(idArg).min(1).describe("Existing element ids in flow order."),
    start_x: z.number().optional().describe("x of the first element (default: its current x)."),
    start_y: z.number().optional().describe("y of the first element (default: its current y)."),
    gap: z.number().min(0).optional().describe("Space between elements in px (default 160, leaves room for arrow labels)."),
    direction: z.enum(["right", "down"]).optional().describe("Default 'right'."),
    arrow_labels: z.array(z.string()).optional().describe("Optional label per arrow, in order."),
    arrows: z.boolean().optional().describe("Add arrows between consecutive elements (default true)."),
  },
}, wrap(async (a) => {
  const { els } = await replay();
  const items = a.ids.map((id) => {
    const e = els.get(id);
    if (!e) throw new CanvasError(`Unknown id "${id}". Call canvas_get_state to list ids.`);
    if (e.x == null) throw new CanvasError(`"${id}" is a ${e.type}, which has no position; pass screenshots/videos/shapes.`);
    return e;
  });
  const gap = a.gap ?? 160, dir = a.direction ?? "right";
  let x = a.start_x ?? items[0].x!, y = a.start_y ?? items[0].y!;
  const ops: unknown[] = [];
  const centerline = dir === "right" ? y : x; // keep cross-axis aligned
  items.forEach((e, i) => {
    const w = e.w ?? FALLBACK.w, h = e.h ?? FALLBACK.h;
    ops.push({ type: "move", id: e.id, x: dir === "right" ? x : centerline, y: dir === "right" ? centerline : y });
    if (dir === "right") x += w + gap; else y += h + gap;
    if (a.arrows !== false && i > 0) ops.push({ type: "add_arrow", id: rid("arrow"), from: items[i - 1].id, to: e.id, label: a.arrow_labels?.[i - 1] });
  });
  const r = await postOps(validate(ops));
  const arrowIds = (ops as any[]).filter((o) => o.type === "add_arrow").map((o) => o.id);
  return `Laid out ${items.length} elements ${dir === "right" ? "left-to-right" : "top-down"} with gap ${gap}${arrowIds.length ? `; arrows: ${arrowIds.join(", ")}` : ""}. Posted ${r.seqs.length || ops.length} ops.`;
}));

server.registerTool("canvas_batch", {
  description:
    "Post several raw ops in one call (validated against the canvas op schema). Op shapes: add_image{id?,src,x,y,w?,h?,label?,step?} | add_video{id?,src,x,y,w?,h?,label?,autoplay?,seekTo?} | add_shape{id?,kind:rectangle|ellipse|line|text|note,x,y,w?,h?,text?,color?} | add_arrow{id?,from,to,label?,color?} | annotate{id?,target,box:{x,y,w,h in 0..1},label?,severity} | add_finding{id?,x,y,title,severity,expected?,actual?,verified?,target?,timestamp?} | update{id,props} | move{id,x,y} | delete{id} | focus{ids?|box?} | cursor{x,y,label?} | say{id?,text,target?|x?,y?} | clear{}. Give your own ids to ops that later ops reference (e.g. arrows). Note add_image here takes an already-hosted src URL (use canvas_add_screenshot to upload local files). Ops apply in order.",
  inputSchema: { ops: z.array(z.record(z.string(), z.unknown())).min(1).describe("Array of op objects, each with a `type`.") },
}, wrap(async (a) => {
  const ops = validate(a.ops);
  const r = await postOps(ops);
  return `Posted ${ops.length} ops (seqs ${r.seqs.join(",") || "n/a"}). Ids: ${r.ids.join(", ") || "n/a"}.`;
}));

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`astrahack-canvas MCP server ready (canvas: ${BASE})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
