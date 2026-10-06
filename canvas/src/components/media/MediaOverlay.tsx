"use client";

import { toasts, useDragging, useToasts, type Toast } from "./mediaStore";
import Lightbox from "./Lightbox";

// Neutral hand-drawn look: wobbly outlines, offset shadow, marker-ish font. The design pass can retheme
// by overriding these few tokens.
const INK = "#1f2430";
const PAPER = "#fffdf6";
const HAND = '"Bradley Hand", "Segoe Print", "Comic Sans MS", system-ui, sans-serif';
const WOBBLE = "255px 14px 225px 14px / 14px 225px 14px 255px";

function phaseText(t: Toast): string {
  switch (t.phase) {
    case "preparing":
      return "reading file...";
    case "uploading":
      return `uploading ${Math.round(t.progress)}%`;
    case "placing":
      return "adding to canvas...";
    case "done":
      return "added";
    case "error":
      return t.message || "failed";
  }
}

function ToastCard({ t }: { t: Toast }) {
  const err = t.phase === "error";
  const pct = t.phase === "done" || t.phase === "placing" ? 100 : t.progress;
  return (
    <div
      role="status"
      style={{
        width: 280,
        padding: "8px 12px 10px",
        background: PAPER,
        color: INK,
        border: `2px solid ${err ? "#c2410c" : INK}`,
        borderRadius: WOBBLE,
        boxShadow: `3px 3px 0 ${err ? "#c2410c" : INK}`,
        font: `600 14px/1.25 ${HAND}`,
        pointerEvents: "auto",
        position: "relative",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
        {(err || t.phase === "done") && (
          <button
            aria-label="Dismiss"
            onClick={() => toasts.remove(t.id)}
            style={{ border: 0, background: "none", color: INK, cursor: "pointer", font: `700 14px ${HAND}`, padding: 0 }}
          >
            x
          </button>
        )}
      </div>
      <div style={{ fontWeight: 500, fontSize: 12.5, opacity: 0.75, marginTop: 1, color: err ? "#c2410c" : INK }}>
        {phaseText(t)}
      </div>
      {!err && (
        <div
          style={{
            marginTop: 6,
            height: 7,
            border: `1.5px solid ${INK}`,
            borderRadius: "6px 3px 7px 3px / 3px 7px 3px 6px",
            overflow: "hidden",
            background: "#fff",
          }}
        >
          <div
            style={{
              width: `${Math.max(4, Math.min(100, pct))}%`,
              height: "100%",
              background: t.phase === "done" ? "#16a34a" : INK,
              transition: "width .15s linear",
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function MediaOverlay() {
  const list = useToasts();
  const dragging = useDragging();
  return (
    <>
      {dragging && (
        <div
          style={{
            position: "fixed",
            inset: 12,
            zIndex: 2900,
            pointerEvents: "none",
            border: `3px dashed ${INK}`,
            borderRadius: WOBBLE,
            background: "rgba(255,253,246,.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: INK,
            font: `700 26px ${HAND}`,
          }}
        >
          Drop images or videos here
        </div>
      )}
      <div
        style={{
          position: "fixed",
          top: 56,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 3000,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          pointerEvents: "none",
        }}
      >
        {list.map((t) => (
          <ToastCard key={t.id} t={t} />
        ))}
      </div>
      <Lightbox />
    </>
  );
}
