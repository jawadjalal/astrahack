import { CreateRunSchema } from "@/lib/runs";
import { runs, RunError } from "@/server/runStore";
import { readRunJson, requireWorker, requireWorkerConfigured, runClientHash, runFailure, runJson } from "@/server/runAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    requireWorkerConfigured();
    if (request.headers.get("sec-fetch-site") === "cross-site") throw new RunError(403, "cross_site_request", "Start an exploration from the AstraHack website.");
    const parsed = CreateRunSchema.safeParse(await readRunJson(request));
    if (!parsed.success) throw new RunError(400, "invalid_request", "Provide a website URL in the url field.");
    const run = await runs.create(parsed.data.url, runClientHash(request));
    return runJson({ run }, 202);
  } catch (error) { return runFailure(error); }
}

export async function GET(request: Request) {
  try {
    requireWorker(request);
    return runJson({ runs: await runs.queued() });
  } catch (error) { return runFailure(error); }
}
