import type { Editor } from "tldraw";
import { addMediaBatch, labelFor, mediaKindOfUrl, type MediaInput } from "../../lib/upload";
import { toasts } from "../media/mediaStore";

// The Add menu's way into the media pipeline (lib/upload.ts + media/ own uploads, progress toasts and placement).

export const ACCEPT = "image/*,video/mp4,video/webm,video/quicktime,.mov,.mp4,.webm";

/** Where new things land when nothing points at the canvas: the middle of the screen. */
function viewportSpot(editor: Editor) {
  const c = editor.getViewportPageBounds().center;
  return { x: c.x - 200, y: c.y - 150 };
}

/** Upload files and/or add links, each with a progress toast. Resolves once everything is queued, not finished. */
export function ingestMedia(editor: Editor, items: MediaInput[]) {
  if (!items.length) return;
  const ids = items.map((it) => toasts.add(labelFor(it)));
  void addMediaBatch(items, viewportSpot(editor), (i, s) => {
    const id = ids[i];
    switch (s.phase) {
      case "preparing":
        return toasts.update(id, { phase: "preparing" });
      case "uploading":
        return toasts.update(id, { phase: "uploading", progress: s.progress });
      case "placing":
        return toasts.update(id, { phase: "placing", progress: 100 });
      case "done":
        toasts.update(id, { phase: "done", progress: 100 });
        return void setTimeout(() => toasts.remove(id), 1800);
      case "error":
        toasts.update(id, { phase: "error", message: s.message });
        return void setTimeout(() => toasts.remove(id), 9000);
    }
  });
}

/** Returns an error message for a link that is not an image or mp4/webm/mov. */
export function linkProblem(raw: string): string | null {
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url)) return "Paste a full http(s) link";
  if (!mediaKindOfUrl(url)) return "That link is not an image or mp4/webm/mov";
  return null;
}
