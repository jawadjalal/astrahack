import { OpSchema, type Op } from "@/lib/ops";
import { appendMany, opId } from "@/server/store";
import { json, preflight } from "@/server/cors";
import { boardParams } from "@/server/boardParam";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const OPTIONS = preflight;

export async function POST(req: Request) {
  const bp = boardParams(req);
  if ("error" in bp) return bp.error;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const items = Array.isArray(body) ? body : [body];
  const ops: Op[] = [];
  const issues: { index: number; issues: unknown }[] = [];
  items.forEach((item, index) => {
    const r = OpSchema.safeParse(item);
    if (r.success) ops.push(r.data);
    else issues.push({ index, issues: r.error.issues });
  });
  if (issues.length) return json({ ok: false, error: "invalid op(s)", issues }, 400);

  const envs = await appendMany(ops, bp.board, bp.client);
  return json({ ok: true, seqs: envs.map((e) => e.seq), ids: envs.map((e) => opId(e.op)) });
}
