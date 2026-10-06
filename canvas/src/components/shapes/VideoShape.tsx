import { useCallback, useEffect, useRef, useState } from "react";
import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  T,
  resizeBox,
  useEditor,
  useValue,
  type RecordProps,
  type TLResizeInfo,
  type TLShape,
} from "tldraw";
import { withBase } from "../../lib/base";
import { openLightbox } from "../media/Lightbox";
import {
  tryClaimAutoplay,
  getVideo,
  noteStopped,
  notePlaying,
  registerVideo,
  seekVideo,
  type VideoController,
} from "../media/videoRegistry";

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

/** Seek (and optionally play) a canvas video by shape id or op id. Held until the player mounts. */
export { seekVideo };

const FRAME = 6; // grabbable border around the player
const BAR_H = 32; // control bar height
const RATES = [1, 1.5, 2] as const;
const POSTER_T = 0.1; // seek here after metadata so the first frame shows as a poster

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

  // A plain click (no drag) on the picture toggles playback. Drags still move the shape.
  override onClick(shape: VideoShape) {
    const editor = this.editor;
    const p = editor.getPointInShapeSpace(shape, editor.inputs.getCurrentPagePoint());
    const inside =
      p.x > FRAME && p.x < shape.props.w - FRAME && p.y > FRAME && p.y < shape.props.h - FRAME;
    if (inside) getVideo(shape.id)?.toggle();
    return undefined;
  }

  // Double-click opens the big preview.
  override onDoubleClick(shape: VideoShape) {
    if (openLightbox(shape.id)) return { id: shape.id, type: shape.type }; // no-op change swallows the event
    return undefined;
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

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const s = Math.floor(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/**
 * play() that waits for metadata and any in-flight seek. Calling play() while the element is still
 * loading or seeking (autoplay + seekTo, finding chips) makes Chrome abort the play and can bounce
 * currentTime back to 0.
 */
function playSoon(v: HTMLVideoElement) {
  const attempt = () => {
    if (v.readyState < 1) {
      v.addEventListener("loadedmetadata", () => setTimeout(attempt, 0), { once: true });
      return;
    }
    if (v.seeking) {
      v.addEventListener("seeked", attempt, { once: true });
      return;
    }
    v.play().catch(() => {});
  };
  attempt();
}

function VideoBody({ shape }: { shape: VideoShape }) {
  const editor = useEditor();
  const { w, h, src, label, autoplay, seekTo } = shape.props;
  const id = shape.id as string;
  const url = withBase(src);

  const vref = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const visible = useRef(false);
  const resume = useRef(false); // was playing when it scrolled out of view
  const autoplayPending = useRef(autoplay);

  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [rate, setRate] = useState<number>(1);
  const [loop, setLoop] = useState(autoplay);
  const [failed, setFailed] = useState(false);

  // ---- progress painting: straight to the DOM (no React render per frame) ----
  const paint = useCallback(() => {
    const v = vref.current;
    if (!v) return;
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    const t = v.currentTime || 0;
    const pct = d > 0 ? Math.min(100, (t / d) * 100) : 0;
    if (fillRef.current) fillRef.current.style.transform = `scaleX(${pct / 100})`;
    if (thumbRef.current) thumbRef.current.style.left = `${pct}%`;
    if (timeRef.current) timeRef.current.textContent = `${fmt(t)} / ${fmt(d)}`;
  }, []);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      paint();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, paint]);

  // ---- controller exposed to the rest of the app (finding chips, lightbox) ----
  useEffect(() => {
    const whenReady = (fn: () => void) => {
      const v = vref.current;
      if (!v) return;
      if (v.readyState >= 1) fn();
      else v.addEventListener("loadedmetadata", fn, { once: true });
    };
    const play = () => {
      const v = vref.current;
      if (v) playSoon(v);
    };
    const ctl: VideoController = {
      play,
      pause: () => vref.current?.pause(),
      toggle: () => {
        const v = vref.current;
        if (!v) return;
        if (v.paused) play();
        else v.pause();
      },
      seek: (t, shouldPlay) =>
        whenReady(() => {
          const v = vref.current;
          if (!v) return;
          const d = Number.isFinite(v.duration) ? v.duration : t;
          v.currentTime = Math.max(0, Math.min(t, d));
          paint();
          if (shouldPlay) play();
        }),
      getTime: () => vref.current?.currentTime ?? 0,
      isPlaying: () => !!vref.current && !vref.current.paused,
    };
    const off = registerVideo(id, ctl);
    return () => {
      off();
      noteStopped(id);
    };
  }, [id, paint]);

  // ---- seekTo prop: on mount (once metadata is ready) and whenever it changes ----
  useEffect(() => {
    const v = vref.current;
    if (!v || seekTo == null) return;
    const go = () => {
      try {
        v.currentTime = seekTo;
      } catch {}
      paint();
    };
    if (v.readyState >= 1) go();
    else v.addEventListener("loadedmetadata", go, { once: true });
    return () => v.removeEventListener("loadedmetadata", go);
  }, [seekTo, url, paint]);

  // ---- autoplay: only when visible and nothing else is playing; muted so browsers allow it ----
  useEffect(() => {
    autoplayPending.current = autoplay;
    const v = vref.current;
    if (autoplay && v && visible.current && v.paused && tryClaimAutoplay(id)) {
      autoplayPending.current = false;
      setLoop((l) => l || autoplay);
      playSoon(v);
    }
  }, [autoplay, id]);

  // ---- pause when scrolled off-screen / culled, resume when it returns ----
  // Geometry-based (viewport vs shape bounds) rather than IntersectionObserver: it is reactive to camera
  // moves, ignores zoom, and behaves the same in a backgrounded tab.
  const inView = useValue(
    "video in view",
    () => {
      const b = editor.getShapePageBounds(shape.id);
      return !!b && editor.getViewportPageBounds().collides(b);
    },
    [editor, shape.id],
  );
  useEffect(() => {
    visible.current = inView;
    const v = vref.current;
    if (!v) return;
    if (inView) {
      if (resume.current) {
        resume.current = false;
        playSoon(v);
      } else if (autoplayPending.current && v.paused && tryClaimAutoplay(id)) {
        autoplayPending.current = false;
        playSoon(v);
      }
    } else if (!v.paused) {
      resume.current = true;
      v.pause();
    }
  }, [inView, id]);

  useEffect(() => {
    const v = vref.current;
    if (v) v.playbackRate = rate;
  }, [rate]);

  // ---- scrubbing ----
  const scrubTo = (clientX: number) => {
    const v = vref.current;
    const track = trackRef.current;
    if (!v || !track || !Number.isFinite(v.duration)) return;
    const r = track.getBoundingClientRect(); // already includes the canvas zoom transform
    const f = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    v.currentTime = f * v.duration;
    paint();
  };

  const toggle = () => getVideo(id)?.toggle();
  const compact = w < 300;
  const tiny = w < 230;
  const iconBtn: React.CSSProperties = {
    width: 26,
    height: 26,
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: 0,
    borderRadius: 6,
    color: "#fff",
    cursor: "pointer",
    padding: 0,
    font: "600 11px/1 system-ui, sans-serif",
  };

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
        <div
          ref={wrapRef}
          style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", borderRadius: 4, background: "#000" }}
        >
          {/* Never re-keyed: zooming / moving only changes the parent's CSS transform. */}
          <video
            ref={vref}
            src={url}
            muted={muted}
            loop={loop}
            playsInline
            preload="metadata"
            // Grabbing the picture must still select/drag the shape: make sure it is selected first so
            // a drag moves THIS video even when something else was selected.
            onPointerDown={(e) => {
              if (e.shiftKey || e.metaKey || e.ctrlKey) return;
              if (editor.getCurrentToolId() !== "select") return;
              if (!editor.getSelectedShapeIds().includes(shape.id)) editor.select(shape.id);
            }}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              v.playbackRate = rate;
              if (seekTo == null && v.currentTime < 0.05 && v.paused) {
                try {
                  v.currentTime = Math.min(POSTER_T, (v.duration || POSTER_T) / 2);
                } catch {}
              }
              paint();
            }}
            onDurationChange={paint}
            onTimeUpdate={paint}
            onSeeked={paint}
            onPlay={(e) => {
              const v = e.currentTarget;
              setPlaying(true);
              notePlaying(id, () => v.pause());
            }}
            onPause={() => {
              setPlaying(false);
              noteStopped(id);
              paint();
            }}
            onEnded={() => {
              setPlaying(false);
              noteStopped(id);
            }}
            onError={() => setFailed(true)}
            onLoadStart={() => setFailed(false)}
            style={{ width: "100%", height: "100%", display: "block", objectFit: "contain", background: "#000" }}
          />

          {failed ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#cbd5e1",
                font: "500 12px/1.3 system-ui, sans-serif",
                textAlign: "center",
                padding: 12,
                pointerEvents: "none",
              }}
            >
              Can&apos;t play this video
            </div>
          ) : !playing ? (
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: `calc(50% - ${BAR_H / 2}px)`,
                width: 52,
                height: 52,
                marginLeft: -26,
                marginTop: -26,
                borderRadius: 999,
                background: "rgba(0,0,0,.45)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          ) : null}

          {/* Controls: stop pointer events so tldraw doesn't start a drag from them. */}
          <div
            onPointerDown={stop}
            onPointerUp={stop}
            onClick={stop}
            onDoubleClick={stop}
            onTouchStart={stop}
            onTouchEnd={stop}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: BAR_H,
              padding: "0 4px",
              display: "flex",
              alignItems: "center",
              gap: 2,
              color: "#fff",
              background: "linear-gradient(to top, rgba(0,0,0,.72), rgba(0,0,0,0))",
              font: "500 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace",
              userSelect: "none",
              WebkitUserSelect: "none",
            }}
          >
            <button type="button" aria-label={playing ? "Pause" : "Play"} onClick={toggle} style={iconBtn}>
              {playing ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff">
                  <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            {!tiny && (
              <span ref={timeRef} style={{ flex: "0 0 auto", minWidth: 62, textAlign: "center", opacity: 0.9 }}>
                0:00 / 0:00
              </span>
            )}

            <div
              ref={trackRef}
              aria-label="Seek"
              title="Seek"
              onPointerDown={(e) => {
                e.stopPropagation();
                scrubbing.current = true;
                e.currentTarget.setPointerCapture(e.pointerId);
                scrubTo(e.clientX);
              }}
              onPointerMove={(e) => {
                if (scrubbing.current) scrubTo(e.clientX);
              }}
              onPointerUp={(e) => {
                scrubbing.current = false;
                e.currentTarget.releasePointerCapture?.(e.pointerId);
              }}
              onPointerCancel={() => {
                scrubbing.current = false;
              }}
              style={{ position: "relative", flex: "1 1 40px", minWidth: 24, height: 24, cursor: "pointer", touchAction: "none" }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: "50%",
                  height: 4,
                  marginTop: -2,
                  borderRadius: 2,
                  background: "rgba(255,255,255,.28)",
                  overflow: "hidden",
                }}
              >
                <div
                  ref={fillRef}
                  style={{ width: "100%", height: "100%", background: "#fff", transformOrigin: "left center", transform: "scaleX(0)" }}
                />
              </div>
              <div
                ref={thumbRef}
                style={{
                  position: "absolute",
                  top: "50%",
                  left: "0%",
                  width: 10,
                  height: 10,
                  marginTop: -5,
                  marginLeft: -5,
                  borderRadius: 999,
                  background: "#fff",
                  boxShadow: "0 0 0 2px rgba(0,0,0,.35)",
                  pointerEvents: "none",
                }}
              />
            </div>

            <button
              type="button"
              aria-label={muted ? "Unmute" : "Mute"}
              onClick={() => setMuted((m) => !m)}
              style={iconBtn}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 5 6 9H2v6h4l5 4z" fill="#fff" />
                {muted ? <path d="m22 9-6 6m0-6 6 6" /> : <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />}
              </svg>
            </button>

            {!compact && (
              <button
                type="button"
                aria-label="Playback speed"
                title="Playback speed"
                onClick={() => setRate((r) => RATES[(RATES.indexOf(r as (typeof RATES)[number]) + 1) % RATES.length])}
                style={{ ...iconBtn, width: 34 }}
              >
                {rate}x
              </button>
            )}

            <button
              type="button"
              aria-label="Loop"
              aria-pressed={loop}
              title={loop ? "Loop on" : "Loop off"}
              onClick={() => setLoop((l) => !l)}
              style={{
                ...iconBtn,
                width: compact ? 26 : 50,
                gap: 4,
                background: loop ? "rgba(255,255,255,.9)" : "rgba(255,255,255,.12)",
                color: loop ? "#111827" : "#fff",
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" />
              </svg>
              {!compact && <span>loop</span>}
            </button>

            <button type="button" aria-label="Open large preview" title="Open large preview" onClick={() => openLightbox(id)} style={iconBtn}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </HTMLContainer>
  );
}
