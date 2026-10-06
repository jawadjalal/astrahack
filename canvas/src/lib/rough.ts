// Deterministic hand-drawn outlines for the custom shapes (finding card, annotation box, speech bubble, video frame).
// Same seed + size => same wobble, so shapes never "boil" between renders.

function hash(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

export function rng(seed: string): () => number {
  let a = hash(seed) || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pt = [number, number];

// Points around a rounded rectangle, jittered. Walks clockwise from the top-left corner.
function outline(w: number, h: number, r: number, jitter: number, rand: () => number, step = 46): Pt[] {
  const j = () => (rand() - 0.5) * 2 * jitter;
  const pts: Pt[] = [];
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(len / step));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      pts.push([x0 + (x1 - x0) * t + j(), y0 + (y1 - y0) * t + j()]);
    }
  };
  const rr = Math.min(r, w / 2, h / 2);
  const k = rr * 0.2929; // point on a quarter circle at 45deg
  edge(rr, 0, w - rr, 0);
  pts.push([w - k + j(), k + j()]);
  edge(w, rr, w, h - rr);
  pts.push([w - k + j(), h - k + j()]);
  edge(w - rr, h, rr, h);
  pts.push([k + j(), h - k + j()]);
  edge(0, h - rr, 0, rr);
  pts.push([k + j(), k + j()]);
  return pts;
}

const f = (n: number) => Math.round(n * 10) / 10;

// Smooth closed curve through the midpoints of the polygon (quadratic corners at each point).
function closedSmooth(pts: Pt[]): string {
  const n = pts.length;
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const m0 = mid(pts[n - 1], pts[0]);
  let d = `M${f(m0[0])} ${f(m0[1])}`;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const m = mid(p, pts[(i + 1) % n]);
    d += `Q${f(p[0])} ${f(p[1])} ${f(m[0])} ${f(m[1])}`;
  }
  return d + "Z";
}

// Open stroke: starts a little off the start and overshoots, like a second pen pass.
function openSmooth(pts: Pt[], startAt: number, overshoot: number): string {
  const n = pts.length;
  const take = Math.min(n, n + overshoot);
  const seq: Pt[] = [];
  for (let i = 0; i < take; i++) seq.push(pts[(startAt + i) % n]);
  let d = `M${f(seq[0][0])} ${f(seq[0][1])}`;
  for (let i = 1; i < seq.length - 1; i++) {
    const m: Pt = [(seq[i][0] + seq[i + 1][0]) / 2, (seq[i][1] + seq[i + 1][1]) / 2];
    d += `Q${f(seq[i][0])} ${f(seq[i][1])} ${f(m[0])} ${f(m[1])}`;
  }
  const last = seq[seq.length - 1];
  return d + `L${f(last[0])} ${f(last[1])}`;
}

export type RoughPaths = { fill: string; strokes: string[] };

/** Hand-drawn rounded box: one closed path for fill/shadow and two overlapping pen passes for the ink. */
export function roughBox(w: number, h: number, seed: string, opts: { r?: number; jitter?: number } = {}): RoughPaths {
  const r = opts.r ?? 12;
  const jitter = opts.jitter ?? Math.min(2.2, 0.8 + Math.min(w, h) / 120);
  const rand = rng(`${seed}:${Math.round(w)}x${Math.round(h)}`);
  const a = outline(w, h, r, jitter, rand);
  const b = outline(w, h, r, jitter * 1.1, rand);
  return {
    fill: closedSmooth(a),
    strokes: [closedSmooth(a), openSmooth(b, Math.floor(rand() * 3), 2)],
  };
}

/** A hand-drawn wavy underline / squiggle line from (0,y) to (w,y). */
export function roughLine(w: number, seed: string, amp = 1.6): string {
  const rand = rng(seed);
  const n = Math.max(2, Math.round(w / 30));
  let d = `M0 ${f((rand() - 0.5) * amp)}`;
  for (let i = 1; i <= n; i++) {
    d += `Q${f(((i - 0.5) / n) * w)} ${f((rand() - 0.5) * amp * 2)} ${f((i / n) * w)} ${f((rand() - 0.5) * amp)}`;
  }
  return d;
}
