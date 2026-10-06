import { list, subscribe } from "@/server/store";
import { CORS_HEADERS, preflight } from "@/server/cors";
import { boardParams } from "@/server/boardParam";
import type { Envelope } from "@/lib/ops";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export const OPTIONS = preflight;

export async function GET(req: Request) {
  const bp = boardParams(req);
  if ("error" in bp) return bp.error;
  const board = bp.board;
  const url = new URL(req.url);
  const since = Number(url.searchParams.get("since") ?? 0) || 0;
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const sendEnv = (e: Envelope) => send(`data: ${JSON.stringify(e)}\n\n`);

      // Subscribe first, buffer live events during replay, then flush deduped by seq.
      let lastSeq = since;
      const buffer: Envelope[] = [];
      let replaying = true;
      const unsub = subscribe((e) => {
        if (replaying) buffer.push(e);
        else if (e.seq > lastSeq) {
          lastSeq = e.seq;
          sendEnv(e);
        }
      }, board);
      send(": connected\n\n");
      for (const e of await list(since, board)) {
        lastSeq = Math.max(lastSeq, e.seq);
        sendEnv(e);
      }
      for (const e of buffer) {
        if (e.seq > lastSeq) {
          lastSeq = e.seq;
          sendEnv(e);
        }
      }
      replaying = false;

      const hb = setInterval(() => send(": hb\n\n"), 15000);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(hb);
        unsub();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      // Serverless functions cap at maxDuration; close early so the client reconnects with its last seq.
      const cap = process.env.VERCEL ? setTimeout(cleanup, 270_000) : null;
      const baseCleanup = cleanup;
      cleanup = () => {
        if (cap) clearTimeout(cap);
        baseCleanup();
      };
      req.signal.addEventListener("abort", cleanup);
      if (req.signal.aborted) cleanup();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...CORS_HEADERS,
    },
  });
}
