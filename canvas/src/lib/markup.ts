import {
  b64Vecs,
  createShapeId,
  toRichText,
  type Editor,
  type TLShape,
  type TLShapeId,
  type TLShapePartial,
} from "tldraw";
import type { Op } from "./ops";
import type { HiliteShape } from "../components/shapes/HiliteShape";

// Applier for the markup ops (draw, arrow_to, highlight, add_text, group, lock, order).
// Kept out of applyOp.ts so the contract and the core applier stay small; applyOp.ts only routes here.

type DrawOp = Extract<Op, { type: "draw" }>;
type ArrowToOp = Extract<Op, { type: "arrow_to" }>;
type HighlightOp = Extract<Op, { type: "highlight" }>;
type AddTextOp = Extract<Op, { type: "add_text" }>;
type GroupOp = Extract<Op, { type: "group" }>;
type LockOp = Extract<Op, { type: "lock" }>;
type OrderOp = Extract<Op, { type: "order" }>;
export type MarkupOp = DrawOp | ArrowToOp | HighlightOp | AddTextOp | GroupOp | LockOp | OrderOp;

const MARKUP_TYPES = new Set(["draw", "arrow_to", "highlight", "add_text", "group", "lock", "order"]);
export const isMarkupOp = (op: Op): op is MarkupOp => MARKUP_TYPES.has(op.type);

/** Ops that create visible things (the rest only edit). */
export const isMarkupCreate = (op: Op) => ["draw", "arrow_to", "highlight", "add_text"].includes(op.type);

export type MarkupContext = {
  /** Draw strokes in progressively (false during bulk replay). */
  animate: boolean;
};
export type MarkupResult = {
  /** Shapes that must not be faded in (they animate themselves). */
  noFade: TLShapeId[];
};

type Pt = { x: number; y: number };

const sid = (id: string) => createShapeId(id);
const keyOf = (op: { id?: string }, seq: number) => op.id || `op${seq}`;
const warn = (...a: unknown[]) => console.warn("[canvas] markup:", ...a);

// ---------- geometry helpers ----------

/** A spot on a target element's page bounds (fx,fy fractions), or null if the target is missing. */
function spot(editor: Editor, target: string, fx: number, fy: number): Pt | null {
  const b = editor.getShapePageBounds(sid(target));
  if (!b) return null;
  return { x: b.x + fx * b.w, y: b.y + fy * b.h };
}

/** Insert Catmull-Rom points so sparse agent paths (an 8-point "circle") render as smooth curves. */
export function densify(pts: Pt[], step = 7, cap = 1500): Pt[] {
  if (pts.length < 2) return pts;
  const out: Pt[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    let k = Math.max(1, Math.ceil(dist / step));
    if (out.length + k > cap) k = 1;
    for (let j = 1; j <= k; j++) {
      const t = j / k;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push(j === k ? p2 : { x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  return out;
}

const pathLength = (pts: Pt[]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Point in a shape's parent space for a page-space point (parent may be a group). */
function toParent(editor: Editor, shape: TLShape, p: Pt): Pt {
  return editor.getPointInParentSpace(shape, p);
}

// ---------- side effects: attachments + highlight reflow ----------
// A shape with meta.attachTo = <shape id> moves with that shape. A `hilite` re-derives its box from
// its target's bounds whenever the target moves or resizes. Anything attached/highlighting a deleted
// target is deleted with it.

const wired = new WeakSet<Editor>();
let attachCount = 0; // skip the scan entirely until the first attachment exists

const attachedTo = (s: TLShape): string | undefined => {
  const v = (s.meta as Record<string, unknown> | undefined)?.attachTo;
  return typeof v === "string" ? v : undefined;
};

function ensureSideEffects(editor: Editor) {
  if (wired.has(editor)) return;
  wired.add(editor);

  editor.sideEffects.registerAfterChangeHandler("shape", (prev, next) => {
    if (!attachCount) return;
    const moved = prev.x !== next.x || prev.y !== next.y;
    const pp = prev.props as Record<string, unknown>;
    const np = next.props as Record<string, unknown>;
    const resized = pp.w !== np.w || pp.h !== np.h || prev.rotation !== next.rotation;
    if (!moved && !resized) return;
    const selected = editor.getSelectedShapeIds();
    const follow: TLShapePartial[] = [];
    const reflow: HiliteShape[] = [];
    for (const s of editor.getCurrentPageShapes()) {
      if (s.type === "hilite") {
        if ((s as HiliteShape).props.targetId === next.id) reflow.push(s as HiliteShape);
      } else if (moved && attachedTo(s) === next.id.replace(/^shape:/, "")) {
        // a human dragging a selection moves both already; don't double-apply
        if (selected.includes(s.id) && selected.includes(next.id)) continue;
        follow.push({ id: s.id, type: s.type, x: s.x + (next.x - prev.x), y: s.y + (next.y - prev.y) });
      }
    }
    if (follow.length) editor.updateShapes(follow);
    for (const h of reflow) reflowHilite(editor, h);
  });

  editor.sideEffects.registerAfterDeleteHandler("shape", (shape) => {
    if (!attachCount) return;
    const rawId = shape.id.replace(/^shape:/, "");
    const dead: TLShapeId[] = [];
    for (const s of editor.getCurrentPageShapes()) {
      if (attachedTo(s) === rawId || (s.type === "hilite" && (s as HiliteShape).props.targetId === shape.id)) dead.push(s.id);
    }
    if (!dead.length) return;
    queueMicrotask(() => {
      const live = dead.filter((i) => editor.getShape(i));
      if (live.length) editor.run(() => editor.deleteShapes(live), { ignoreShapeLock: true });
    });
  });
}

function reflowHilite(editor: Editor, h: HiliteShape) {
  const b = editor.getShapePageBounds(h.props.targetId as TLShapeId);
  if (!b) return;
  const { bx, by, bw, bh } = h.props;
  const w = Math.max(2, bw * b.w);
  const hh = Math.max(2, bh * b.h);
  const p = toParent(editor, h, { x: b.x + bx * b.w, y: b.y + by * b.h });
  if (Math.abs(h.x - p.x) < 0.5 && Math.abs(h.y - p.y) < 0.5 && Math.abs(h.props.w - w) < 0.5 && Math.abs(h.props.h - hh) < 0.5) return;
  editor.updateShape({ id: h.id, type: "hilite", x: p.x, y: p.y, props: { w, h: hh } });
}

const attach = (target: string | undefined) => {
  if (!target) return undefined;
  attachCount++;
  return { attachTo: target };
};

// ---------- ops ----------

async function applyDraw(editor: Editor, op: DrawOp, key: string, ctx: MarkupContext): Promise<MarkupResult> {
  const none: MarkupResult = { noFade: [] };
  const id = sid(key);
  if (editor.getShape(id)) return none;

  let pts: Pt[] = op.points;
  if (op.space === "target") {
    if (!op.target) return warn("draw: space 'target' needs a target"), none;
    const mapped = op.points.map((p) => spot(editor, op.target!, p.x, p.y));
    if (mapped.some((p) => !p)) return warn("draw: missing target", op.target), none;
    pts = mapped as Pt[];
  }
  pts = densify(pts);
  const origin = pts[0];
  const rel = pts.map((p) => ({ x: p.x - origin.x, y: p.y - origin.y, z: 0.5 }));
  const highlighter = op.style === "highlighter";
  const type = highlighter ? "highlight" : "draw";
  const props = {
    color: op.color ?? (highlighter ? "yellow" : "red"),
    size: op.size ?? "m",
  };
  const seg = (n: number) => [{ type: "free" as const, path: b64Vecs.encodePoints(rel.slice(0, n)) }];
  const animated = ctx.animate && op.animate === true && rel.length > 3;

  editor.createShape({
    id,
    type,
    x: origin.x,
    y: origin.y,
    parentId: editor.getCurrentPageId(),
    meta: attach(op.target) ?? {},
    props: { ...props, segments: seg(animated ? 2 : rel.length), isComplete: !animated, isPen: false },
  } as unknown as TLShapePartial);
  if (!animated) return none;

  // Progressive reveal, serialised in the op chain so consecutive strokes draw one after another.
  // Timer-driven (not rAF) so a backgrounded tab cannot stall the chain.
  const dur = Math.max(300, Math.min(2200, pathLength(pts) / 0.9));
  const t0 = performance.now();
  for (;;) {
    await sleep(16);
    if (!editor.getShape(id)) return { noFade: [id] };
    const t = Math.min(1, (performance.now() - t0) / dur);
    const n = Math.max(2, Math.ceil(t * rel.length));
    editor.run(
      () => editor.updateShape({ id, type, props: { segments: seg(n), isComplete: t >= 1 } } as unknown as TLShapePartial),
      { history: "ignore", ignoreShapeLock: true },
    );
    if (t >= 1) break;
  }
  return { noFade: [id] };
}

type Resolved = { point: Pt; bind?: { id: TLShapeId; anchor: Pt; precise: boolean }; ref?: string };

function resolveEndpoint(editor: Editor, e: ArrowToOp["from"]): Resolved | null {
  if (typeof e === "string") {
    const b = editor.getShapePageBounds(sid(e));
    if (!b) return null;
    return { point: { x: b.center.x, y: b.center.y }, bind: { id: sid(e), anchor: { x: 0.5, y: 0.5 }, precise: false }, ref: e };
  }
  if ("target" in e) {
    const p = spot(editor, e.target, e.fx, e.fy);
    if (!p) return null;
    const offset = !!(e.dx || e.dy);
    const inside = e.fx >= 0 && e.fx <= 1 && e.fy >= 0 && e.fy <= 1;
    return {
      point: { x: p.x + (e.dx ?? 0), y: p.y + (e.dy ?? 0) },
      bind: offset || !inside ? undefined : { id: sid(e.target), anchor: { x: e.fx, y: e.fy }, precise: true },
      ref: e.target,
    };
  }
  return { point: { x: e.x, y: e.y } };
}

function applyArrowTo(editor: Editor, op: ArrowToOp, key: string): MarkupResult {
  const id = sid(key);
  if (editor.getShape(id)) return { noFade: [] };
  const a = resolveEndpoint(editor, op.from);
  const b = resolveEndpoint(editor, op.to);
  if (!a || !b) {
    warn("arrow_to: missing endpoint", op.from, op.to);
    return { noFade: [] };
  }
  // a free end that was placed relative to an element travels with it (bound ends are tracked by tldraw)
  const ref = op.attach ?? (!a.bind ? a.ref : undefined) ?? (!b.bind ? b.ref : undefined);
  editor.createShape({
    id,
    type: "arrow",
    x: a.point.x,
    y: a.point.y,
    parentId: editor.getCurrentPageId(),
    meta: attach(ref) ?? {},
    props: {
      kind: "arc",
      start: { x: 0, y: 0 },
      end: { x: b.point.x - a.point.x, y: b.point.y - a.point.y },
      color: op.color ?? "red",
      size: op.size ?? "m",
      bend: op.bend ?? 0,
      arrowheadStart: "none",
      arrowheadEnd: "arrow",
      ...(op.label ? { richText: toRichText(op.label) } : {}),
    },
  } as unknown as TLShapePartial);
  const bindings = (["start", "end"] as const).flatMap((terminal) => {
    const r = terminal === "start" ? a : b;
    if (!r.bind) return [];
    return [
      {
        type: "arrow" as const,
        fromId: id,
        toId: r.bind.id,
        props: { terminal, normalizedAnchor: r.bind.anchor, isExact: false, isPrecise: r.bind.precise, snap: "none" as const },
      },
    ];
  });
  if (bindings.length) editor.createBindings(bindings);
  return { noFade: [] };
}

function applyHighlight(editor: Editor, op: HighlightOp, key: string): MarkupResult {
  const id = sid(key);
  if (editor.getShape(id)) return { noFade: [] };
  const targetId = sid(op.target);
  const b = editor.getShapePageBounds(targetId);
  if (!b) {
    warn("highlight: missing target", op.target);
    return { noFade: [] };
  }
  editor.createShape({
    id,
    type: "hilite",
    x: b.x + op.box.x * b.w,
    y: b.y + op.box.y * b.h,
    parentId: editor.getCurrentPageId(),
    props: {
      w: Math.max(2, op.box.w * b.w),
      h: Math.max(2, op.box.h * b.h),
      targetId,
      bx: op.box.x,
      by: op.box.y,
      bw: op.box.w,
      bh: op.box.h,
      kind: op.kind ?? "rectangle",
      color: op.color ?? "yellow",
      alpha: op.opacity ?? 0.38,
      label: op.label ?? "",
    },
  } as unknown as TLShapePartial);
  attachCount++; // enables the reflow scan
  return { noFade: [] };
}

function applyAddText(editor: Editor, op: AddTextOp, key: string): MarkupResult {
  const id = sid(key);
  if (editor.getShape(id)) return { noFade: [] };
  let x = op.x ?? 0;
  let y = op.y ?? 0;
  let anchor: string | undefined;
  if (op.target) {
    const b = editor.getShapePageBounds(sid(op.target));
    if (b) {
      anchor = op.target;
      if (op.x == null || op.y == null) {
        const base = op.at ? { x: b.x + op.at.fx * b.w, y: b.y + op.at.fy * b.h } : { x: b.x, y: b.y };
        const off = op.offset ?? (op.at ? { x: 0, y: 0 } : { x: 0, y: -34 });
        x = base.x + off.x;
        y = base.y + off.y;
      } else {
        x = op.x + (op.offset?.x ?? 0);
        y = op.y + (op.offset?.y ?? 0);
      }
    } else {
      warn("add_text: missing target", op.target);
      if (op.x == null || op.y == null) return { noFade: [] };
    }
  } else {
    x += op.offset?.x ?? 0;
    y += op.offset?.y ?? 0;
  }
  editor.createShape({
    id,
    type: "text",
    x,
    y,
    parentId: editor.getCurrentPageId(),
    meta: attach(anchor) ?? {},
    props: {
      richText: toRichText(op.text),
      color: op.color ?? "black",
      size: op.size ?? "m",
      font: op.font ?? "draw",
      textAlign: op.align ?? "start",
      ...(op.w ? { w: op.w, autoSize: false } : { autoSize: true }),
    },
  } as unknown as TLShapePartial);
  return { noFade: [] };
}

function applyGroup(editor: Editor, op: GroupOp, key: string): MarkupResult {
  const none: MarkupResult = { noFade: [] };
  if (op.ungroup) {
    const groups = op.ids.map(sid).filter((i) => editor.getShape(i)?.type === "group");
    if (groups.length) editor.ungroupShapes(groups, { select: false });
    return none;
  }
  const id = sid(key);
  if (editor.getShape(id)) return none;
  const members = op.ids.map(sid).filter((i) => editor.getShape(i));
  if (members.length < 2) return warn("group: need at least 2 existing ids, got", members.length), none;
  editor.groupShapes(members, { groupId: id, select: false });
  if (op.label) {
    const b = editor.getShapePageBounds(id);
    if (b) {
      editor.createShape({
        id: sid(`${key}:title`),
        type: "text",
        x: b.x,
        y: b.y - 36,
        parentId: editor.getCurrentPageId(),
        meta: attach(key) ?? {},
        props: { richText: toRichText(op.label), size: "m", font: "draw", autoSize: true },
      } as unknown as TLShapePartial);
    }
  }
  return none;
}

function applyLock(editor: Editor, op: LockOp): MarkupResult {
  const partials: TLShapePartial[] = [];
  for (const raw of op.ids) {
    // an element's caption/step badge/group title are part of it
    for (const sidx of [sid(raw), sid(`${raw}:label`), sid(`${raw}:step`), sid(`${raw}:title`)]) {
      const s = editor.getShape(sidx);
      if (s) partials.push({ id: s.id, type: s.type, isLocked: op.locked } as TLShapePartial);
    }
  }
  if (partials.length) editor.updateShapes(partials);
  else warn("lock: no matching ids", op.ids);
  return { noFade: [] };
}

function applyOrder(editor: Editor, op: OrderOp): MarkupResult {
  const ids = op.ids.map(sid).filter((i) => editor.getShape(i));
  if (!ids.length) return warn("order: no matching ids", op.ids), { noFade: [] };
  if (op.to === "front") editor.bringToFront(ids);
  else if (op.to === "back") editor.sendToBack(ids);
  else if (op.to === "forward") editor.bringForward(ids);
  else editor.sendBackward(ids);
  return { noFade: [] };
}

export async function applyMarkupOp(editor: Editor, op: MarkupOp, seq: number, ctx: MarkupContext): Promise<MarkupResult> {
  ensureSideEffects(editor);
  switch (op.type) {
    case "draw":
      return applyDraw(editor, op, keyOf(op, seq), ctx);
    case "arrow_to":
      return applyArrowTo(editor, op, keyOf(op, seq));
    case "highlight":
      return applyHighlight(editor, op, keyOf(op, seq));
    case "add_text":
      return applyAddText(editor, op, keyOf(op, seq));
    case "group":
      return applyGroup(editor, op, keyOf(op, seq));
    case "lock":
      return applyLock(editor, op);
    case "order":
      return applyOrder(editor, op);
  }
}
