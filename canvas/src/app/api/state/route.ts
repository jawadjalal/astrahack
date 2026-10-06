import { clear, list } from "@/server/store";
import { json, preflight } from "@/server/cors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const OPTIONS = preflight;

export async function GET() {
  const ops = await list();
  return json({ seq: ops.at(-1)?.seq ?? 0, ops });
}

export async function DELETE() {
  const env = await clear();
  return json({ ok: true, seq: env.seq });
}
