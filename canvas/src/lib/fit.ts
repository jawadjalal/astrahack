import { Box, type Editor } from "tldraw";

// Camera helpers that keep content clear of our floating chrome (activity panel on the left, toolbar at the bottom,
// brand pill at the top), instead of tldraw's default "fit to the whole viewport".
export const chrome = { left: 0, top: 70, bottom: 100, right: 24 };

export function fitBox(
  editor: Editor,
  box: Box,
  opts: { maxZoom?: number; immediate?: boolean; duration?: number; pad?: number } = {},
) {
  const { maxZoom = 1, immediate, duration = 420, pad = 36 } = opts;
  const vp = editor.getViewportScreenBounds();
  const availW = Math.max(120, vp.w - chrome.left - chrome.right - pad * 2);
  const availH = Math.max(120, vp.h - chrome.top - chrome.bottom - pad * 2);
  const z = Math.min(maxZoom, availW / Math.max(1, box.w), availH / Math.max(1, box.h));
  // screen position of the available area's center
  const cx = chrome.left + pad + availW / 2;
  const cy = chrome.top + pad + availH / 2;
  const camera = { x: cx / z - box.center.x, y: cy / z - box.center.y, z };
  editor.setCamera(camera, immediate ? { immediate: true } : { animation: { duration } });
}

export function boundsOfAll(editor: Editor): Box | null {
  let box: Box | null = null;
  for (const id of editor.getCurrentPageShapeIds()) {
    const b = editor.getShapePageBounds(id);
    if (b) box = box ? Box.Common([box, b]) : b.clone();
  }
  return box;
}

export function fitAll(editor: Editor, opts: { immediate?: boolean; duration?: number } = {}) {
  const b = boundsOfAll(editor);
  if (b) fitBox(editor, b, { maxZoom: 1.1, ...opts });
}
