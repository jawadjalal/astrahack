"use client";

import { useEffect, useRef, useState } from "react";
import type { Editor } from "tldraw";
import { agentBus, type AgentCursor } from "../../lib/agentBus";
import { withBase } from "../../lib/base";

// Ignura's cursor dart (site-v3 CursorShape.astro): plump paper-cut arrow, ink outline, ink shelf, pill label.
const BODY =
  "M5.67 4.02C11.60 5.88 17.17 8.50 22.38 11.90Q26 13.60 22.28 15.07C20.97 15.59 19.66 16.11 18.35 16.63Q16.40 17.40 15.70 19.38C15.20 20.79 14.70 22.20 14.20 23.61Q13 27 11.68 23.65C8.59 17.77 6.16 11.63 4.38 5.23Q3.50 3 5.67 4.02Z";
const SHADE =
  "M4.26 3.81Q3.94 4.12 4.38 5.23C6.16 11.63 8.59 17.77 11.68 23.65Q13 27 14.20 23.61C14.70 22.20 15.20 20.79 15.70 19.38Q16.05 18.39 16.71 17.70Z";

const ease = (t: number) => 1 - Math.pow(1 - t, 3);
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * The agent's presence on the board: an orange Ignura cursor with a name pill. It glides (in page space, so it
 * stays glued to the element while the camera also moves) to wherever the agent last touched.
 */
export function AgentAvatar({ editor }: { editor: Editor }) {
  const root = useRef<HTMLDivElement>(null);
  const [meta, setMeta] = useState<AgentCursor | null>(agentBus.get());
  const [doing, setDoing] = useState<string | null>(null);
  const st = useRef({ x: 0, y: 0, fx: 0, fy: 0, tx: 0, ty: 0, t0: 0, dur: 1, has: false });

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
      } else {
        s.fx = s.x;
        s.fy = s.y;
        s.tx = c.x;
        s.ty = c.y;
        s.t0 = performance.now();
        const dist = Math.hypot(c.x - s.x, c.y - s.y);
        s.dur = Math.min(900, 380 + dist * 0.35);
      }
      setMeta(c);
      if (c.doing && !c.instant) {
        setDoing(c.doing);
        clearTimeout(hide);
        hide = setTimeout(() => setDoing(null), 2600);
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
    const loop = (now: number) => {
      const s = st.current;
      const el = root.current;
      if (el && s.has) {
        if (s.t0) {
          const t = Math.min(1, (now - s.t0) / s.dur);
          const e = ease(t);
          s.x = s.fx + (s.tx - s.fx) * e;
          s.y = s.fy + (s.ty - s.fy) * e;
          if (t >= 1) s.t0 = 0;
        }
        const p = editor.pageToViewport({ x: s.x, y: s.y });
        const tf = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
        if (tf !== last) {
          el.style.transform = tf;
          last = tf;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [editor]);

  if (!meta) return null;
  return (
    <div className="ig-agent" ref={root} aria-hidden>
      <div className="ig-agent-bob">
        <svg className="ig-agent-dart" viewBox="3.37 2.86 30 30" width={34} height={34}>
          <path d={BODY} fill="none" stroke="#FFFDF9" strokeWidth={5.2} strokeLinejoin="round" />
          <path d={BODY} transform="translate(.9 1.8)" fill="#161616" stroke="#161616" strokeWidth={2.6} strokeLinejoin="round" />
          <path d={BODY} fill="#FF6A1F" />
          <path d={SHADE} fill="#E2500E" />
          <path d="M7.05 8.50L10.15 9.95" stroke="#fff" strokeWidth={2} strokeLinecap="round" fill="none" />
          <path d={BODY} fill="none" stroke="#161616" strokeWidth={2.6} strokeLinejoin="round" />
        </svg>
        <div className="ig-agent-pill">
          <img src={withBase("/ignura/iggy/iggy-mark.svg")} width={16} height={16} alt="" draggable={false} />
          <span>{meta.label}</span>
        </div>
        {doing && <div className="ig-agent-doing">{doing}</div>}
      </div>
    </div>
  );
}
