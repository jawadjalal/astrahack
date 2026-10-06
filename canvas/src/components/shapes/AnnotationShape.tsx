import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  T,
  type Editor,
  type RecordProps,
  type TLShape,
  type TLShapeId,
} from "tldraw";
import { sevColor } from "./severity";
import { RoughBox, useEnterOnce } from "./RoughBox";

declare module "tldraw" {
  interface TLGlobalShapePropsMap {
    annotation: {
      w: number;
      h: number;
      targetId: string;
      // box, as fractions (0..1) of the target's page bounds
      bx: number;
      by: number;
      bw: number;
      bh: number;
      label: string;
      severity: string;
    };
  }
}

export type AnnotationShape = TLShape<"annotation">;

export class AnnotationShapeUtil extends ShapeUtil<AnnotationShape> {
  static override type = "annotation" as const;
  static override props: RecordProps<AnnotationShape> = {
    w: T.number,
    h: T.number,
    targetId: T.string,
    bx: T.number,
    by: T.number,
    bw: T.number,
    bh: T.number,
    label: T.string,
    severity: T.string,
  };

  getDefaultProps(): AnnotationShape["props"] {
    return { w: 100, h: 60, targetId: "", bx: 0, by: 0, bw: 1, bh: 1, label: "", severity: "medium" };
  }

  override canEdit() {
    return false;
  }
  override canBind() {
    return false;
  }
  override canSnap() {
    return false;
  }

  // Unfilled: only the outline is hittable, so the annotation never blocks clicks on the target.
  getGeometry(shape: AnnotationShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: false });
  }

  component(shape: AnnotationShape) {
    return <AnnotationBody shape={shape} />;
  }

  getIndicatorPath(shape: AnnotationShape) {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, 6);
    return path;
  }
}

function AnnotationBody({ shape }: { shape: AnnotationShape }) {
  const { w, h, label, severity } = shape.props;
  const color = sevColor(severity);
  const enter = useEnterOnce(shape.id);
  return (
    <HTMLContainer style={{ width: w, height: h, pointerEvents: "none" }}>
      <RoughBox
        w={w}
        h={h}
        seed={shape.id}
        stroke={color}
        strokeWidth={3.4}
        radius={8}
        shadow={false}
        draw={enter}
        tint={`${color}1f`}
      />
      {label ? (
        <div
          className={enter ? "ig-enter-tag" : undefined}
          style={{
            position: "absolute",
            left: -4,
            top: -30,
            maxWidth: Math.max(w + 60, 180),
            padding: "1px 10px 3px",
            font: "600 14px/20px var(--f-pixel)",
            letterSpacing: ".02em",
            color: "#161616",
            background: color,
            border: "2.5px solid #161616",
            borderRadius: "9px 9px 9px 3px",
            boxShadow: "0 2.5px 0 #161616",
            transform: "rotate(-1.5deg)",
            transformOrigin: "left bottom",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            pointerEvents: "none",
            // label text stays readable on every severity fill
            ...(severity === "critical" || severity === "low" ? { color: "#fff", textShadow: "0 1.5px 0 #161616" } : null),
          }}
        >
          {label}
        </div>
      ) : null}
    </HTMLContainer>
  );
}

/** Absolute page rect for a fractional box on a target shape, or undefined if target is missing. */
export function boxOnTarget(
  editor: Editor,
  targetId: TLShapeId,
  f: { bx: number; by: number; bw: number; bh: number }
) {
  const b = editor.getShapePageBounds(targetId);
  if (!b) return undefined;
  return {
    x: b.x + f.bx * b.w,
    y: b.y + f.by * b.h,
    w: Math.max(2, f.bw * b.w),
    h: Math.max(2, f.bh * b.h),
  };
}

/** Recompute every annotation's position/size from its target's current bounds. */
export function reflowAnnotations(editor: Editor): void {
  const updates: Parameters<Editor["updateShapes"]>[0] = [];
  for (const s of editor.getCurrentPageShapes()) {
    if (s.type !== "annotation") continue;
    const a = s as AnnotationShape;
    const r = boxOnTarget(editor, a.props.targetId as TLShapeId, a.props);
    if (!r) continue;
    if (
      Math.abs(a.x - r.x) < 0.5 &&
      Math.abs(a.y - r.y) < 0.5 &&
      Math.abs(a.props.w - r.w) < 0.5 &&
      Math.abs(a.props.h - r.h) < 0.5
    )
      continue;
    updates.push({ id: a.id, type: "annotation", x: r.x, y: r.y, props: { w: r.w, h: r.h } });
  }
  if (updates.length) editor.updateShapes(updates);
}
