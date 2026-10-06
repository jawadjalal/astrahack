import { useEffect, useRef } from "react";
import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  T,
  resizeBox,
  type RecordProps,
  type TLResizeInfo,
  type TLShape,
} from "tldraw";

declare module "tldraw" {
  interface TLGlobalShapePropsMap {
    video: {
      w: number;
      h: number;
      src: string;
      label: string;
      autoplay: boolean;
      seekTo?: number;
    };
  }
}

export type VideoShape = TLShape<"video">;

const FRAME = 6; // draggable border around the <video>, so the shape can still be grabbed

export class VideoShapeUtil extends ShapeUtil<VideoShape> {
  static override type = "video" as const;
  static override props: RecordProps<VideoShape> = {
    w: T.number,
    h: T.number,
    src: T.string,
    label: T.string,
    autoplay: T.boolean,
    seekTo: T.number.optional(),
  };

  getDefaultProps(): VideoShape["props"] {
    return { w: 640, h: 360, src: "", label: "", autoplay: false, seekTo: undefined };
  }

  override isAspectRatioLocked() {
    return true;
  }
  override canEdit() {
    return false;
  }

  getGeometry(shape: VideoShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
  }

  override onResize(shape: VideoShape, info: TLResizeInfo<VideoShape>) {
    // Aspect lock is handled by the editor (isAspectRatioLocked); clamp to a sane minimum.
    return resizeBox(shape, info, { minWidth: 160, minHeight: 90 });
  }

  component(shape: VideoShape) {
    return <VideoBody shape={shape} />;
  }

  getIndicatorPath(shape: VideoShape) {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, 6);
    return path;
  }
}

function VideoBody({ shape }: { shape: VideoShape }) {
  const { w, h, src, label, autoplay, seekTo } = shape.props;
  const ref = useRef<HTMLVideoElement>(null);

  // Seek on mount (once metadata is ready) and whenever seekTo changes.
  useEffect(() => {
    const v = ref.current;
    if (!v || seekTo == null) return;
    const go = () => {
      try {
        v.currentTime = seekTo;
      } catch {}
    };
    if (v.readyState >= 1) go();
    else v.addEventListener("loadedmetadata", go, { once: true });
    return () => v.removeEventListener("loadedmetadata", go);
  }, [seekTo, src]);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (autoplay) v.play().catch(() => {});
  }, [autoplay, src]);

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <HTMLContainer style={{ width: w, height: h, pointerEvents: "all" }}>
      {label ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: -26,
            maxWidth: w,
            padding: "3px 10px",
            font: "600 12px/18px system-ui, -apple-system, sans-serif",
            color: "#fff",
            background: "#111827",
            borderRadius: "6px 6px 0 0",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            pointerEvents: "none",
          }}
        >
          {label}
        </div>
      ) : null}
      <div
        style={{
          width: w,
          height: h,
          padding: FRAME,
          boxSizing: "border-box",
          background: "#111827",
          borderRadius: label ? "0 8px 8px 8px" : 8,
          boxShadow: "0 2px 10px rgba(0,0,0,.18)",
        }}
      >
        <video
          ref={ref}
          src={src}
          controls
          muted
          playsInline
          loop
          autoPlay={autoplay}
          preload="metadata"
          onPointerDown={stop}
          onPointerUp={stop}
          onTouchStart={stop}
          onTouchEnd={stop}
          onDoubleClick={stop}
          style={{
            width: "100%",
            height: "100%",
            display: "block",
            objectFit: "contain",
            background: "#000",
            borderRadius: 4,
            pointerEvents: "all",
          }}
        />
      </div>
    </HTMLContainer>
  );
}
