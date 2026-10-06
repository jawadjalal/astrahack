// Tiny pub/sub between the op applier and the UI chrome (agent avatar, activity panel).
// Everything is in canvas page coordinates; the avatar converts to screen space each frame.

export type AgentCursor = {
  x: number;
  y: number;
  label: string;
  /** bumps on every move so the avatar can restart its glide */
  n: number;
  /** jump instead of glide (initial replay) */
  instant: boolean;
  /** short action blurb shown beside the name tag, e.g. "adding screenshot" */
  doing?: string;
  /** this blurb is speech (an op `say`): quoted, held longer */
  speech?: boolean;
};

type Listener = (c: AgentCursor | null) => void;

let current: AgentCursor | null = null;
let count = 0;
const listeners = new Set<Listener>();

export const agentBus = {
  get(): AgentCursor | null {
    return current;
  },
  moveTo(x: number, y: number, opts: { label?: string; instant?: boolean; doing?: string; speech?: boolean } = {}) {
    current = {
      x,
      y,
      label: opts.label ?? current?.label ?? "Astra",
      instant: !!opts.instant,
      doing: opts.doing,
      speech: opts.speech,
      n: ++count,
    };
    for (const l of [...listeners]) l(current);
  },
  hide() {
    current = null;
    for (const l of [...listeners]) l(null);
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

/** Set while the initial replay runs: ops apply without animation or avatar glide. */
export const replay = { active: true };
