import { Sandbox } from "@vercel/sandbox";

// Starts a one-run worker in a Vercel Sandbox so a submitted site is explored without any laptop.
// Off unless ASTRAHACK_CLOUD_WORKER=1. Never throws: if it fails the run stays queued for any other worker.
export async function dispatchCloudWorker(runId: string): Promise<void> {
  if (process.env.ASTRAHACK_CLOUD_WORKER !== "1") return;
  const token = process.env.ASTRAHACK_WORKER_TOKEN;
  const openai = process.env.OPENAI_API_KEY;
  if (!token || !openai) return;
  try {
    const sandbox = await Sandbox.create({
      source: { type: "git", url: "https://github.com/jawadjalal/astrahack.git", revision: "main", depth: 1 },
      resources: { vcpus: 4 },
      timeout: 50 * 60 * 1000,
    });
    const script = [
      "set -e",
      "cd /vercel/astrahack",
      "npm ci --prefix canvas --omit=dev",
      "npx --yes playwright@1.63.0 install --with-deps chromium",
      'node bin/web-worker.js --once --run-id "$RUN_ID"',
    ].join(" && ");
    await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", script],
      detached: true,
      env: {
        RUN_ID: runId,
        CANVAS_URL: "https://ignura.com/astrahack",
        ASTRAHACK_WORKER_TOKEN: token,
        OPENAI_API_KEY: openai,
        IMAGE_PROVIDER: "openai",
        OPENAI_IMAGE_MODEL: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
        ...(process.env.GEMINI_API_KEY ? { GEMINI_API_KEY: process.env.GEMINI_API_KEY } : {}),
        GEMINI_TEXT_MODEL: process.env.GEMINI_TEXT_MODEL || "gemini-3.1-flash-lite",
      },
    });
  } catch (error) {
    console.error("cloud worker dispatch failed", error instanceof Error ? error.message : "unknown");
  }
}
