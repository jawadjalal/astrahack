import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { RunError } from "./runStore";

export function requireWorkerConfigured(): string {
  const token = process.env.ASTRAHACK_WORKER_TOKEN;
  if (!token) throw new RunError(503, "worker_unconfigured", "Website exploration is not connected yet. Please try again after the worker is configured.");
  return token;
}

export function requireWorker(request: Request): void {
  const expected = requireWorkerConfigured();
  const authorization = request.headers.get("authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!supplied || !timingSafeEqual(digest(supplied), digest(expected))) {
    throw new RunError(401, "unauthorized", "A valid worker bearer token is required.");
  }
}

export function runClientHash(request: Request): string {
  // Vercel supplies these proxy headers. The shared queue limit also bounds
  // admissions if a deployment does not provide a reliable client address.
  const ip = request.headers.get("x-vercel-forwarded-for")?.split(",")[0].trim()
    || request.headers.get("x-real-ip")?.trim() || "anonymous";
  return createHmac("sha256", requireWorkerConfigured()).update(ip).digest("hex");
}

export function requireRunId(id: string): void {
  if (!z.uuid().safeParse(id).success) throw new RunError(404, "run_not_found", "Exploration not found.");
}

export async function readRunJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > 4096) throw new RunError(413, "body_too_large", "Request body is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new RunError(400, "invalid_json", "A JSON request body is required.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      throw new RunError(413, "body_too_large", "Request body is too large.");
    }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
    throw new RunError(400, "invalid_json", "A valid JSON request body is required.");
  }
}

export function runJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...(status === 429 || status === 503 ? { "Retry-After": "60" } : {}) } });
}

export function runFailure(error: unknown): Response {
  if (error instanceof RunError) return runJson({ error: error.message, code: error.code }, error.status);
  // Never return Blob errors, environment values, or worker internals publicly.
  return runJson({ error: "Exploration service is temporarily unavailable. Please try again shortly.", code: "service_unavailable" }, 503);
}
