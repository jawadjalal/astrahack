import { clear, list } from "@/server/store";
import { json, preflight } from "@/server/cors";
import { boardParams } from "@/server/boardParam";
import { authorizeRoom } from "@/server/roomAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const OPTIONS = preflight;

export async function GET(req: Request) {
  const bp = boardParams(req);
  if ("error" in bp) return bp.error;
  const denied = await authorizeRoom(req, bp.board, "read");
  if (denied) return denied;
  const ops = await list(0, bp.board);
  return json({ board: bp.board, seq: ops.at(-1)?.seq ?? 0, ops });
}

export async function DELETE(req: Request) {
  const bp = boardParams(req);
  if ("error" in bp) return bp.error;
  const denied = await authorizeRoom(req, bp.board, "write");
  if (denied) return denied;
  const env = await clear(bp.board, bp.client);
  return json({ ok: true, seq: env.seq });
}
