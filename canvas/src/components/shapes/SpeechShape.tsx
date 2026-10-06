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
import { RoughBox, useEnterOnce } from "./RoughBox";
import { withBase } from "../../lib/base";

declare module "tldraw" {
  interface TLGlobalShapePropsMap {
    speech: {
      w: number;
      h: number;
      text: string;
      /** where the tail points, relative to the bubble's top-left */
      tipX: number;
      tipY: number;
    };
  }
}

export type SpeechShape = TLShape<"speech">;

export const SPEECH_WIDTH = 250;
const PAD = 14;
const CHARS_PER_LINE = 24; // Caveat 22px in (250 - 2*14) px

export function estimateSpeechHeight(text: string): number {
  const n = text.split("\n").reduce((a, p) => a + Math.max(1, Math.ceil(p.length / CHARS_PER_LINE)), 0);
  return Math.ceil(PAD * 2 + 22 + n * 24);
}

export class SpeechShapeUtil extends ShapeUtil<SpeechShape> {
  static override type = "speech" as const;
  static override props: RecordProps<SpeechShape> = {
    w: T.number,
    h: T.number,
    text: T.string,
    tipX: T.number,
    tipY: T.number,
  };

  getDefaultProps(): SpeechShape["props"] {
    return { w: SPEECH_WIDTH, h: 80, text: "", tipX: 0, tipY: 100 };
  }

  override canResize() {
    return false;
  }
  override canEdit() {
    return false;
  }
  override canBind() {
    return false;
  }

  getGeometry(shape: SpeechShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
  }

  override onBeforeUpdate(prev: SpeechShape, next: SpeechShape) {
    if (prev.props.text === next.props.text || prev.props.h !== next.props.h) return;
    return { ...next, props: { ...next.props, h: estimateSpeechHeight(next.props.text) } };
  }

  component(shape: SpeechShape) {
    return <SpeechBody shape={shape} />;
  }

  getIndicatorPath(shape: SpeechShape) {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, 14);
    return path;
  }
}

function SpeechBody({ shape }: { shape: SpeechShape }) {
  const { w, h, text, tipX, tipY } = shape.props;
  const inner = useRef<HTMLDivElement>(null);
  const editor = useEditor();
  const enter = useEnterOnce(shape.id);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el || editor.getIsReadonly()) return;
    const real = Math.ceil(el.offsetHeight);
    if (real > 0 && Math.abs(real - h) > 3) {
      editor.updateShape<SpeechShape>({ id: shape.id, type: "speech", props: { h: real } });
    }
  });

  // Tail: a wedge from the bubble edge nearest the tip, toward the tip.
  const cx = Math.min(Math.max(tipX, 26), w - 26);
  const below = tipY > h / 2;
  const baseY = below ? h - 1 : 1;
  const tail = `M${cx - 13} ${baseY}L${tipX} ${tipY}L${cx + 11} ${baseY}`;

  return (
    <HTMLContainer style={{ width: w, height: h, pointerEvents: "all" }}>
      <div className={enter ? "ig-speech ig-enter" : "ig-speech"} style={{ position: "relative", width: w, height: h }}>
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }} aria-hidden>
          <path d={tail} transform="translate(3 4)" fill="rgba(22,22,22,.16)" stroke="rgba(22,22,22,.16)" strokeWidth={2.5} strokeLinejoin="round" />
        </svg>
        <RoughBox w={w} h={h} seed={shape.id} fill="var(--butter-soft)" radius={16} />
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }} aria-hidden>
          {/* the wedge reuses the bubble fill, then the ink only along its two sides */}
          <path d={tail + "Z"} fill="var(--butter-soft)" />
          <path d={tail} fill="none" stroke="#161616" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
          <path d={`M${cx - 12} ${baseY}L${cx + 10} ${baseY}`} stroke="var(--butter-soft)" strokeWidth={4} />
        </svg>
        <div ref={inner} style={{ position: "relative", padding: PAD }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
            <img src={withBase("/ignura/iggy/iggy-mark.svg")} alt="" width={16} height={16} draggable={false} />
            <span style={{ font: "500 12px/16px var(--f-pixel)", letterSpacing: ".04em", color: "var(--orange-deep)" }}>iggy says</span>
          </div>
          <div style={{ font: "600 22px/24px var(--f-hand)", color: "var(--ink)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{text}</div>
        </div>
      </div>
    </HTMLContainer>
  );
}
