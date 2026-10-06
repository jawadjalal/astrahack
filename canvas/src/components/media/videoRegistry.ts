// Module-level registry of mounted <VideoShape> players. Lets anything on the page (finding chips, the
// lightbox, agents via window) seek/play a canvas video without prop drilling or re-mounting it.
import type { Editor } from "tldraw";

export type VideoController = {
  play(): void;
  pause(): void;
  toggle(): void;
  seek(seconds: number, play?: boolean): void;
  getTime(): number;
  isPlaying(): boolean;
};

const controllers = new Map<string, VideoController>();
const pendingSeeks = new Map<string, { t: number; play: boolean }>();

/** Accepts "vid1" or "shape:vid1". */
export function normalizeShapeId(id: string): string {
  return id.startsWith("shape:") ? id : `shape:${id}`;
}

export function registerVideo(id: string, ctl: VideoController): () => void {
  controllers.set(id, ctl);
  const pending = pendingSeeks.get(id);
  if (pending) {
    pendingSeeks.delete(id);
    queueMicrotask(() => ctl.seek(pending.t, pending.play));
  }
  return () => {
    if (controllers.get(id) === ctl) controllers.delete(id);
  };
}

export function getVideo(id: string): VideoController | undefined {
  return controllers.get(normalizeShapeId(id));
}

/**
 * Seek a canvas video to `seconds` (and optionally start playing). If the player is not mounted yet the
 * request is held and applied as soon as it mounts. Returns true when applied immediately.
 */
export function seekVideo(id: string, seconds: number, play = false): boolean {
  const key = normalizeShapeId(id);
  const ctl = controllers.get(key);
  if (!ctl) {
    pendingSeeks.set(key, { t: seconds, play });
    return false;
  }
  ctl.seek(seconds, play);
  return true;
}

// ---- concurrency: at most MAX_PLAYING videos decode at once; the oldest yields ----
const MAX_PLAYING = 2;
const playing: { id: string; pause: () => void }[] = [];

const claims = new Set<string>();

export function notePlaying(id: string, pause: () => void) {
  claims.delete(id);
  const i = playing.findIndex((p) => p.id === id);
  if (i >= 0) playing.splice(i, 1);
  playing.push({ id, pause });
  while (playing.length > MAX_PLAYING) playing.shift()?.pause();
}
export function noteStopped(id: string) {
  claims.delete(id);
  const i = playing.findIndex((p) => p.id === id);
  if (i >= 0) playing.splice(i, 1);
}
/**
 * Autoplay only fills an idle canvas: it never interrupts something already playing. The slot is claimed
 * synchronously (play() resolves later), so two videos that appear in the same frame can't both win.
 */
export function tryClaimAutoplay(id: string): boolean {
  if (playing.length > 0 || (claims.size > 0 && !claims.has(id))) return false;
  claims.add(id);
  setTimeout(() => claims.delete(id), 2000); // play() refused: release the slot
  return true;
}
export function pauseAllVideos() {
  for (const p of [...playing]) p.pause();
}

/**
 * Finding timestamp chip: bring the linked video into view, seek, play.
 * `targetId` is the finding's `target` (op id or shape id). Returns false when it isn't a video.
 */
export function seekAndFocus(editor: Editor, targetId: string, seconds: number): boolean {
  if (!targetId) return false;
  const id = normalizeShapeId(targetId);
  const shape = editor.getShape(id as never);
  if (!shape || shape.type !== "video") return false;
  seekVideo(id, seconds, true);
  const bounds = editor.getShapePageBounds(shape.id);
  if (bounds) {
    const view = editor.getViewportPageBounds();
    const visible = view.contains(bounds) && editor.getZoomLevel() >= 0.35;
    if (!visible) {
      editor.zoomToBounds(bounds, { animation: { duration: 350 }, inset: 140, targetZoom: 1 });
    }
  }
  editor.select(shape.id);
  return true;
}
