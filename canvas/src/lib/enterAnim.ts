import type { Editor, TLShapeId } from "tldraw";

// Entrance animations for tldraw-native shapes (images, notes, text, geo, arrows). They run on the shape's DOM
// via the Web Animations API, so nothing is written to the document store. Custom shapes (finding, annotation,
// speech) animate themselves from their React components.

const SELF_ANIMATED = new Set(["finding", "annotation", "speech"]);
const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function findWrapper(editor: Editor, id: TLShapeId): HTMLElement | null {
  const root = editor.getContainer();
  return root.querySelector<HTMLElement>(`.tl-shape:not(.tl-shape-background)[data-shape-id="${id}"]`);
}

/** Wait until React has mounted the shape, then run `fn`. Gives up after ~1s (shape culled or deleted). */
function whenMounted(editor: Editor, id: TLShapeId, fn: (el: HTMLElement) => void, tries = 60) {
  const el = findWrapper(editor, id);
  if (el) return fn(el);
  if (tries > 0) requestAnimationFrame(() => whenMounted(editor, id, fn, tries - 1));
}

function pop(el: HTMLElement, delay: number) {
  // animate the shape's content, never the wrapper (tldraw owns the wrapper's transform)
  const target = (el.firstElementChild as HTMLElement | null) ?? el;
  target.animate(
    [
      { opacity: 0, transform: "scale(.9) translateY(10px)" },
      { opacity: 1, transform: "scale(1.025) translateY(-2px)", offset: 0.62 },
      { opacity: 1, transform: "scale(1) translateY(0)" },
    ],
    { duration: 420, delay, easing: "cubic-bezier(.22,1,.36,1)", fill: "backwards" },
  );
}

// Stroke-dash draw-on for arrows. tldraw paints arrows as stroked <path>s; pathLength normalises their length.
function drawOn(el: HTMLElement, delay: number) {
  const stroked = [...el.querySelectorAll<SVGPathElement>("svg path")].filter((p) => {
    if (p.closest("defs, clipPath")) return false;
    const s = getComputedStyle(p).stroke;
    return !!s && s !== "none";
  });
  // the longest stroke is the shaft; shorter ones are arrowheads, which land when the shaft arrives
  const lens = stroked.map((p) => p.getTotalLength());
  const longest = Math.max(0, ...lens);
  let animated = 0;
  stroked.forEach((p, i) => {
    if (lens[i] >= longest * 0.6) {
      p.setAttribute("pathLength", "1");
      p.animate(
        [
          { strokeDasharray: "1 1", strokeDashoffset: 1 },
          { strokeDasharray: "1 1", strokeDashoffset: 0 },
        ],
        { duration: 480, delay, easing: "cubic-bezier(.4,0,.2,1)", fill: "backwards" },
      ).finished.then(
        () => p.removeAttribute("pathLength"),
        () => {},
      );
    } else {
      p.animate([{ opacity: 0 }, { opacity: 0, offset: 0.8 }, { opacity: 1 }], { duration: 520, delay, fill: "backwards" });
    }
    animated++;
  });
  // arrowheads and labels fade in at the end of the stroke
  el.querySelectorAll<SVGElement | HTMLElement>("text, foreignObject, .tl-rich-text, .tl-arrow-label").forEach((n) =>
    n.animate([{ opacity: 0 }, { opacity: 0, offset: 0.7 }, { opacity: 1 }], { duration: 560, delay, fill: "backwards" }),
  );
  if (!animated) pop(el, delay);
}

export function animateIn(editor: Editor, ids: TLShapeId[], delay = 0) {
  if (reduced()) return;
  let i = 0;
  for (const id of ids) {
    const shape = editor.getShape(id);
    if (!shape || SELF_ANIMATED.has(shape.type)) continue;
    const d = delay + (i++ % 4) * 40;
    whenMounted(editor, id, (el) => (shape.type === "arrow" ? drawOn(el, d) : pop(el, d)));
  }
}
