import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { put } from "@vercel/blob";
import { useBlob } from "@/server/store";
import { json, preflight } from "@/server/cors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const OPTIONS = preflight;

const MAX_BYTES = 200 * 1024 * 1024;
const EXT_OK = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".bmp", ".mp4", ".webm", ".mov", ".m4v"]);

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ ok: false, error: "expected multipart/form-data with field `file`" }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return json({ ok: false, error: "missing multipart field `file`" }, 400);
  if (file.size > MAX_BYTES) return json({ ok: false, error: "file too large (max 200MB)" }, 413);

  const ext = path.extname(file.name).toLowerCase();
  const typeOk = file.type.startsWith("image/") || /^video\/(mp4|webm|quicktime)$/.test(file.type);
  if (!typeOk && !EXT_OK.has(ext)) {
    return json({ ok: false, error: "only images and mp4/webm/mov are accepted" }, 415);
  }

  const base = path.basename(file.name, ext).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "file";
  const safeExt = EXT_OK.has(ext) ? ext : "";
  const name = `${randomBytes(4).toString("hex")}-${base}${safeExt}`;
  const url = await saveFile(name, Buffer.from(await file.arrayBuffer()), file.type);
  return json({ url });
}

// The ONLY place that touches disk or Blob (Blob when CANVAS_STORE=blob; functions cap bodies at ~4.5MB,
// bigger files use /api/upload/token + @vercel/blob/client). It returns the final URL the client should use (basePath included for local files).
async function saveFile(name: string, data: Buffer, contentType: string): Promise<string> {
  if (useBlob()) {
    const r = await put(`uploads/${name}`, data, { access: "public", addRandomSuffix: false, contentType: contentType || undefined });
    return r.url;
  }
  const dir = path.join(process.cwd(), "public", "uploads");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), data);
  return `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/uploads/${name}`;
}
