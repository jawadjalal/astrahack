import { useMemo, useState } from "react";
import { roughBox } from "../../lib/rough";

// Entrance animations only play for things that arrive live, once. `motion.enabled` is flipped on by Canvas after
// the initial replay, and every shape id plays at most one entrance (remounts from culling stay still).
export const motion = { enabled: false };
const played = new Set<string>();

export function useEnterOnce(id: string): boolean {
  const [first] = useState(() => {
    if (!motion.enabled || played.has(id)) return false;
    played.add(id);
    return true;
  });
  return first;
}

type Props = {
  w: number;
  h: number;
  seed: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  shadow?: boolean;
  /** Draw the ink on with a stroke-dash animation. */
  draw?: boolean;
  /** Skip the second pen pass. */
  single?: boolean;
  /** Tint under the ink, e.g. severity highlighter. */
  tint?: string;
};

/** Absolutely positioned hand-drawn box: soft offset shadow, paper fill, two overlapping ink passes. */
export function RoughBox({ w, h, seed, fill, stroke = "var(--ink)", strokeWidth = 2.5, radius = 12, shadow = true, draw, single, tint }: Props) {
  const p = useMemo(() => roughBox(w, h, seed, { r: radius }), [w, h, seed, radius]);
  const passes = single ? p.strokes.slice(0, 1) : p.strokes;
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}
      aria-hidden
    >
      {shadow ? <path d={p.fill} transform="translate(3.5 5)" fill="rgba(22,22,22,.16)" /> : null}
      {fill ? <path d={p.fill} fill={fill} /> : null}
      {tint ? <path d={p.fill} fill={tint} /> : null}
      {passes.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth={i === 0 ? strokeWidth : strokeWidth * 0.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={i === 0 ? 1 : 0.85}
          pathLength={draw ? 1 : undefined}
          className={draw ? "ig-draw" : undefined}
          style={draw ? ({ "--ig-delay": `${i * 90}ms` } as React.CSSProperties) : undefined}
        />
      ))}
    </svg>
  );
}
