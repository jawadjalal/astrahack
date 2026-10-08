// Media intake: validate -> upload (multipart or direct-to-Blob) -> add_image / add_video op.
// Pure helpers (classifyMedia, chooseStrategy, fitSize, layoutRow) are exported so they can be unit tested
// in node (`npx tsx --test src/lib/upload.test.ts`); everything browser-only is behind function calls.
import { authHeaders } from "./roomToken";
import { withBase } from "./base";
import { boardUrl } from "./boardClient";

export type MediaKind = "image" | "video";
export type UploadResult = {
  url: string;
  kind: MediaKind;
  width?: number;
  height?: number;
  duration?: number;
};
export type UploadProgress = { loaded: number; total: number; percentage: number };
export type UploadOptions = { onProgress?: (p: UploadProgress) => void; signal?: AbortSignal };

// ---------- limits ----------
/** Vercel functions reject request bodies over ~4.5MB; stay safely under it (multipart overhead included). */
export const MULTIPART_MAX_BYTES = 4_000_000;
/** Matches /api/upload (200MB) for the multipart path and /api/upload/token (500MB) for direct. */
export const MULTIPART_LIMIT_BYTES = 200 * 1024 * 1024;
export const DIRECT_LIMIT_BYTES = 500 * 1024 * 1024;
/** Files above this go to Blob as a multipart (chunked) upload for reliability + progress. */
const BLOB_MULTIPART_FROM = 20 * 1024 * 1024;

// ---------- type validation ----------
const EXT_TYPES: Record<string, { kind: MediaKind; mime: string }> = {
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  webp: { kind: "image", mime: "image/webp" },
  gif: { kind: "image", mime: "image/gif" },
  svg: { kind: "image", mime: "image/svg+xml" },
  mp4: { kind: "video", mime: "video/mp4" },
  m4v: { kind: "video", mime: "video/mp4" },
  webm: { kind: "video", mime: "video/webm" },
  mov: { kind: "video", mime: "video/quicktime" },
};
const MIME_KIND: Record<string, MediaKind> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "image/svg+xml": "image",
  "video/mp4": "video",
  "video/webm": "video",
  "video/quicktime": "video",
};

export const ACCEPTED_LABEL = "png, jpg, webp, gif, svg, mp4, webm, mov";

export function extOf(name: string): string {
  const clean = name.split(/[?#]/)[0];
  const m = /\.([a-z0-9]+)$/i.exec(clean);
  return m ? m[1].toLowerCase() : "";
}

/** Returns the media kind + a trustworthy content type, or null when the file is not an accepted media type. */
export function classifyMedia(name: string, type = ""): { kind: MediaKind; contentType: string } | null {
  const ext = EXT_TYPES[extOf(name)];
  const mimeKind = MIME_KIND[type.toLowerCase()];
  if (mimeKind) return { kind: mimeKind, contentType: type.toLowerCase() };
  if (ext) return { kind: ext.kind, contentType: ext.mime };
  return null;
}

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaError";
  }
}

/** Throws MediaError with a user-readable message if the file can't be uploaded. */
export function validateMediaFile(file: { name: string; type: string; size: number }) {
  const c = classifyMedia(file.name, file.type);
  if (!c) throw new MediaError(`Unsupported file type. Use ${ACCEPTED_LABEL}.`);
  if (file.size === 0) throw new MediaError("File is empty.");
  if (file.size > DIRECT_LIMIT_BYTES) throw new MediaError("File is over 500MB.");
  return c;
}

export function isMediaFile(file: { name: string; type: string }): boolean {
  return classifyMedia(file.name, file.type) !== null;
}

/** Extension-based URL detection for paste/drop (query string and hash ignored). */
export function mediaKindOfUrl(raw: string): MediaKind | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const hit = EXT_TYPES[extOf(u.pathname)];
  return hit ? hit.kind : null;
}

// ---------- strategy ----------
export type ServerMode = "unknown" | "blob" | "local";
export type Strategy = "multipart" | "direct";

/**
 * Small files always go multipart (works in both modes). Big files go direct to Blob unless we already
 * learned the server has no Blob store (token route refused), where multipart is the only path.
 */
export function chooseStrategy(size: number, mode: ServerMode): Strategy {
  if (size <= MULTIPART_MAX_BYTES) return "multipart";
  return mode === "local" ? "multipart" : "direct";
}

/** The Blob client throws this when /api/upload/token answers non-2xx (e.g. no BLOB token in local dev). */
export function isTokenRouteFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /retrieve\s+the\s+(client\s+token|presigned\s+url)/i.test(msg);
}

let serverMode: ServerMode = "unknown";
export function getServerMode(): ServerMode {
  return serverMode;
}
/** test hook */
export function __setServerMode(m: ServerMode) {
  serverMode = m;
}

// ---------- sizing / layout ----------
/** Canvas size for a piece of media given its natural size. Images never upscale; videos max 720 wide. */
export function fitSize(kind: MediaKind, w?: number, h?: number): { w: number; h: number } {
  const nw = w && w > 0 ? w : kind === "video" ? 1280 : 800;
  const nh = h && h > 0 ? h : kind === "video" ? 720 : 600;
  if (kind === "video") {
    let s = Math.min(1, 720 / nw, 800 / nh);
    if (nw * s < 240) s = 240 / nw;
    return { w: Math.round(nw * s), h: Math.round(nh * s) };
  }
  const s = Math.min(1, 900 / nw, 900 / nh);
  return { w: Math.round(nw * s), h: Math.round(nh * s) };
}

/** Left-to-right placement starting at `origin`, wrapping to a new row past `maxRow` px. Returns top-left points. */
export function layoutRow(
  sizes: { w: number; h: number }[],
  origin: { x: number; y: number },
  gap = 56,
  maxRow = 2400,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let x = origin.x;
  let y = origin.y;
  let rowH = 0;
  for (const s of sizes) {
    if (x > origin.x && x - origin.x + s.w > maxRow) {
      x = origin.x;
      y += rowH + gap;
      rowH = 0;
    }
    out.push({ x, y });
    x += s.w + gap;
    rowH = Math.max(rowH, s.h);
  }
  return out;
}

// ---------- probing (browser only) ----------
export type MediaMeta = { width?: number; height?: number; duration?: number };

export function probeMedia(src: string, kind: MediaKind, timeoutMs = 8000): Promise<MediaMeta> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") return resolve({});
    let done = false;
    const finish = (m: MediaMeta) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(m);
    };
    const t = setTimeout(() => finish({}), timeoutMs);
    if (kind === "image") {
      const img = new window.Image();
      img.onload = () => finish({ width: img.naturalWidth || undefined, height: img.naturalHeight || undefined });
      img.onerror = () => finish({});
      img.src = src;
    } else {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.onloadedmetadata = () => {
        finish({
          width: v.videoWidth || undefined,
          height: v.videoHeight || undefined,
          duration: Number.isFinite(v.duration) ? v.duration : undefined,
        });
        v.removeAttribute("src");
        v.load();
      };
      v.onerror = () => finish({});
      v.src = src;
    }
  });
}

async function probeFile(file: File, kind: MediaKind): Promise<MediaMeta> {
  const obj = URL.createObjectURL(file);
  try {
    return await probeMedia(obj, kind);
  } finally {
    URL.revokeObjectURL(obj);
  }
}

// ---------- uploading ----------
function randomName(file: { name: string }): string {
  const ext = extOf(file.name);
  const base =
    file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "file";
  const id = Math.random().toString(16).slice(2, 10);
  return `${id}-${base}${ext ? "." + ext : ""}`;
}

function multipartUpload(file: File, opts: UploadOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", boardUrl("/api/upload"));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        opts.onProgress?.({ loaded: e.loaded, total: e.total, percentage: (e.loaded / e.total) * 100 });
      }
    };
    xhr.onload = () => {
      let body: { url?: string; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && body.url) {
        opts.onProgress?.({ loaded: file.size, total: file.size, percentage: 100 });
        resolve(body.url);
      } else if (xhr.status === 413) {
        reject(new MediaError("Too large for this server's simple upload (needs the Blob store)."));
      } else {
        reject(new MediaError(body.error || `Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new MediaError("Network error while uploading."));
    xhr.onabort = () => reject(new MediaError("Upload cancelled."));
    opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    const fd = new FormData();
    fd.append("file", file);
    xhr.send(fd);
  });
}

async function directUpload(file: File, contentType: string, opts: UploadOptions): Promise<string> {
  const { upload } = await import("@vercel/blob/client");
  const blob = await upload(`uploads/${randomName(file)}`, file, {
    access: "public",
    handleUploadUrl: withBase("/api/upload/token"),
    contentType,
    multipart: file.size >= BLOB_MULTIPART_FROM,
    abortSignal: opts.signal,
    onUploadProgress: (p) => opts.onProgress?.({ loaded: p.loaded, total: p.total, percentage: p.percentage }),
  });
  return blob.url;
}

/**
 * Upload one file and read its natural size/duration. Chooses multipart vs direct-to-Blob by size, and
 * falls back to multipart (remembering it) when the token route refuses, so local dev keeps working.
 */
export async function uploadMedia(file: File, opts: UploadOptions = {}): Promise<UploadResult> {
  const { kind, contentType } = validateMediaFile(file);
  const metaP = probeFile(file, kind);
  const strategy = chooseStrategy(file.size, serverMode);
  let url: string;
  if (strategy === "direct") {
    try {
      url = await directUpload(file, contentType, opts);
      serverMode = "blob";
    } catch (err) {
      if (!isTokenRouteFailure(err)) throw err;
      serverMode = "local";
      if (file.size > MULTIPART_LIMIT_BYTES) throw new MediaError("File is over 200MB (local limit).");
      url = await multipartUpload(file, opts);
    }
  } else {
    url = await multipartUpload(file, opts);
  }
  const meta = await metaP;
  return { url, kind, ...meta };
}

// ---------- canvas placement ----------
export type MediaInput = File | string;
export type Point = { x: number; y: number };
export type ItemStatus =
  | { phase: "preparing" }
  | { phase: "uploading"; progress: number }
  | { phase: "placing" }
  | { phase: "done"; id?: string }
  | { phase: "error"; message: string };

export function labelFor(input: MediaInput): string {
  if (typeof input !== "string") return input.name;
  try {
    const p = new URL(input).pathname.split("/").filter(Boolean).pop();
    return p ? decodeURIComponent(p) : input;
  } catch {
    return input;
  }
}

async function postOps(ops: Record<string, unknown>[]): Promise<{ ids?: string[] }> {
  const res = await fetch(boardUrl("/api/ops"), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(ops.length === 1 ? ops[0] : ops),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; ids?: string[] };
  if (!res.ok || body.ok === false) throw new MediaError(body.error || `Could not add to canvas (${res.status})`);
  return body;
}

type Prepared = {
  input: MediaInput;
  kind: MediaKind;
  meta: MediaMeta;
  size: { w: number; h: number };
};

/**
 * Upload (files) or reference (URLs) a batch of media and add each to the canvas, laid out left to right
 * from `point`. Per-item failures are reported through onStatus and do not stop the others.
 */
export async function addMediaBatch(
  inputs: MediaInput[],
  point: Point,
  onStatus?: (index: number, s: ItemStatus) => void,
  { concurrency = 3 }: { concurrency?: number } = {},
): Promise<(string | undefined)[]> {
  const report = (i: number, s: ItemStatus) => onStatus?.(i, s);
  const prepared: (Prepared | null)[] = await Promise.all(
    inputs.map(async (input, i) => {
      report(i, { phase: "preparing" });
      try {
        let kind: MediaKind;
        let meta: MediaMeta;
        if (typeof input === "string") {
          const k = mediaKindOfUrl(input);
          if (!k) throw new MediaError("That link is not an image or mp4/webm/mov.");
          kind = k;
          meta = await probeMedia(input, kind);
        } else {
          kind = validateMediaFile(input).kind;
          meta = await probeFile(input, kind);
        }
        return { input, kind, meta, size: fitSize(kind, meta.width, meta.height) };
      } catch (e) {
        report(i, { phase: "error", message: (e as Error).message });
        return null;
      }
    }),
  );

  const ok = prepared.filter((p): p is Prepared => !!p);
  const spots = layoutRow(
    ok.map((p) => p.size),
    point,
  );
  const placed = new Map<number, Point>();
  let spotIx = 0;
  prepared.forEach((p, i) => {
    if (p) placed.set(i, spots[spotIx++]);
  });

  const ids: (string | undefined)[] = new Array(inputs.length).fill(undefined);
  let next = 0;
  const worker = async () => {
    while (next < prepared.length) {
      const i = next++;
      const p = prepared[i];
      if (!p) continue;
      try {
        let src: string;
        if (typeof p.input === "string") {
          src = p.input;
        } else {
          report(i, { phase: "uploading", progress: 0 });
          const r = await uploadMedia(p.input, {
            onProgress: (pr) => report(i, { phase: "uploading", progress: pr.percentage }),
          });
          src = r.url;
        }
        report(i, { phase: "placing" });
        const at = placed.get(i)!;
        const label = labelFor(p.input);
        const op = {
          type: p.kind === "video" ? "add_video" : "add_image",
          src,
          x: at.x,
          y: at.y,
          w: p.size.w,
          h: p.size.h,
          label,
        };
        const res = await postOps([op]);
        ids[i] = res.ids?.[0];
        report(i, { phase: "done", id: ids[i] });
      } catch (e) {
        report(i, { phase: "error", message: (e as Error).message || "Upload failed" });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, prepared.length)) }, worker),
  );
  return ids;
}

/** Upload (or reference, for a URL) one piece of media and add it to the canvas at `point` (page coords). */
export async function addMediaToCanvas(
  input: MediaInput,
  point: Point,
  onStatus?: (s: ItemStatus) => void,
): Promise<string | undefined> {
  const box: { last: ItemStatus } = { last: { phase: "preparing" } };
  const [id] = await addMediaBatch([input], point, (_i, s) => {
    box.last = s;
    onStatus?.(s);
  });
  if (box.last.phase === "error") throw new MediaError(box.last.message);
  return id;
}
