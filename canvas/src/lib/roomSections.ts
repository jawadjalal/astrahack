// The lanes of a room board, found by the stable shape ids roomToOps gives them (rd-<kind>-...).
// The parent page (ignura.com/canvas) asks the board to fly to one, and learns which ones exist.
import type { Editor } from "tldraw";
import { Box } from "tldraw";
import { fitBox } from "./fit";

export const SECTIONS: { id: string; label: string; prefixes: string[] }[] = [
  { id: "overview", label: "Overview", prefixes: ["rd-overview-label", "rd-s-"] },
  { id: "findings", label: "Findings", prefixes: ["rd-findings-label", "rd-f-"] },
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

/** Fly to a section ("home" = title + overview). Returns false if it is not on the board. */
export function goToSection(editor: Editor, id: string): boolean {
  const prefixes = id === "home" ? HOME : SECTIONS.find((s) => s.id === id)?.prefixes;
  const box = prefixes ? boundsFor(editor, prefixes) : null;
  if (!box) return false;
  fitBox(editor, box.clone().expandBy(60), { maxZoom: 1 });
  return true;
}
