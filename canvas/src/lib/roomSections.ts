// The lanes of a room board, found by the stable shape ids roomToOps gives them (rd-<kind>-...).
// The parent page (ignura.com/canvas) asks the board to fly to one, and learns which ones exist.
import type { Editor } from "tldraw";
import { Box } from "tldraw";
import { chrome, fitBox } from "./fit";

export const SECTIONS: { id: string; label: string; prefixes: string[] }[] = [
  { id: "overview", label: "Overview", prefixes: ["rd-overview-label", "rd-s-"] },
  { id: "findings", label: "Findings", prefixes: ["rd-findings-label", "rd-f-"] },
  { id: "diagrams", label: "Diagrams", prefixes: ["rd-g-"] },
  { id: "charts", label: "Charts", prefixes: ["rd-b-"] },
  { id: "screens", label: "Screens", prefixes: ["rd-v-"] },
  { id: "screenshots", label: "Screenshots", prefixes: ["rd-shots-label", "rd-p-"] },
  { id: "opportunities", label: "Opportunities", prefixes: ["rd-opps-label", "rd-c-", "rd-k-"] },
  { id: "sketches", label: "Sketches", prefixes: ["rd-sketch", "rd-sk-"] },
];

const HOME = ["rd-title", "rd-overview-label", "rd-s-"];

function boundsFor(editor: Editor, prefixes: string[]): Box | null {
  let box: Box | null = null;
  for (const id of editor.getCurrentPageShapeIds()) {
    const key = String(id).replace(/^shape:/, "");
    if (!prefixes.some((p) => key.startsWith(p))) continue;
    const b = editor.getShapePageBounds(id);
    if (b) box = box ? Box.Common([box, b]) : b.clone();
  }
  return box;
}

/** The sections that have shapes on the board right now. */
export const availableSections = (editor: Editor) =>
  SECTIONS.filter((s) => boundsFor(editor, s.prefixes)).map(({ id, label }) => ({ id, label }));

let last = { id: "", i: -1 };

const STEPPED: Record<string, string> = { diagrams: "g", charts: "b", screens: "v" };

/** Frames of one kind of visual, reading order (top to bottom, then left to right). */
function visualFrames(editor: Editor, kind: string): Box[] {
  const re = new RegExp(`^shape:rd-${kind}-.+-frame$`);
  const boxes: Box[] = [];
  for (const id of editor.getCurrentPageShapeIds()) {
    if (!re.test(String(id))) continue;
    const b = editor.getShapePageBounds(id);
    if (b) boxes.push(b.clone());
  }
  return boxes.sort((a, b) => Math.round(a.y / 200) - Math.round(b.y / 200) || a.x - b.x);
}

/**
 * Fly to a section ("home" = title + overview). Diagrams, charts and screens step through one frame at a time, so each is readable.
 * A lane taller than the screen opens at its top, at the zoom that fits its width. Returns false if it is not on the board.
 */
export function goToSection(editor: Editor, id: string): boolean {
  if (STEPPED[id]) {
    const frames = visualFrames(editor, STEPPED[id]);
    if (!frames.length) return false;
    last = { id, i: last.id === id ? (last.i + 1) % frames.length : 0 };
    fitBox(editor, frames[last.i].expandBy(70), { maxZoom: 1 });
    return true;
  }
  last = { id, i: 0 };
  const prefixes = id === "home" ? HOME : SECTIONS.find((s) => s.id === id)?.prefixes;
  const box = prefixes ? boundsFor(editor, prefixes) : null;
  if (!box) return false;
  const padded = box.clone().expandBy(60);
  const vp = editor.getViewportScreenBounds();
  const z = Math.min(1, (vp.w - 80) / padded.w);
  if (padded.h * z <= vp.h - chrome.top - chrome.bottom) {
    fitBox(editor, padded, { maxZoom: 1 });
  } else {
    editor.setCamera({ x: vp.w / 2 / z - padded.center.x, y: (chrome.top + 20) / z - padded.y, z }, { animation: { duration: 420 } });
  }
  return true;
}
