import { clear, currentSeq, list } from "@/server/store";
import { json, preflight } from "@/server/cors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const OPTIONS = preflight;

export async function GET() {
  return json({ seq: currentSeq(), ops: list() });
}

export async function DELETE() {
  const env = clear();
  return json({ ok: true, seq: env.seq });
}
