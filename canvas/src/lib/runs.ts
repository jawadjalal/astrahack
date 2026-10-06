import { z } from "zod";

export const RunStatusSchema = z.enum(["queued", "running", "completed", "partial", "failed"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
  id: z.uuid(),
  url: z.string().max(2048),
  status: RunStatusSchema,
  stage: z.string().max(64),
  message: z.string().max(500),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
}).strict();
export type Run = z.infer<typeof RunSchema>;

export const CreateRunSchema = z.object({ url: z.string().trim().min(1).max(2048) }).strict();
export const WorkerIdSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9._:-]+$/);
export const ClaimRunSchema = z.object({ workerId: WorkerIdSchema }).strict();
export const UpdateRunSchema = z.object({
  workerId: WorkerIdSchema,
  status: z.enum(["running", "completed", "partial", "failed"]).optional(),
  stage: z.string().trim().min(1).max(64).optional(),
  message: z.string().trim().max(500).optional(),
}).strict().refine((value) => value.status !== undefined || value.stage !== undefined || value.message !== undefined);
export type RunUpdate = z.infer<typeof UpdateRunSchema>;

export function isTerminalRun(status: RunStatus): boolean {
  return status === "completed" || status === "partial" || status === "failed";
}

/** Initial validation only. The worker also validates initial DNS resolution. */
export function normalizeRunUrl(input: string): string {
  const value = input.trim();
  if (!value || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Enter a public website URL, such as https://example.com.");
  }
  const qualified = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL;
  try { url = new URL(qualified); } catch {
    throw new Error("Enter a valid website URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 2048) {
    throw new Error("Use an HTTP or HTTPS website URL without login credentials.");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new Error("Use a public website on the standard HTTP or HTTPS port.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const forbiddenNames = /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/;
  if ((!hostname.includes(".") && !hostname.startsWith("[")) || forbiddenNames.test(hostname)) {
    throw new Error("Enter a publicly accessible website, not a local or private address.");
  }
  // URL normalizes short, integer, octal, and hexadecimal IPv4 forms first.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    const [a, b, c] = hostname.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113)) {
      throw new Error("Enter a publicly accessible website, not a local or private address.");
    }
  } else if (hostname.startsWith("[")) {
    // Permit ordinary global IPv6 unicast; reject local, mapped IPv4,
    // multicast, documentation, and transition ranges.
    if (!/^\[[23][a-f\d]{3}:/i.test(hostname) || /^\[(2001:(0*:|[012][a-f\d]{0,2}:|db8:)|2002:|3fff:)/i.test(hostname)) {
      throw new Error("Enter a publicly accessible website, not a local or private address.");
    }
  }
  return url.href;
}
