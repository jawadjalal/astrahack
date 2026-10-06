"use client";

import { useEffect, useRef, useState } from "react";
import type { Editor } from "tldraw";
import { agentBus, type AgentCursor } from "../../lib/agentBus";
import { withBase } from "../../lib/base";

// Ignura's cursor dart (site-v3 CursorShape.astro), drawn small: ink outline, flat orange, a white glint.
export const DART_BODY =
  "M5.67 4.02C11.60 5.88 17.17 8.50 22.38 11.90Q26 13.60 22.28 15.07C20.97 15.59 19.66 16.11 18.35 16.63Q16.40 17.40 15.70 19.38C15.20 20.79 14.70 22.20 14.20 23.61Q13 27 11.68 23.65C8.59 17.77 6.16 11.63 4.38 5.23Q3.50 3 5.67 4.02Z";
export const DART_SHADE =
  "M4.26 3.81Q3.94 4.12 4.38 5.23C6.16 11.63 8.59 17.77 11.68 23.65Q13 27 14.20 23.61C14.70 22.20 15.20 20.79 15.70 19.38Q16.05 18.39 16.71 17.70Z";

const ease = (t: number) => 1 - Math.pow(1 - t, 3);
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const TRAIL_MS = 750;

/**
 * The agent's presence on the board: a small hand-drawn pointer with a name tag. It glides (in page space, so it
 * stays glued to the content while the camera also moves), leaving a short fading ink trail, and its tag shows
 * what it is doing, or what it just said.
 */
export function AgentAvatar({ editor }: { editor: Editor }) {
  const root = useRef<HTMLDivElement>(null);
  const trail = useRef<HTMLCanvasElement>(null);
  const [meta, setMeta] = useState<AgentCursor | null>(agentBus.get());
  const [blurb, setBlurb] = useState<{ text: string; speech: boolean } | null>(null);
  const st = useRef({ x: 0, y: 0, fx: 0, fy: 0, tx: 0, ty: 0, t0: 0, dur: 1, has: false });
  const pts = useRef<{ x: number; y: number; t: number }[]>([]);

  useEffect(() => {
    let hide: ReturnType<typeof setTimeout> | undefined;
    const apply = (c: AgentCursor | null) => {
      if (!c) {
        st.current.has = false;
        setMeta(null);
        return;
      }
      const s = st.current;
      if (!s.has || c.instant || reduced()) {
        s.x = s.fx = s.tx = c.x;
        s.y = s.fy = s.ty = c.y;
        s.t0 = 0;
        s.has = true;
        pts.current = [];
      } else {
        s.fx = s.x;
        s.fy = s.y;
        s.tx = c.x;
        s.ty = c.y;
        s.t0 = performance.now();
        const dist = Math.hypot(c.x - s.x, c.y - s.y);
        s.dur = Math.min(950, 380 + dist * 0.35);
      }
      setMeta(c);
      if (c.doing && !c.instant) {
        setBlurb({ text: c.speech ? `“${c.doing}”` : c.doing, speech: !!c.speech });
        clearTimeout(hide);
        hide = setTimeout(() => setBlurb(null), c.speech ? 5000 : 2400);
      }
    };
    apply(agentBus.get());
    const off = agentBus.subscribe(apply);
    return () => {
      off();
      clearTimeout(hide);
    };
  }, []);

  useEffect(() => {
    let raf = 0;
    let last = "";
    let trailDirty = false;
    const loop = (now: number) => {
      const s = st.current;
      const el = root.current;
      if (el && s.has) {
        if (s.t0) {
          const t = Math.min(1, (now - s.t0) / s.dur);
          const e = ease(t);
          s.x = s.fx + (s.tx - s.fx) * e;
          s.y = s.fy + (s.ty - s.fy) * e;
          pts.current.push({ x: s.x, y: s.y, t: now });
          if (t >= 1) s.t0 = 0;
        }
        const p = editor.pageToViewport({ x: s.x, y: s.y });
        const tf = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
        if (tf !== last) {
          el.style.transform = tf;
          last = tf;
        }
      }
      // ink trail: the recent path, fading out
      const cv = trail.current;
      if (cv) {
        const arr = pts.current;
        while (arr.length && now - arr[0].t > TRAIL_MS) arr.shift();
        if (arr.length > 1 || trailDirty) {
          const dpr = window.devicePixelRatio || 1;
          const w = cv.clientWidth;
          const h = cv.clientHeight;
          if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
            cv.width = Math.round(w * dpr);
            cv.height = Math.round(h * dpr);
          }
          const ctx = cv.getContext("2d");
          if (ctx) {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            for (let i = 1; i < arr.length; i++) {
              const a = arr[i - 1];
              const b = arr[i];
              const age = 1 - (now - b.t) / TRAIL_MS;
              const pa = editor.pageToViewport({ x: a.x, y: a.y });
              const pb = editor.pageToViewport({ x: b.x, y: b.y });
              ctx.strokeStyle = `rgba(22,22,22,${Math.max(0, age) * 0.55})`;
              ctx.lineWidth = 0.8 + age * 2.2;
              ctx.beginPath();
              ctx.moveTo(pa.x, pa.y);
              ctx.lineTo(pb.x, pb.y);
              ctx.stroke();
            }
          }
          trailDirty = arr.length > 1;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [editor]);

  if (!meta) return null;
  return (
    <>
      <canvas className="ig-trail" ref={trail} aria-hidden />
      <div className="ig-agent" ref={root} aria-hidden>
        <div className="ig-agent-bob">
          <svg className="ig-agent-dart" viewBox="3.37 2.86 30 30" width={24} height={24}>
            <path d={DART_BODY} fill="none" stroke="#FFFDF9" strokeWidth={4.4} strokeLinejoin="round" />
            <path d={DART_BODY} fill="#FF6A1F" />
            <path d={DART_SHADE} fill="#E2500E" />
            <path d="M7.05 8.50L10.15 9.95" stroke="#fff" strokeWidth={2} strokeLinecap="round" fill="none" />
            <path d={DART_BODY} fill="none" stroke="#161616" strokeWidth={2.8} strokeLinejoin="round" />
          </svg>
          <div className={`ig-agent-pill ${blurb?.speech ? "is-speech" : ""}`}>
            <img src={withBase("/ignura/astra/astra-mark.svg")} width={14} height={14} alt="" draggable={false} />
            <span className="ig-agent-name">{meta.label}</span>
            {blurb && <span className="ig-agent-doing">{blurb.text}</span>}
          </div>
        </div>
      </div>
    </>
  );
}
