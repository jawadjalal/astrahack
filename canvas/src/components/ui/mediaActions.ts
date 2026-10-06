import type { Editor } from "tldraw";
import { withBase } from "../../lib/base";

// Thin intake used by the Add menu. The media workstream owns the real upload pipeline (lib/upload.ts:
// Blob direct upload, progress, paste/drop); until that lands this posts small files to /api/upload and
// large ones straight to Blob. When `uploadMedia(file)` exists, swap `uploadOne` for it.

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;
const LARGE = 4 * 1024 * 1024;

export const isVideoUrl = (u: string) => VIDEO_EXT.test(u);
export const ACCEPT = "image/*,video/mp4,video/webm,video/quicktime,.mov,.mp4,.webm";

async function uploadOne(file: File): Promise<string> {
  if (file.size > LARGE) {
    const { upload } = await import("@vercel/blob/client");
    const safe = file.name.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const r = await upload(`uploads/${Date.now().toString(36)}-${safe}`, file, {
      access: "public",
      handleUploadUrl: withBase("/api/upload/token"),
    });
    return r.url;
  }
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(withBase("/api/upload"), { method: "POST", body: fd });
  const j = (await res.json()) as { url?: string; error?: string };
  if (!j.url) throw new Error(j.error ?? "upload failed");
  return j.url;
}

function imageSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve({ w: img.naturalWidth || 800, h: img.naturalHeight || 600 });
    img.onerror = () => resolve({ w: 800, h: 600 });
    img.src = url;
  });
}

async function postOp(op: Record<string, unknown>) {
  await fetch(withBase("/api/ops"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(op),
  });
}

/** Where new things land when the user did not point at the canvas: the middle of the screen. */
function viewportSpot(editor: Editor) {
  const c = editor.getViewportPageBounds().center;
  return { x: c.x - 320, y: c.y - 220 };
}

export async function addFiles(editor: Editor, files: File[], at?: { x: number; y: number }) {
  const base = at ?? viewportSpot(editor);
  let off = 0;
  for (const file of files) {
    const isVideo = file.type.startsWith("video/") || VIDEO_EXT.test(file.name);
    if (!isVideo && !file.type.startsWith("image/")) continue;
    const url = await uploadOne(file);
    const x = base.x + off;
    const y = base.y + off;
    off += 40;
    if (isVideo) await postOp({ type: "add_video", src: url, x, y, label: file.name });
    else {
      const { w, h } = await imageSize(withBase(url));
      const s = Math.min(1, 900 / w);
      await postOp({ type: "add_image", src: url, x, y, w: w * s, h: h * s, label: file.name });
    }
  }
}

export async function addUrl(editor: Editor, raw: string) {
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url) && !url.startsWith("/")) throw new Error("Paste a full http(s) link");
  const { x, y } = viewportSpot(editor);
  const label = decodeURIComponent(url.split("?")[0].split("/").pop() || "link");
  if (isVideoUrl(url)) await postOp({ type: "add_video", src: url, x, y, label });
  else {
    const { w, h } = await imageSize(url);
    const s = Math.min(1, 900 / w);
    await postOp({ type: "add_image", src: url, x, y, w: w * s, h: h * s, label });
  }
}
