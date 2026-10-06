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
import { applyCustomOp } from "../components/shapes";
import { applyMarkupOp, isMarkupCreate, isMarkupOp } from "./markup";

export type ApplyOptions = {
  /** Move the camera to newly added shapes. */
  follow?: boolean;
  /** Fade new shapes in (skipped for bulk replay). */
  animate?: boolean;
};

const FOCUS_MS = 400;
const FADE_MS = 350;

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

function setOpacity(editor: Editor, ids: TLShapeId[], opacity: number | ((id: TLShapeId) => number)) {
  const partials = ids
    .map((id) => editor.getShape(id))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .map((s) => ({ id: s.id, type: s.type, opacity: typeof opacity === "function" ? opacity(s.id) : opacity }) as TLShapePartial);
  if (!partials.length) return;
  const ro = editor.getIsReadonly();
  if (ro) editor.updateInstanceState({ isReadonly: false });
  try {
    editor.run(() => editor.updateShapes(partials), { history: "ignore", ignoreShapeLock: true });
  } finally {
    if (ro) editor.updateInstanceState({ isReadonly: true });
  }
}

// `rest` = the opacity each shape had before it was faded out (translucent marks keep theirs).
function fadeIn(editor: Editor, ids: TLShapeId[], rest: Map<TLShapeId, number>) {
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.max(0, Math.min(1, (now - start) / FADE_MS));
    setOpacity(editor, ids, (id) => t * (rest.get(id) ?? 1));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
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
  editor.zoomToBounds(box, {
    animation: { duration: FOCUS_MS },
    inset: 120,
    targetZoom: maxZoom,
  });
}

type PropsRecord = Record<string, unknown>;

async function applyCore(editor: Editor, op: Op, seq: number): Promise<"custom" | null> {
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
        editor.createShape({
          id: stepId(key),
          type: "geo",
          x: op.x,
          y: op.y - 40,
          props: {
            geo: "rectangle",
            w: 96,
            h: 32,
            fill: "solid",
            color: "blue",
            size: "s",
            richText: toRichText(`Step ${op.step}`),
          },
        });
        labelX = op.x + 106;
      }
      if (op.label) {
        editor.createShape({
          id: labelId(key),
          type: "text",
          x: labelX,
          y: op.y - (op.step != null ? 38 : 36),
          props: { richText: toRichText(op.label), size: "m", autoSize: true },
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

    case "focus": {
      let box: Box | null = null;
      if (op.ids?.length) box = boundsOf(editor, op.ids.map(sid));
      else if (op.box) box = new Box(op.box.x, op.box.y, op.box.w, op.box.h);
      if (box) zoomTo(editor, box, 1.5);
      else editor.zoomToFit({ animation: { duration: FOCUS_MS } });
      return null;
    }

    default:
      return "custom";
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
      editor.run(() => { pending = applyCore(editor, op, env.seq); }, { ignoreShapeLock: true });
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
    const fading = added.filter((i) => !noFade.has(i));
    if (fading.length) {
      if (animate) {
        const rest = new Map(fading.map((i) => [i, editor.getShape(i)?.opacity ?? 1] as const));
        setOpacity(editor, fading, 0);
        fadeIn(editor, fading, rest);
      }
    }

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
