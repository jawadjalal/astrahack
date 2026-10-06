"use client";

import { useCallback, useEffect, useRef } from "react";
import type { Editor } from "tldraw";
import { withBase } from "../../lib/base";
import {
  getMediaEditor,
  lightboxStore,
  useLightbox,
  type LightboxItem,
} from "./mediaStore";
import { getVideo, normalizeShapeId, pauseAllVideos, seekVideo } from "./videoRegistry";

type Positioned = LightboxItem & { x: number; y: number; w: number; h: number };

/**
 * Canvas reading order: rows top to bottom (shapes whose tops are within half a card of the row's first
 * shape share a row), left to right inside a row.
 */
export function flowOrder<T extends { x: number; y: number; h: number }>(items: T[]): T[] {
  const byTop = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: T[][] = [];
  for (const it of byTop) {
    const row = rows[rows.length - 1];
    if (row && it.y - row[0].y <= Math.max(40, row[0].h * 0.5)) row.push(it);
    else rows.push([it]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x));
}

/** All images and videos on the current page, in flow order. */
export function collectMedia(editor: Editor): LightboxItem[] {
  const out: Positioned[] = [];
  for (const s of editor.getCurrentPageShapes()) {
    const b = editor.getShapePageBounds(s.id);
    if (!b) continue;
    if (s.type === "video") {
      const p = s.props as { src: string; label: string };
      if (p.src) out.push({ id: s.id, kind: "video", src: withBase(p.src), label: p.label, x: b.x, y: b.y, w: b.w, h: b.h });
    } else if (s.type === "image") {
      const assetId = (s.props as { assetId?: string | null }).assetId;
      const asset = assetId ? (editor.getAsset(assetId as never) as unknown as { props: { src?: string | null; name?: string } } | undefined) : undefined;
      const props = asset?.props;
      if (props?.src) out.push({ id: s.id, kind: "image", src: props.src, label: props.name ?? "", x: b.x, y: b.y, w: b.w, h: b.h });
    }
  }
  return flowOrder(out).map(({ id, kind, src, label }) => ({ id, kind, src, label }));
}

/** Open the lightbox on a canvas image/video (shape id or op id). No-op if it isn't media. */
export function openLightbox(id: string): boolean {
  const editor = getMediaEditor();
  if (!editor) return false;
  const sid = normalizeShapeId(id);
  const items = collectMedia(editor);
  const index = items.findIndex((i) => i.id === sid);
  if (index < 0) return false;
  const ctl = getVideo(sid);
  const startAt = items[index].kind === "video" ? ctl?.getTime() : undefined;
  pauseAllVideos();
  lightboxStore.set({ items, index, startAt });
  return true;
}

export function closeLightbox() {
  lightboxStore.set(null);
}

export default function Lightbox() {
  const st = useLightbox();
  const vref = useRef<HTMLVideoElement>(null);

  // Hand the video's position back to the canvas player when leaving an item.
  const syncBack = useCallback(() => {
    const s = lightboxStore.get();
    const v = vref.current;
    if (!s || !v) return;
    const item = s.items[s.index];
    if (item.kind === "video" && Number.isFinite(v.currentTime)) seekVideo(item.id, v.currentTime, false);
  }, []);

  const step = useCallback(
    (dir: number) => {
      const s = lightboxStore.get();
      if (!s || s.items.length < 2) return;
      syncBack();
      const n = s.items.length;
      lightboxStore.set({ items: s.items, index: (s.index + dir + n) % n });
    },
    [syncBack],
  );

  const close = useCallback(() => {
    const s = lightboxStore.get();
    if (!s) return;
    syncBack();
    const item = s.items[s.index];
    lightboxStore.set(null);
    const ed = getMediaEditor();
    const shape = ed?.getShape(item.id as never);
    if (ed && shape) {
      ed.select(shape.id);
      const b = ed.getShapePageBounds(shape.id);
      if (b && !ed.getViewportPageBounds().collides(b)) ed.centerOnPoint(b.center, { animation: { duration: 300 } });
    }
  }, [syncBack]);

  const open = !!st;
  useEffect(() => {
    if (!open) return;
    // Capture phase + stopPropagation so tldraw never sees the keys (arrows would nudge selected shapes).
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      const mine = k === "Escape" || k === "ArrowLeft" || k === "ArrowRight" || k === "Home" || k === "End" || k === " ";
      if (!mine) return;
      e.preventDefault();
      e.stopPropagation();
      if (k === "Escape") close();
      else if (k === "ArrowLeft") step(-1);
      else if (k === "ArrowRight") step(1);
      else if (k === "Home" || k === "End") {
        const s = lightboxStore.get();
        if (s) {
          syncBack();
          lightboxStore.set({ items: s.items, index: k === "Home" ? 0 : s.items.length - 1 });
        }
      } else if (k === " ") {
        const v = vref.current;
        if (v) {
          if (v.paused) v.play().catch(() => {});
          else v.pause();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close, step, syncBack]);

  // Start playback after navigating to / opening a video.
  const itemId = st ? st.items[st.index].id : null;
  const startAt = st?.startAt;
  useEffect(() => {
    const v = vref.current;
    if (!v || !itemId) return;
    const go = () => {
      if (startAt && startAt > 0.15) {
        try {
          v.currentTime = startAt;
        } catch {}
      }
      v.play().catch(() => {
        // autoplay with sound refused: start muted rather than not at all
        v.muted = true;
        v.play().catch(() => {});
      });
    };
    if (v.readyState >= 1) go();
    else v.addEventListener("loadedmetadata", go, { once: true });
    return () => v.removeEventListener("loadedmetadata", go);
  }, [itemId, startAt]);

  if (!st) return null;
  const item = st.items[st.index];
  const n = st.items.length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={item.label || "Media preview"}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 5000,
        background: "rgba(10,10,12,0.88)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "56px 72px",
        boxSizing: "border-box",
        font: "500 13px/1.3 system-ui, -apple-system, sans-serif",
        color: "#fff",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 14,
          left: 20,
          right: 70,
          display: "flex",
          gap: 12,
          alignItems: "baseline",
          pointerEvents: "none",
        }}
      >
        <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {item.label || (item.kind === "video" ? "Video" : "Image")}
        </span>
        <span style={{ opacity: 0.6, fontVariantNumeric: "tabular-nums" }}>
          {st.index + 1} / {n}
        </span>
        <span style={{ opacity: 0.4, marginLeft: "auto" }}>Esc close{n > 1 ? " · ← → browse" : ""}</span>
      </div>

      <button aria-label="Close" onClick={close} style={{ ...navBtn, top: 10, right: 16, width: 36, height: 36 }}>
        ✕
      </button>
      {n > 1 && (
        <>
          <button aria-label="Previous" onClick={() => step(-1)} style={{ ...navBtn, left: 16, top: "50%", marginTop: -22 }}>
            ‹
          </button>
          <button aria-label="Next" onClick={() => step(1)} style={{ ...navBtn, right: 16, top: "50%", marginTop: -22 }}>
            ›
          </button>
        </>
      )}

      {item.kind === "video" ? (
        <video
          key={item.id}
          ref={vref}
          src={item.src}
          controls
          playsInline
          style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: 8, background: "#000", boxShadow: "0 12px 60px rgba(0,0,0,.6)" }}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={item.id}
          src={item.src}
          alt={item.label}
          draggable={false}
          style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: 6 }}
        />
      )}
    </div>
  );
}

const navBtn: React.CSSProperties = {
  position: "absolute",
  width: 44,
  height: 44,
  borderRadius: 999,
  border: "1px solid rgba(255,255,255,.25)",
  background: "rgba(255,255,255,.08)",
  color: "#fff",
  font: "400 24px/1 system-ui, sans-serif",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};
