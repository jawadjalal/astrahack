import { OpSchema, type Op } from "@/lib/ops";
import { append, opId } from "@/server/store";
import { json, preflight } from "@/server/cors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const OPTIONS = preflight;

export async function POST(req: Request) {
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

  const seqs: number[] = [];
  const ids: (string | null)[] = [];
  for (const op of ops) {
    const env = append(op);
    seqs.push(env.seq);
    ids.push(opId(env.op));
  }
  return json({ ok: true, seqs, ids });
}
