import { createBindingId, createShapeId, type Editor, type TLShapeId } from "tldraw";
import type { Op } from "@/lib/ops";
import { VideoShapeUtil, type VideoShape } from "./VideoShape";
import {
  FindingShapeUtil,
  FINDING_WIDTH,
  estimateFindingHeight,
  type FindingShape,
} from "./FindingShape";
import { AnnotationShapeUtil, boxOnTarget, reflowAnnotations, type AnnotationShape } from "./AnnotationShape";
import { SpeechShapeUtil, SPEECH_WIDTH, estimateSpeechHeight, type SpeechShape } from "./SpeechShape";
import { SEVERITY_TLDRAW_COLOR, type Severity } from "./severity";
import { HiliteShapeUtil, type HiliteShape } from "./HiliteShape";

export { VideoShapeUtil, FindingShapeUtil, AnnotationShapeUtil, SpeechShapeUtil, reflowAnnotations };
export { estimateFindingHeight, formatTimestamp } from "./FindingShape";
export type { VideoShape, FindingShape, AnnotationShape, SpeechShape };
export { HiliteShapeUtil };
export type { HiliteShape };

/** Pass to `<Tldraw shapeUtils={customShapeUtils} />`. */
export const customShapeUtils = [VideoShapeUtil, FindingShapeUtil, AnnotationShapeUtil, HiliteShapeUtil, SpeechShapeUtil];

type AnnotateOp = Extract<Op, { type: "annotate" }>;
type FindingOp = Extract<Op, { type: "add_finding" }>;

// Work waiting for a target shape that does not exist yet.
type Pending =
  | { kind: "annotate"; op: AnnotateOp; id: TLShapeId }
  | { kind: "arrow"; findingId: TLShapeId; targetId: TLShapeId; severity: Severity };

const pending: Pending[] = [];
const listening = new WeakMap<Editor, () => void>();

const CUSTOM_TYPES = new Set(["add_video", "add_finding", "annotate", "say"]);

function shapeIdFor(id: string | undefined): TLShapeId {
  return id ? createShapeId(id) : createShapeId();
}

/**
 * Apply an op if it is one of add_video / add_finding / annotate.
 * Returns true if the op type is handled here (even when it was queued or skipped as a duplicate).
 */
export function applyCustomOp(editor: Editor, op: Op): boolean {
  if (!CUSTOM_TYPES.has(op.type)) return false;
  ensureSideEffects(editor);
  switch (op.type) {
    case "add_video":
      addVideo(editor, op);
      break;
    case "add_finding":
      addFinding(editor, op);
      break;
    case "annotate":
      addAnnotation(editor, op, shapeIdFor(op.id));
      break;
    case "say":
      addSpeech(editor, op);
      break;
  }
  flushPending(editor);
  return true;
}

/** Where the agent's avatar was last parked, for `say` ops without a target or x/y. */
let lastSpot: { x: number; y: number } | null = null;
export function noteAgentSpot(x: number, y: number) {
  lastSpot = { x, y };
}

function addSpeech(editor: Editor, op: Extract<Op, { type: "say" }>) {
  const id = shapeIdFor(op.id);
  if (editor.getShape(id)) return;
  const h = estimateSpeechHeight(op.text);
  // The tail tip is the spot the agent "stands" on; the bubble floats up and to the right of it.
  let tip = { x: op.x ?? 0, y: op.y ?? 0 };
  const tb = op.target ? editor.getShapePageBounds(createShapeId(op.target)) : undefined;
  if (tb) tip = { x: tb.maxX - 44, y: tb.y + 10 };
  else if (op.x == null || op.y == null) tip = lastSpot ? { x: lastSpot.x, y: lastSpot.y } : editor.getViewportPageBounds().center;
  const bx = tip.x + 12;
  const by = tip.y - h - 26;
  editor.createShape<SpeechShape>({
    id,
    type: "speech",
    x: bx,
    y: by,
    props: { w: SPEECH_WIDTH, h, text: op.text, tipX: tip.x - bx, tipY: tip.y - by },
  });
}

function addVideo(editor: Editor, op: Extract<Op, { type: "add_video" }>) {
  const id = shapeIdFor(op.id);
  if (editor.getShape(id)) return;
  editor.createShape<VideoShape>({
    id,
    type: "video",
    x: op.x,
    y: op.y,
    props: {
      w: op.w,
      h: op.h,
      src: op.src,
      label: op.label ?? "",
      autoplay: op.autoplay,
      seekTo: op.seekTo,
    },
  });
}

function addFinding(editor: Editor, op: FindingOp) {
  const id = shapeIdFor(op.id);
  if (editor.getShape(id)) return;
  const expected = op.expected ?? "";
  const actual = op.actual ?? "";
  editor.createShape<FindingShape>({
    id,
    type: "finding",
    x: op.x,
    y: op.y,
    props: {
      w: FINDING_WIDTH,
      h: estimateFindingHeight({ title: op.title, expected, actual }),
      title: op.title,
      severity: op.severity,
      expected,
      actual,
      verified: op.verified,
      target: op.target ?? "",
      timestamp: op.timestamp,
    },
  });
  if (op.target) {
    drawFindingArrow(editor, id, createShapeId(op.target), op.severity, true);
  }
}

function drawFindingArrow(
  editor: Editor,
  findingId: TLShapeId,
  targetId: TLShapeId,
  severity: Severity,
  queueIfMissing: boolean
): boolean {
  const arrowId = createShapeId(`${findingId.replace(/^shape:/, "")}__arrow`);
  if (editor.getShape(arrowId)) return true;
  const from = editor.getShapePageBounds(findingId);
  const to = editor.getShapePageBounds(targetId);
  if (!from || !to) {
    if (queueIfMissing && from && !pending.some((p) => p.kind === "arrow" && p.findingId === findingId)) {
      pending.push({ kind: "arrow", findingId, targetId, severity });
      watch(editor);
    }
    return false;
  }
  editor.run(() => {
    editor.createShape({
      id: arrowId,
      type: "arrow",
      x: from.center.x,
      y: from.center.y,
      props: {
        kind: "arc",
        start: { x: 0, y: 0 },
        end: { x: to.center.x - from.center.x, y: to.center.y - from.center.y },
        size: "s",
        dash: "solid",
        color: SEVERITY_TLDRAW_COLOR[severity],
        arrowheadStart: "none",
        arrowheadEnd: "arrow",
      },
    });
    const bindingProps = { normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: "none" as const };
    editor.createBindings([
      { id: createBindingId(), type: "arrow", fromId: arrowId, toId: findingId, props: { terminal: "start", ...bindingProps } },
      { id: createBindingId(), type: "arrow", fromId: arrowId, toId: targetId, props: { terminal: "end", ...bindingProps } },
    ]);
  });
  return true;
}

/** Returns true when handled (created, or already existed); false when it was queued. */
function addAnnotation(editor: Editor, op: AnnotateOp, id: TLShapeId): boolean {
  if (editor.getShape(id)) return true;
  const targetId = createShapeId(op.target);
  const r = boxOnTarget(editor, targetId, { bx: op.box.x, by: op.box.y, bw: op.box.w, bh: op.box.h });
  if (!r) {
    if (!pending.some((p) => p.kind === "annotate" && p.id === id)) {
      pending.push({ kind: "annotate", op, id });
      watch(editor);
    }
    return false;
  }
  editor.createShape<AnnotationShape>({
    id,
    type: "annotation",
    x: r.x,
    y: r.y,
    parentId: editor.getCurrentPageId(), // page, not the target, so it never moves with / is clipped by it
    props: {
      w: r.w,
      h: r.h,
      targetId,
      bx: op.box.x,
      by: op.box.y,
      bw: op.box.w,
      bh: op.box.h,
      label: op.label ?? "",
      severity: op.severity,
    },
  });
  return true;
}

/** Retry queued annotations/arrows whose targets have since appeared. */
export function flushPending(editor: Editor): void {
  if (!pending.length) return;
  const queue = pending.splice(0, pending.length);
  // Both helpers re-queue themselves when their target is still missing.
  for (const p of queue) {
    if (p.kind === "annotate") addAnnotation(editor, p.op, p.id);
    else drawFindingArrow(editor, p.findingId, p.targetId, p.severity, true);
  }
  if (!pending.length) unwatch(editor);
}

export function pendingCustomOpCount(): number {
  return pending.length;
}

// While something is queued, watch the store so it lands as soon as its target is created
// (the target comes from ops we don't handle, e.g. add_image, so no later custom op may arrive).
function watch(editor: Editor) {
  if (listening.has(editor)) return;
  let scheduled = false;
  const off = editor.store.listen(
    () => {
      if (scheduled || !pending.length) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        flushPending(editor);
      });
    },
    { scope: "document", source: "all" }
  );
  listening.set(editor, off);
}

function unwatch(editor: Editor) {
  listening.get(editor)?.();
  listening.delete(editor);
}

// A finding's connector arrow is deleted along with the finding.
const wired = new WeakSet<Editor>();
function ensureSideEffects(editor: Editor) {
  if (wired.has(editor)) return;
  wired.add(editor);
  editor.sideEffects.registerAfterDeleteHandler("shape", (shape) => {
    if (shape.type !== "finding") return;
    const arrowId = createShapeId(`${shape.id.replace(/^shape:/, "")}__arrow`);
    queueMicrotask(() => {
      if (editor.getShape(arrowId)) editor.deleteShape(arrowId);
    });
  });
}
