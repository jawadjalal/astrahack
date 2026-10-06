import { UpdateRunSchema } from "@/lib/runs";
import { runs, RunError } from "@/server/runStore";
import { readRunJson, requireRunId, requireWorker, runFailure, runJson } from "@/server/runAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    requireRunId(id);
    const run = await runs.get(id);
    if (!run) throw new RunError(404, "run_not_found", "Exploration not found.");
    return runJson({ run });
  } catch (error) { return runFailure(error); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    requireWorker(request);
    const { id } = await context.params;
    requireRunId(id);
    const parsed = UpdateRunSchema.safeParse(await readRunJson(request));
    if (!parsed.success) throw new RunError(400, "invalid_update", "Provide a worker ID and a valid status, stage, or message.");
    return runJson({ run: await runs.update(id, parsed.data) });
  } catch (error) { return runFailure(error); }
}
