import {
  Ellipse2d,
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  T,
  type RecordProps,
  type TLShape,
} from "tldraw";

// "hilite": a soft translucent fill over a region of a target image/video (the `highlight` op).
// Like AnnotationShape it stores its box as fractions of the target so it can follow the target,
// but it is a wash of colour (marker pen), not a framed box with a label tab.
// (The shape type is NOT "highlight": tldraw already owns that name for its highlighter pen.)

declare module "tldraw" {
  interface TLGlobalShapePropsMap {
    hilite: {
      w: number;
      h: number;
      targetId: string;
      // box, as fractions (0..1) of the target's page bounds
      bx: number;
      by: number;
      bw: number;
      bh: number;
      kind: string; // "rectangle" | "ellipse"
      color: string; // tldraw color name
      alpha: number; // fill strength 0..1
      label: string;
    };
  }
}

export type HiliteShape = TLShape<"hilite">;

// Marker-pen friendly hues (a bit more saturated than tldraw's own, since they are used at low alpha).
export const MARK_HEX: Record<string, string> = {
  black: "#1d1d1d",
  grey: "#8e99a8",
  white: "#ffffff",
  red: "#e03131",
  orange: "#f76707",
  yellow: "#fcc419",
  green: "#2f9e44",
  blue: "#1c7ed6",
  violet: "#ae3ec9",
  "light-red": "#fc8181",
  "light-green": "#51cf66",
  "light-blue": "#4dabf7",
  "light-violet": "#da77f2",
};

export function markHex(color: string | undefined): string {
  return MARK_HEX[color ?? "yellow"] ?? MARK_HEX.yellow;
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export class HiliteShapeUtil extends ShapeUtil<HiliteShape> {
  static override type = "hilite" as const;
  static override props: RecordProps<HiliteShape> = {
    w: T.number,
    h: T.number,
    targetId: T.string,
    bx: T.number,
    by: T.number,
    bw: T.number,
    bh: T.number,
    kind: T.string,
    color: T.string,
    alpha: T.number,
    label: T.string,
  };

  getDefaultProps(): HiliteShape["props"] {
    return { w: 100, h: 60, targetId: "", bx: 0, by: 0, bw: 1, bh: 1, kind: "rectangle", color: "yellow", alpha: 0.4, label: "" };
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
  override canResize() {
    return false;
  }

  // Unfilled: only the outline is hittable, so a highlight never blocks clicks on the image below.
  getGeometry(shape: HiliteShape) {
    const { w, h, kind } = shape.props;
    return kind === "ellipse"
      ? new Ellipse2d({ width: w, height: h, isFilled: false })
      : new Rectangle2d({ width: w, height: h, isFilled: false });
  }

  component(shape: HiliteShape) {
    const { w, h, kind, color, alpha, label } = shape.props;
    const hex = markHex(color);
    const round = kind === "ellipse";
    return (
      <HTMLContainer style={{ width: w, height: h, pointerEvents: "none" }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            boxSizing: "border-box",
            borderRadius: round ? "50%" : 6,
            background: rgba(hex, alpha),
            boxShadow: `inset 0 0 0 2px ${rgba(hex, Math.min(1, alpha + 0.25))}, 0 0 14px ${rgba(hex, alpha * 0.8)}`,
            mixBlendMode: "multiply",
            pointerEvents: "none",
          }}
        />
        {label ? (
          <div
            style={{
              position: "absolute",
              left: round ? "50%" : 0,
              top: "100%",
              transform: round ? "translateX(-50%)" : undefined,
              marginTop: 6,
              maxWidth: Math.max(w + 80, 180),
              padding: "2px 9px",
              font: "600 12px/18px system-ui, -apple-system, sans-serif",
              color: "#1d1d1d",
              background: "rgba(255,255,255,0.92)",
              border: `1.5px solid ${hex}`,
              borderRadius: 999,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              pointerEvents: "none",
            }}
          >
            {label}
          </div>
        ) : null}
      </HTMLContainer>
    );
  }

  getIndicatorPath(shape: HiliteShape) {
    const { w, h, kind } = shape.props;
    const path = new Path2D();
    if (kind === "ellipse") path.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else path.roundRect(0, 0, w, h, 6);
    return path;
  }
}
