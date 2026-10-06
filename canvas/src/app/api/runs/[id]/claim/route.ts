import { ClaimRunSchema } from "@/lib/runs";
import { runs, RunError } from "@/server/runStore";
import { readRunJson, requireRunId, requireWorker, runFailure, runJson } from "@/server/runAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    requireWorker(request);
    const { id } = await context.params;
    requireRunId(id);
    const parsed = ClaimRunSchema.safeParse(await readRunJson(request));
    if (!parsed.success) throw new RunError(400, "invalid_worker", "Provide a valid worker ID.");
    return runJson({ run: await runs.claim(id, parsed.data.workerId) });
  } catch (error) { return runFailure(error); }
}
