# Website URL intake and local worker

The product entry point is `https://ignura.com/astrahack`. A visitor supplies a public website URL. The deployed Next.js app queues a run and shows its progress; a separately running worker explores that submitted URL and publishes QA evidence, feature screenshots, ad images, X and Reddit campaign drafts, and UGC scripts to the shared canvas.

The worker currently performs these stages once:

1. Run the existing adaptive computer-use fleet against the submitted URL.
2. Start QA analysis, feature screenshot selection, and launch-kit generation in parallel from the recorded evidence.
3. Generate five real ad images, X and Reddit campaign drafts, and a grounded UGC plan in parallel using the existing generators.
4. Upload QA evidence and curated feature screenshots.
5. Publish the generated launch kit with the same renderer as `push-kit`, using IDs scoped to the submitted run and evidence arrows to that run's screenshots.

Marketing outputs are drafts for review; this flow does not post to social networks. UGC output contains hooks, creator briefs, scripts, and a campaign plan, not a rendered video. Native app and Electron attachment remain outside this website intake flow; the existing local CLI supports its documented targets separately.

The fleet's actions and screenshots are adapted into `marketing-report.json`, preserving their evidence paths; a separate `marketing-brief.txt` supplies observed facts to the ad and campaign generators. Outputs are retained under `launch-kit/`, `ugc-plan.json`, and `ugc-plan.md`; `launch-kit.json` records which generators completed. There is no mock or heuristic fallback. A missing provider, failed creative, incomplete campaign, or failed canvas publication produces a `partial` run while retaining and publishing successful outputs.

## Deployment settings

Deploy the existing `canvas/` Next.js project with these server settings:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_BASE_PATH=/astrahack` | Build the canvas and client API requests for the production subpath. |
| `CANVAS_STORE=blob` | Persist canvas state and run state across server instances. |
| `BLOB_READ_WRITE_TOKEN` | Existing Vercel Blob credentials for uploads and persistence. |
| `ASTRAHACK_WORKER_TOKEN` | Random secret shared with the worker; use at least 24 characters. Never expose it as a `NEXT_PUBLIC_` variable. |
| `ASTRAHACK_RUN_BLOB_READ_WRITE_TOKEN` | Optional dedicated Blob store for run state; defaults to `BLOB_READ_WRITE_TOKEN`. |
| `ASTRAHACK_RUN_BLOB_ACCESS=private` | Use when the dedicated run Blob store is private. The default supports the existing public store with a server-only opaque namespace. |

The API refuses new runs if the worker token is unconfigured. A configured token does not prove a worker is online: queued runs wait until a worker polls. The Chrome executable and model API key belong on the worker host, and do not need to be added to the website hosting environment.

## Start one worker

Use Node.js 22.18 or newer, Chrome/Chromium, and the repository checkout with `canvas/` dependencies installed. Node 22.18 is needed by the existing canvas importer, which imports a TypeScript module directly.

Set these values in your local ignored `.env` or environment:

```dotenv
CANVAS_URL=https://ignura.com/astrahack
ASTRAHACK_WORKER_TOKEN=use-the-same-random-secret-as-the-deployed-server
ASTRAHACK_CHROME=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
OPENAI_API_KEY=your-key
```

The public pipeline defaults to OpenAI: Luna for text, campaigns, and UGC, and the Responses image-generation tool using `gpt-image-2` at low quality for ad images. `OPENAI_TEXT_MODEL`, `OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_RESPONSE_MODEL`, and `OPENAI_IMAGE_QUALITY` override those choices. Set `IMAGE_PROVIDER`, `CAMPAIGN_PROVIDER`, or `UGC_PROVIDER` to `gemini` to explicitly use the corresponding Gemini generator with `GEMINI_API_KEY` and its documented model settings. Provider errors are reported as incomplete stages; they do not silently switch providers.

From the repository root:

```sh
node bin/web-worker.js
```

To start the daemon before the matching worker token has been added, run `node bin/web-worker.js --wait-for-token`. It reloads the ignored local `.env` every second until the token has at least 24 non-whitespace characters, then performs normal preflight and queue polling. Values inherited from the launching process take precedence over `.env`; token values are never logged. Ctrl+C exits the wait cleanly. A configured token rejected by the server stops the worker with a sanitized authentication error.

The worker checks required credentials and executable access before polling. It processes one queued website at a time. Its internal fleet derives concurrency from observed work, starting with three scouts and allowing up to 16 isolated Chrome instances. `--once` processes at most one queued run and exits; it also exits if the queue is empty.

For local development, start `canvas/` and set `CANVAS_URL=http://localhost:3000` with the same worker token in both processes. Production uses Blob persistence. Local development defaults to memory, so restarting the canvas server loses locally queued runs.

## API handoff

All paths below are relative to `CANVAS_URL`, including its `/astrahack` suffix:

| Request | Caller and result |
| --- | --- |
| `POST /api/runs` with `{ "url": "https://example.com" }` | UI creates the run and receives `{run}`. |
| `GET /api/runs/:id` | UI polls the run it created. |
| `GET /api/runs` | Authenticated worker receives `{runs}` containing queued jobs in order. |
| `POST /api/runs/:id/claim` with `{workerId}` | Authenticated worker claims once and receives `{run}`; conflicting claims return 409. |
| `PATCH /api/runs/:id` with `{workerId,status,stage,message}` | Claiming worker writes progress and terminal outcome. |

Worker requests carry `Authorization: Bearer <ASTRAHACK_WORKER_TOKEN>`. Normal control requests time out after 15 seconds. The worker sends a heartbeat every 15 seconds while it owns an active run. Stage changes also update progress. `completed` means these configured stages finished; it does not mean the entire website is free of bugs. Coverage limits, incomplete analysis, screenshot gaps, and publication failures produce `partial`. Failure before usable evidence produces `failed`.

Run artifacts are retained under `runs/web-<run-id>/`. The `worker-attempt.json` marker is created exclusively before paid work. The server does not automatically reclaim running jobs, and the worker does not automatically repeat a recorded attempt. An uncertain claim or crash may therefore leave a run waiting for operator attention. Terminal status delivery may retry three times; the pipeline itself is not retried. Do not delete an attempt marker just to retry: submit a deliberate new run after investigating the failure.

Ctrl+C stops polling and signals the active pipeline. The worker runs the pipeline in a process group, lets it shut down for five seconds, then terminates remaining processes on macOS/Linux. Windows only supports the direct child termination path and has not been verified for descendant cleanup. A 45-minute process limit also stops a hung pipeline. An interrupted run is not automatically restarted.

## Limits and deployment boundary

Exploration has no model request count cap and no fixed agent allocation. The worker lets the fleet derive concurrency from the observed missions. It inherits a 15-minute fleet deadline, up to 20 turns and 100 actions per browser, and 8,192 maximum output tokens per response. Browser concurrency also accounts for available CPU/RAM. Initial crawling uses up to 50 pages and depth four. The existing crawler does not itself stop immediately when the fleet deadline expires; the fleet checks its remaining budget after crawling. QA analysis, screenshot selection, ad images, campaigns, and UGC make additional model calls outside the fleet budget. These limits are not a dollar cap. Luna is the default text model, with no automatic expensive fallback.

The website host does not run the local Chrome process. Leave the worker computer awake and the command running, or move this same worker to a persistent machine with Chrome installed. Long browser jobs do not run inside a Next.js request. The poll connection is outgoing HTTPS, so no incoming tunnel to the worker computer is required.

The worker rejects non-HTTP(S) targets, embedded credentials, custom ports, local hostnames, and DNS answers that include private, loopback, link-local, reserved or documentation addresses. This is initial target validation. The current browser adapter does not enforce a network boundary for every redirect, subresource, or DNS change. Use an isolated worker with outbound network restrictions before accepting arbitrary untrusted public websites. Initial URL validation alone is insufficient protection for a worker on a sensitive local network.

Runs and their media currently appear together on one shared canvas. Publishing appends content and never clears it. There is no per-user private workspace. Existing canvas write/upload APIs have their existing authentication behavior; the worker bearer token protects the queue and status mutations, not the entire canvas. Run admission currently allows five submissions per client per hour, 60 total per hour, and 20 active jobs. These controls bound admission but do not provide user billing or a complete abuse prevention system.

## Verification without model charges

```sh
node --test test/web-run-worker.test.js test/web-run-pipeline.test.js test/web-run-kit.test.js
```

These tests use a local fixture API and injected stages. They verify submitted URL propagation, `/astrahack` API routing, heartbeat and terminal statuses, prevention of a repeated attempt, private target rejection, request timeouts, shutdown handling, parallel generator execution, evidence adaptation, scoped kit IDs, and publication of surviving artifacts after stage failures. They do not call a paid model or start Chrome.
