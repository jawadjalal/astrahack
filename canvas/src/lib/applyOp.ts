import {
  AssetRecordType,
  Box,
  createShapeId,
  toRichText,
  type Editor,
  type TLShapeId,
  type TLShapePartial,
} from "tldraw";
import type { Envelope, Op } from "./ops";
import { withBase } from "./base";
import { applyCustomOp, noteAgentSpot } from "../components/shapes";
import { applyMarkupOp, isMarkupCreate, isMarkupOp } from "./markup";
import { agentBus } from "./agentBus";
import { animateIn } from "./enterAnim";
import { fitAll, fitBox } from "./fit";

export type ApplyOptions = {
  /** Move the camera to newly added shapes. */
  follow?: boolean;
  /** Play entrance animations and glide the agent avatar (skipped for bulk replay). */
  animate?: boolean;
};

const FOCUS_MS = 400;

const sid = (id: string) => createShapeId(id);
const labelId = (id: string) => createShapeId(`${id}:label`);
const stepId = (id: string) => createShapeId(`${id}:step`);

function opKey(op: Op, seq: number): string {
  return ("id" in op && op.id) || `op${seq}`;
}

function loadImageSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new window.Image();
    const t = setTimeout(() => resolve({ w: 800, h: 600 }), 6000);
    img.onload = () => {
      clearTimeout(t);
      resolve({ w: img.naturalWidth || 800, h: img.naturalHeight || 600 });
    };
    img.onerror = () => {
      clearTimeout(t);
      resolve({ w: 800, h: 600 });
    };
    img.src = src;
  });
}

function boundsOf(editor: Editor, ids: TLShapeId[]): Box | null {
  let box: Box | null = null;
  for (const id of ids) {
    const b = editor.getShapePageBounds(id);
    if (!b) continue;
    box = box ? Box.Common([box, b]) : b.clone();
  }
  return box;
}

function zoomTo(editor: Editor, box: Box, maxZoom: number) {
  fitBox(editor, box, { maxZoom, duration: FOCUS_MS, pad: 60 });
}

type PropsRecord = Record<string, unknown>;

async function applyCore(editor: Editor, op: Op, seq: number, animateCursor: boolean): Promise<"custom" | null> {
  switch (op.type) {
    case "add_image": {
      const key = opKey(op, seq);
      const id = sid(key);
      if (editor.getShape(id)) return null;
      const src = withBase(op.src);
      let { w, h } = op;
      const nat = await loadImageSize(src);
      const natW = nat.w;
      const natH = nat.h;
      if (!w || !h) {
        if (w && !h) h = (w * nat.h) / nat.w;
        else if (h && !w) w = (h * nat.w) / nat.h;
        else {
          const scale = Math.min(1, 900 / nat.w);
          w = nat.w * scale;
          h = nat.h * scale;
        }
      }
      if (editor.getShape(id)) return null; // raced while loading
      const assetId = AssetRecordType.createId();
      editor.createAssets([
        {
          id: assetId,
          type: "image",
          typeName: "asset",
          props: {
            name: op.label ?? key,
            src,
            w: natW,
            h: natH,
            mimeType: null,
            isAnimated: /\.gif($|\?)/i.test(src),
          },
          meta: {},
        },
      ]);
      editor.createShape({
        id,
        type: "image",
        x: op.x,
        y: op.y,
        props: { w: w!, h: h!, assetId },
      });
      let labelX = op.x;
      if (op.step != null) {
        // butter step badge, hand-drawn edge, pixel type
        editor.createShape({
          id: stepId(key),
          type: "geo",
          x: op.x,
          y: op.y - 46,
          props: {
            geo: "rectangle",
            w: 124,
            h: 36,
            fill: "solid",
            color: "yellow",
            dash: "draw",
            font: "mono",
            size: "s",
            richText: toRichText(`Step ${op.step}`),
          },
        });
        labelX = op.x + 136;
      }
      if (op.label) {
        editor.createShape({
          id: labelId(key),
          type: "text",
          x: labelX,
          y: op.y - (op.step != null ? 46 : 40),
          props: { richText: toRichText(op.label), size: "l", font: "draw", autoSize: true },
        });
      }
      return null;
    }

    case "add_shape": {
      const key = opKey(op, seq);
      const id = sid(key);
      if (editor.getShape(id)) return null;
      const color = op.color ?? "black";
      const w = op.w ?? (op.kind === "note" ? 200 : 160);
      const h = op.h ?? (op.kind === "note" ? 200 : 100);
      if (op.kind === "rectangle" || op.kind === "ellipse") {
        editor.createShape({
          id,
          type: "geo",
          x: op.x,
          y: op.y,
          props: { geo: op.kind, w, h, color, richText: toRichText(op.text ?? "") },
        });
      } else if (op.kind === "line") {
        editor.createShape({
          id,
          type: "line",
          x: op.x,
          y: op.y,
          props: {
            color,
            points: {
              a1: { id: "a1", index: "a1", x: 0, y: 0 },
              a2: { id: "a2", index: "a2", x: op.w ?? 200, y: op.h ?? 0 },
            },
          },
        } as unknown as TLShapePartial);
      } else if (op.kind === "text") {
        editor.createShape({
          id,
          type: "text",
          x: op.x,
          y: op.y,
          props: {
            color,
            richText: toRichText(op.text ?? ""),
            size: "m",
            ...(op.w ? { w: op.w, autoSize: false } : { autoSize: true }),
          },
        });
      } else {
        editor.createShape({
          id,
          type: "note",
          x: op.x,
          y: op.y,
          props: { color: color === "black" ? "yellow" : color, richText: toRichText(op.text ?? "") },
        });
      }
      return null;
    }

    case "add_arrow": {
      const id = sid(opKey(op, seq));
      if (editor.getShape(id)) return null;
      const fromId = sid(op.from);
      const toId = sid(op.to);
      const fromBounds = editor.getShapePageBounds(fromId);
      const toBounds = editor.getShapePageBounds(toId);
      if (!fromBounds || !toBounds) {
        console.warn("[canvas] add_arrow: missing endpoint", op.from, op.to);
        return null;
      }
      const a = fromBounds.center;
      const b = toBounds.center;
      editor.createShape({
        id,
        type: "arrow",
        x: 0,
        y: 0,
        props: {
          start: { x: a.x, y: a.y },
          end: { x: b.x, y: b.y },
          color: op.color ?? "black",
          ...(op.label ? { richText: toRichText(op.label) } : {}),
        },
      });
      const binding = (terminal: "start" | "end", toShapeId: TLShapeId) => ({
        type: "arrow" as const,
        fromId: id,
        toId: toShapeId,
        props: {
          terminal,
          normalizedAnchor: { x: 0.5, y: 0.5 },
          isExact: false,
          isPrecise: false,
          snap: "none" as const,
        },
      });
      editor.createBindings([binding("start", fromId), binding("end", toId)]);
      return null;
    }

    case "update": {
      const id = sid(op.id);
      const shape = editor.getShape(id);
      if (!shape) return null;
      const { x, y, w, h, text, color, ...rest } = op.props as PropsRecord;
      const props: PropsRecord = { ...rest };
      const sp = shape.props as PropsRecord;
      if (w !== undefined && "w" in sp) props.w = w;
      if (h !== undefined && "h" in sp) props.h = h;
      if (text !== undefined) {
        if ("richText" in sp) props.richText = toRichText(String(text));
        else if ("text" in sp) props.text = String(text);
      }
      if (color !== undefined && "color" in sp) props.color = color;
      const partial: PropsRecord = { id, type: shape.type, props };
      if (typeof x === "number") partial.x = x;
      if (typeof y === "number") partial.y = y;
      editor.updateShape(partial as TLShapePartial);
      return null;
    }

    case "move": {
      const id = sid(op.id);
      const shape = editor.getShape(id);
      if (!shape) return null;
      const dx = op.x - shape.x;
      const dy = op.y - shape.y;
      const partials: TLShapePartial[] = [{ id, type: shape.type, x: op.x, y: op.y }];
      for (const cid of [labelId(op.id), stepId(op.id)]) {
        const c = editor.getShape(cid);
        if (c) partials.push({ id: cid, type: c.type, x: c.x + dx, y: c.y + dy });
      }
      editor.updateShapes(partials);
      return null;
    }

    case "delete": {
      const ids = [sid(op.id), labelId(op.id), stepId(op.id)].filter((i) => editor.getShape(i));
      if (ids.length) editor.deleteShapes(ids);
      return null;
    }

    case "clear": {
      const ids = [...editor.getCurrentPageShapeIds()];
      if (ids.length) editor.deleteShapes(ids);
      return null;
    }

    case "cursor": {
      noteAgentSpot(op.x, op.y);
      agentBus.moveTo(op.x, op.y, { label: op.label, instant: !animateCursor });
      return null;
    }

    case "focus": {
      let box: Box | null = null;
      if (op.ids?.length) box = boundsOf(editor, op.ids.map(sid));
      else if (op.box) box = new Box(op.box.x, op.box.y, op.box.w, op.box.h);
      if (box) zoomTo(editor, box, 1.5);
      else fitAll(editor, { duration: FOCUS_MS });
      return null;
    }

    default:
      return "custom";
  }
}

const DOING: Partial<Record<Op["type"], string>> = {
  add_image: "adding a screenshot",
  add_video: "adding a video",
  add_shape: "sketching",
  add_arrow: "connecting",
  annotate: "marking this",
  add_finding: "flagging",
  say: "talking",
  move: "moving",
  update: "editing",
  draw: "drawing",
  arrow_to: "pointing",
  highlight: "highlighting",
  add_text: "writing",
};

/** Page point the agent avatar should glide to for an op (null = leave it where it is). */
function agentSpot(editor: Editor, op: Op, seq: number, added: TLShapeId[]): { x: number; y: number; doing?: string } | null {
  const doing = DOING[op.type];
  switch (op.type) {
    case "cursor":
    case "focus":
    case "clear":
    case "delete":
      return null;
    case "add_arrow": {
      const b = boundsOf(editor, [sid(op.from), sid(op.to)]);
      return b ? { x: b.center.x, y: b.center.y, doing } : null;
    }
    case "say": {
      const s = editor.getShape(sid(("id" in op && op.id) || `op${seq}`)) as unknown as { x: number; y: number; props: { tipX: number; tipY: number } } | undefined;
      return s ? { x: s.x + s.props.tipX, y: s.y + s.props.tipY, doing } : null;
    }
    case "annotate": {
      const b = boundsOf(editor, added.filter((i) => editor.getShape(i)?.type === "annotation"));
      return b ? { x: b.x + b.w * 0.5, y: b.y + b.h * 0.5, doing } : null;
    }
    case "move":
    case "update": {
      const b = boundsOf(editor, [sid(op.id)]);
      return b ? { x: b.x + 28, y: b.y + 28, doing } : null;
    }
    default: {
      // the main shape of an add_* op = the one whose id matches the op key
      const main = sid(opKey(op, seq));
      const b = editor.getShapePageBounds(main) ?? boundsOf(editor, added);
      return b ? { x: b.x + Math.min(40, b.w * 0.25), y: b.y + Math.min(40, b.h * 0.2), doing } : null;
    }
  }
}

/**
 * Apply one envelope to the editor. Callers must serialize calls (add_image is async).
 * Idempotent by shape id; seq dedupe is handled by the caller.
 */
export async function applyEnvelope(
  editor: Editor,
  env: Envelope,
  { follow = true, animate = true }: ApplyOptions = {},
): Promise<void> {
  const op = env.op;
  // programmatic edits are blocked while readonly (Present mode): lift it for the duration
  const wasReadonly = editor.getIsReadonly();
  if (wasReadonly) editor.updateInstanceState({ isReadonly: false });
  try {
    const before = new Set(editor.getCurrentPageShapeIds());
    // Agent ops bypass shape locks (locking protects finished work from human edits, not from the
    // agent that owns the board). Everything but add_image runs synchronously inside this call.
    let result: "custom" | null = null;
    let noFade = new Set<TLShapeId>();
    if (isMarkupOp(op)) {
      let pending!: ReturnType<typeof applyMarkupOp>;
      editor.run(() => { pending = applyMarkupOp(editor, op, env.seq, { animate }); }, { ignoreShapeLock: true });
      noFade = new Set((await pending).noFade);
    } else {
      let pending!: ReturnType<typeof applyCore>;
      editor.run(() => { pending = applyCore(editor, op, env.seq, animate); }, { ignoreShapeLock: true });
      result = await pending;
    }

    if (result === "custom") {
      let handled = false;
      editor.run(() => {
        handled = applyCustomOp(editor, op);
      });
      if (!handled) console.warn("[canvas] unhandled op", op.type);
    }

    const added = [...editor.getCurrentPageShapeIds()].filter((i) => !before.has(i));

    // The agent's avatar glides to whatever it just touched; the element settles in as it arrives.
    const spot = agentSpot(editor, op, env.seq, added);
    if (spot) {
      noteAgentSpot(spot.x, spot.y);
      agentBus.moveTo(spot.x, spot.y, { instant: !animate, doing: spot.doing });
    }
    const fading = added.filter((i) => !noFade.has(i));
    if (fading.length && animate) animateIn(editor, fading, 160);

    if (follow && isMarkupOp(op)) {
      // marks land on a screenshot the human is already looking at: only pan if the mark is off-screen
      const mark = isMarkupCreate(op) && added.length ? boundsOf(editor, added) : null;
      if (mark && !editor.getViewportPageBounds().contains(mark)) zoomTo(editor, mark, 1);
    } else if (follow && op.type !== "focus" && op.type !== "clear" && op.type !== "delete") {
      let target: Box | null = null;
      if (op.type === "add_arrow") target = boundsOf(editor, [sid(op.from), sid(op.to)]);
      else if (added.length) target = boundsOf(editor, added);
      else if (op.type === "update" || op.type === "move") target = boundsOf(editor, [sid(op.id)]);
      if (target) zoomTo(editor, target, 1);
    }
  } finally {
    if (wasReadonly) editor.updateInstanceState({ isReadonly: true });
  }
}
