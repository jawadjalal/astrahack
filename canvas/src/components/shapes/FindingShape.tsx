import { useLayoutEffect, useRef } from "react";
import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  T,
  useEditor,
  type RecordProps,
  type TLShape,
} from "tldraw";
import { sevColor, sevTint } from "./severity";

declare module "tldraw" {
  interface TLGlobalShapePropsMap {
    finding: {
      w: number;
      h: number;
      title: string;
      severity: string;
      expected: string;
      actual: string;
      verified: boolean;
      target: string;
      timestamp?: number;
    };
  }
}

export type FindingShape = TLShape<"finding">;

export const FINDING_WIDTH = 360;
const PAD = 16;
const BODY_CHARS_PER_LINE = 52; // 12.5px system font in (360 - 2*16) px
const TITLE_CHARS_PER_LINE = 36; // 15px semibold

export function formatTimestamp(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function lines(text: string, perLine: number): number {
  if (!text) return 0;
  return text
    .split("\n")
    .reduce((n, para) => n + Math.max(1, Math.ceil(para.length / perLine)), 0);
}

/** Estimate card height from text length. The component also corrects it after measuring. */
export function estimateFindingHeight(p: {
  title: string;
  expected?: string;
  actual?: string;
}): number {
  let h = PAD * 2 + 22 /* chip row */ + 10;
  h += lines(p.title, TITLE_CHARS_PER_LINE) * 20 + 12;
  for (const body of [p.expected, p.actual]) {
    if (body) h += 14 /* label */ + 4 + lines(body, BODY_CHARS_PER_LINE) * 17 + 10;
  }
  h += 1 + 10 + 22; // divider + badge row
  return Math.ceil(h);
}

export class FindingShapeUtil extends ShapeUtil<FindingShape> {
  static override type = "finding" as const;
  static override props: RecordProps<FindingShape> = {
    w: T.number,
    h: T.number,
    title: T.string,
    severity: T.string,
    expected: T.string,
    actual: T.string,
    verified: T.boolean,
    target: T.string,
    timestamp: T.number.optional(),
  };

  getDefaultProps(): FindingShape["props"] {
    return {
      w: FINDING_WIDTH,
      h: 160,
      title: "",
      severity: "medium",
      expected: "",
      actual: "",
      verified: false,
      target: "",
      timestamp: undefined,
    };
  }

  override canResize() {
    return false;
  }
  override canEdit() {
    return false;
  }

  getGeometry(shape: FindingShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
  }

  // `update` ops that change text re-fit the height automatically.
  override onBeforeUpdate(prev: FindingShape, next: FindingShape) {
    const a = prev.props;
    const b = next.props;
    if (a.title === b.title && a.expected === b.expected && a.actual === b.actual) return;
    if (a.h !== b.h) return; // caller set h explicitly
    return { ...next, props: { ...b, h: estimateFindingHeight(b) } };
  }

  component(shape: FindingShape) {
    return <FindingBody shape={shape} />;
  }

  getIndicatorPath(shape: FindingShape) {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, 12);
    return path;
  }
}

function FindingBody({ shape }: { shape: FindingShape }) {
  const { w, h, title, severity, expected, actual, verified, timestamp } = shape.props;
  const color = sevColor(severity);
  const inner = useRef<HTMLDivElement>(null);
  const editor = useEditor();

  // Correct the estimated height to the real rendered height.
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el || editor.getIsReadonly()) return;
    const real = Math.ceil(el.offsetHeight);
    if (real > 0 && Math.abs(real - h) > 3) {
      editor.updateShape<FindingShape>({ id: shape.id, type: "finding", props: { h: real } });
    }
  });

  return (
    <HTMLContainer style={{ width: w, height: h, pointerEvents: "all" }}>
      <div
        style={{
          width: w,
          height: h,
          boxSizing: "border-box",
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderLeft: `5px solid ${color}`,
          borderRadius: 12,
          boxShadow: "0 4px 14px rgba(17,24,39,.10)",
          overflow: "hidden",
          font: "400 12.5px/17px system-ui, -apple-system, sans-serif",
          color: "#111827",
        }}
      >
        <div ref={inner} style={{ padding: PAD, paddingLeft: PAD - 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, height: 22 }}>
            <span
              style={{
                background: sevTint(severity),
                color,
                border: `1px solid ${color}`,
                borderRadius: 999,
                padding: "1px 9px",
                font: "700 10.5px/16px system-ui, sans-serif",
                letterSpacing: ".06em",
                textTransform: "uppercase",
              }}
            >
              {severity}
            </span>
            {timestamp != null ? (
              <span
                style={{
                  marginLeft: "auto",
                  font: "600 11.5px/16px ui-monospace, SFMono-Regular, Menlo, monospace",
                  color: "#6b7280",
                }}
              >
                @ {formatTimestamp(timestamp)}
              </span>
            ) : null}
          </div>
          <div
            style={{
              margin: "10px 0 12px",
              font: "600 15px/20px system-ui, -apple-system, sans-serif",
              wordBreak: "break-word",
            }}
          >
            {title}
          </div>
          {expected ? <Section label="Expected" text={expected} /> : null}
          {actual ? <Section label="Actual" text={actual} accent={color} /> : null}
          <div
            style={{
              borderTop: "1px solid #f1f5f9",
              marginTop: 10,
              paddingTop: 10,
              display: "flex",
              alignItems: "center",
              height: 22,
              boxSizing: "content-box",
            }}
          >
            {verified ? (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  color: "#15803d",
                  background: "#f0fdf4",
                  border: "1px solid #86efac",
                  borderRadius: 999,
                  padding: "1px 9px 1px 6px",
                  font: "600 11.5px/16px system-ui, sans-serif",
                }}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="8" fill="#16a34a" />
                  <path d="M4.5 8.3l2.2 2.2 4.8-4.8" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Verified
              </span>
            ) : (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  color: "#6b7280",
                  background: "#f9fafb",
                  border: "1px dashed #9ca3af",
                  borderRadius: 999,
                  padding: "1px 9px",
                  font: "600 11.5px/16px system-ui, sans-serif",
                }}
              >
                Unverified
              </span>
            )}
          </div>
        </div>
      </div>
    </HTMLContainer>
  );
}

function Section({ label, text, accent }: { label: string; text: string; accent?: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          font: "700 10px/14px system-ui, sans-serif",
          letterSpacing: ".08em",
          textTransform: "uppercase",
          color: accent ?? "#6b7280",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ color: "#374151", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{text}</div>
    </div>
  );
}
