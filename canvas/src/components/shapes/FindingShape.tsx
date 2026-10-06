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
import { sevColor, sevInk, sevTint } from "./severity";
import { RoughBox, useEnterOnce } from "./RoughBox";
import { withBase } from "../../lib/base";

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
const PAD = 18;
const BODY_CHARS_PER_LINE = 50; // 13px Geist in (360 - 2*18) px
const TITLE_CHARS_PER_LINE = 30; // 18px Fraunces semibold

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
  let h = PAD * 2 + 26 /* chip row */ + 12;
  h += lines(p.title, TITLE_CHARS_PER_LINE) * 24 + 12;
  for (const body of [p.expected, p.actual]) {
    if (body) h += 20 /* label */ + 2 + lines(body, BODY_CHARS_PER_LINE) * 19 + 10;
  }
  h += 1 + 12 + 24; // divider + badge row
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
  const { w, h, title, severity, expected, actual, verified, timestamp, target } = shape.props;
  const color = sevColor(severity);
  const ink = sevInk(severity);
  const inner = useRef<HTMLDivElement>(null);
  const editor = useEditor();
  const enter = useEnterOnce(shape.id);

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
      <div className={enter ? "ig-finding ig-enter" : "ig-finding"} style={{ width: w, height: h, position: "relative", color: "var(--ink)" }}>
        <RoughBox w={w} h={h} seed={shape.id} fill="var(--card)" radius={14} />
        {/* washi tape holding the card down */}
        <img
          src={withBase("/ignura/doodles/kit-tape-butter.svg")}
          alt=""
          draggable={false}
          style={{ position: "absolute", top: -14, left: w / 2 - 44, width: 88, transform: "rotate(-3deg)", pointerEvents: "none" }}
        />
        <div ref={inner} style={{ position: "relative", padding: `${PAD}px ${PAD}px ${PAD - 2}px` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, height: 26 }}>
            <span
              className={enter ? "ig-stamp ig-stamp-in" : "ig-stamp"}
              style={{
                background: sevTint(severity),
                color: ink,
                border: `2.5px solid ${color}`,
                borderRadius: 8,
                padding: "1px 9px 2px",
                font: "600 13px/18px var(--f-pixel)",
                letterSpacing: ".08em",
                textTransform: "uppercase",
                boxShadow: `0 2px 0 ${color}`,
              }}
            >
              {severity}
            </span>
            {timestamp != null ? (
              <button
                type="button"
                className="ig-ts-chip"
                data-ts={timestamp}
                data-video-target={target || undefined}
                title={`Jump to ${formatTimestamp(timestamp)} in the video`}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden>
                  <path d="M1 1l7 4-7 4z" fill="currentColor" />
                </svg>
                {formatTimestamp(timestamp)}
              </button>
            ) : null}
          </div>
          <div
            style={{
              margin: "12px 0 12px",
              font: "640 18px/24px var(--f-display)",
              letterSpacing: "-.01em",
              fontVariationSettings: '"SOFT" 100, "WONK" 1',
              wordBreak: "break-word",
            }}
          >
            {title}
          </div>
          {expected ? <Section label="expected" text={expected} accent="#2F8F5F" /> : null}
          {actual ? <Section label="actual" text={actual} accent={ink} /> : null}
          <div
            style={{
              borderTop: "2px dashed var(--line-2)",
              marginTop: 10,
              paddingTop: 12,
              display: "flex",
              alignItems: "center",
              height: 24,
              boxSizing: "content-box",
            }}
          >
            {verified ? (
              <span className="ig-chip ig-chip-ok">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <circle cx="8" cy="8" r="7.2" fill="#8FD8AE" stroke="#161616" strokeWidth="1.6" />
                  <path d="M4.6 8.3l2.2 2.2 4.6-4.8" stroke="#161616" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                verified
              </span>
            ) : (
              <span className="ig-chip ig-chip-un">unverified</span>
            )}
          </div>
        </div>
      </div>
    </HTMLContainer>
  );
}

function Section({ label, text, accent }: { label: string; text: string; accent: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ font: "600 19px/20px var(--f-hand)", color: accent, marginBottom: 2 }}>{label}</div>
      <div style={{ font: "400 13px/19px var(--f-body)", color: "var(--ink-2)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{text}</div>
    </div>
  );
}
