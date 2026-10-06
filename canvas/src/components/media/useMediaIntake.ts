"use client";

import { createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "tldraw";
import {
  addMediaBatch,
  addMediaToCanvas,
  classifyMedia,
  extOf,
  labelFor,
  mediaKindOfUrl,
  type MediaInput,
  type Point,
} from "../../lib/upload";
import MediaOverlay from "./MediaOverlay";
import { openLightbox } from "./Lightbox";
import { getMediaEditor, setDragging, setMediaEditor, toasts } from "./mediaStore";
import { seekVideo } from "./videoRegistry";

// ---- one overlay root (toasts, drop hint, lightbox) living outside tldraw's tree ----
let overlayRoot: Root | null = null;
let overlayHost: HTMLDivElement | null = null;
let overlayUsers = 0;
let overlayTeardown: ReturnType<typeof setTimeout> | null = null;

function mountOverlay() {
  overlayUsers++;
  if (overlayTeardown) {
    clearTimeout(overlayTeardown);
    overlayTeardown = null;
  }
  if (!overlayRoot) {
    overlayHost = document.createElement("div");
    overlayHost.setAttribute("data-media-overlay", "");
    document.body.appendChild(overlayHost);
    overlayRoot = createRoot(overlayHost);
    overlayRoot.render(createElement(MediaOverlay));
  }
  return () => {
    overlayUsers--;
    if (overlayUsers > 0) return;
    // deferred so React strict-mode's mount/unmount/mount doesn't thrash the root
    overlayTeardown = setTimeout(() => {
      if (overlayUsers > 0) return;
      overlayRoot?.unmount();
      overlayHost?.remove();
      overlayRoot = null;
      overlayHost = null;
    }, 50);
  };
}

function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

function dtHasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types ?? []).includes("Files");
}

function urlsFromText(text: string): string[] {
  const parts = text.split(/\s+/).filter(Boolean);
  if (!parts.length || parts.length > 20) return [];
  return parts.every((p) => mediaKindOfUrl(p)) ? parts : [];
}

function urlsFromDrop(dt: DataTransfer): string[] {
  const uriList = dt
    .getData("text/uri-list")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  const fromList = uriList.filter((u) => mediaKindOfUrl(u));
  if (fromList.length) return fromList;
  return urlsFromText(dt.getData("text/plain"));
}

/** Clipboard images are all called "image.png"; give each a unique, readable name. */
function nameClipboardFile(f: File, i: number): File {
  if (!/^image\.\w+$/i.test(f.name) && f.name) return f;
  const ext = extOf(f.name) || (classifyMedia("", f.type)?.contentType.split("/")[1] ?? "png");
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  return new File([f], `pasted-${stamp}${i ? "-" + i : ""}.${ext === "jpeg" ? "jpg" : ext}`, { type: f.type });
}

/**
 * Upload/reference media and add it to the canvas with a progress toast per item. `at` is a page point
 * (defaults to the middle of the viewport). Also what the Add menu should call: ingestMedia(files).
 */
export function ingestMedia(items: MediaInput[], at?: Point) {
  if (!items.length) return;
  const ed = getMediaEditor();
  let point = at;
  if (!point) {
    const c = ed?.getViewportPageBounds().center;
    point = c ? { x: c.x - 320, y: c.y - 220 } : { x: 0, y: 0 };
  }
  const ids = items.map((it) => toasts.add(labelFor(it)));
  void addMediaBatch(items, point, (i, s) => {
    const id = ids[i];
    switch (s.phase) {
      case "preparing":
        toasts.update(id, { phase: "preparing" });
        break;
      case "uploading":
        toasts.update(id, { phase: "uploading", progress: s.progress });
        break;
      case "placing":
        toasts.update(id, { phase: "placing", progress: 100 });
        break;
      case "done":
        toasts.update(id, { phase: "done", progress: 100 });
        setTimeout(() => toasts.remove(id), 1800);
        break;
      case "error":
        toasts.update(id, { phase: "error", message: s.message });
        setTimeout(() => toasts.remove(id), 9000);
        break;
    }
  });
}

/**
 * Media intake for the canvas: drag-drop (multiple files or a dragged image link), clipboard paste of
 * images/videos, and pasting a URL to an image / mp4. Each file gets a small progress toast. Mount once
 * from Canvas.tsx: `useMediaIntake(editor)`.
 */
export function useMediaIntake(editor: Editor | null) {
  useEffect(() => mountOverlay(), []);

  useEffect(() => {
    if (!editor) return;
    setMediaEditor(editor);

    const container = editor.getContainer();
    let last: { x: number; y: number } | null = null;

    const pagePoint = (clientX?: number, clientY?: number): Point => {
      const rect = container.getBoundingClientRect();
      const cx = clientX ?? last?.x;
      const cy = clientY ?? last?.y;
      if (cx != null && cy != null && cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom) {
        const p = editor.screenToPage({ x: cx, y: cy });
        return { x: p.x, y: p.y };
      }
      const c = editor.getViewportPageBounds().center;
      return { x: c.x - 200, y: c.y - 150 };
    };

    const ingest = ingestMedia;

    const onMove = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
    };

    // ---- drag & drop ----
    const dragAcceptable = (dt: DataTransfer | null) =>
      dtHasFiles(dt) || (!!dt && Array.from(dt.types ?? []).some((t) => t === "text/uri-list"));
    const onDragOver = (e: DragEvent) => {
      if (!dragAcceptable(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      setDragging(false);
      const dt = e.dataTransfer;
      if (!dt) return;
      if (isEditableTarget(e.target)) return;
      const files = Array.from(dt.files ?? []);
      let items: MediaInput[] = files;
      if (!files.length) items = urlsFromDrop(dt);
      if (!items.length) return; // not ours (a dragged tldraw shape, plain text...)
      e.preventDefault();
      e.stopPropagation();
      ingest(items, pagePoint(e.clientX, e.clientY));
    };

    // ---- paste ----
    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target) || editor.getEditingShapeId()) return;
      const cd = e.clipboardData;
      if (!cd) return;
      const files = Array.from(cd.files ?? []).filter((f) => classifyMedia(f.name, f.type));
      if (files.length) {
        e.preventDefault();
        e.stopPropagation();
        ingest(files.map(nameClipboardFile), pagePoint());
        return;
      }
      const urls = urlsFromText(cd.getData("text/plain"));
      if (urls.length) {
        e.preventDefault();
        e.stopPropagation();
        ingest(urls, pagePoint());
      }
    };

    // ---- double-click an image: lightbox instead of crop / new text ----
    const imageUtil = editor.getShapeUtil("image") as unknown as {
      onDoubleClick?: (shape: { id: string; type: string }) => unknown;
    };
    const origDbl = imageUtil.onDoubleClick;
    imageUtil.onDoubleClick = function (this: unknown, shape) {
      if (openLightbox(shape.id)) return { id: shape.id, type: shape.type }; // no-op change: swallows the double-click
      return origDbl?.call(this, shape);
    };

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("dragleave", onDragLeave, true);
    const onDragEnd = () => setDragging(false);
    window.addEventListener("dragend", onDragEnd, true);
    window.addEventListener("drop", onDrop, true);
    window.addEventListener("paste", onPaste, true);

    // handy from the console / other agents: window.__media.seekVideo("vid1", 12, true)
    (window as unknown as { __media?: unknown }).__media = {
      openLightbox,
      seekVideo,
      addMediaToCanvas,
    };

    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("dragleave", onDragLeave, true);
      window.removeEventListener("dragend", onDragEnd, true);
      window.removeEventListener("drop", onDrop, true);
      window.removeEventListener("paste", onPaste, true);
      imageUtil.onDoubleClick = origDbl;
      setMediaEditor(null);
      setDragging(false);
    };
  }, [editor]);
}
