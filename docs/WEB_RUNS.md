# Website URL intake and local worker

The product entry point is `https://ignura.com/astrahack`. A visitor supplies a public website URL. The deployed Next.js app queues a run and shows its progress; a separately running worker explores that submitted URL and publishes the resulting QA evidence and feature screenshots to the shared canvas.

The worker currently performs these stages once:

1. Run the existing adaptive computer-use fleet against the submitted URL.
2. Analyze the recorded evidence.
3. Select screenshots of observed features.
4. Upload evidence and publish canvas operations, with the run ID to avoid cross-run collisions.
5. Publish the curated feature screenshots.

Ad image generation and UGC planning are separate workstreams and are not automatically invoked by this worker. Native app and Electron attachment are also outside this website intake flow; the existing local CLI supports its documented targets separately.

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

From the repository root:

```sh
node bin/web-worker.js
```

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

Ctrl+C stops polling and signals the active pipeline. The worker runs the pipeline in a process group, lets it shut down for five seconds, then terminates remaining processes on macOS/Linux. Windows only supports the direct child termination path and has not been verified for descendant cleanup. A 20-minute process limit also stops a hung pipeline. An interrupted run is not automatically restarted.

## Limits and deployment boundary

Exploration has no model request count cap and no fixed agent allocation. The worker lets the fleet derive concurrency from the observed missions. It sets five minutes of fleet budget, eight turns and 25 actions per browser, and 2,048 maximum output tokens per response. Initial crawling uses up to 50 pages and depth four. The existing crawler does not itself stop immediately when the fleet deadline expires; the fleet checks its remaining budget after crawling. QA analysis and screenshot selection make additional model calls outside the fleet budget. These limits are not a dollar cap. Model defaults and explicit environment overrides remain those of the existing modules: Luna is the default, with no automatic expensive fallback.

The website host does not run the local Chrome process. Leave the worker computer awake and the command running, or move this same worker to a persistent machine with Chrome installed. Long browser jobs do not run inside a Next.js request. The poll connection is outgoing HTTPS, so no incoming tunnel to the worker computer is required.

The worker rejects non-HTTP(S) targets, embedded credentials, custom ports, local hostnames, and DNS answers that include private, loopback, link-local, reserved or documentation addresses. This is initial target validation. The current browser adapter does not enforce a network boundary for every redirect, subresource, or DNS change. Use an isolated worker with outbound network restrictions before accepting arbitrary untrusted public websites. Initial URL validation alone is insufficient protection for a worker on a sensitive local network.

Runs and their media currently appear together on one shared canvas. Publishing appends content and never clears it. There is no per-user private workspace. Existing canvas write/upload APIs have their existing authentication behavior; the worker bearer token protects the queue and status mutations, not the entire canvas. Run admission currently allows five submissions per client per hour, 60 total per hour, and 20 active jobs. These controls bound admission but do not provide user billing or a complete abuse prevention system.

## Verification without model charges

```sh
node --test test/web-run-worker.test.js test/web-run-pipeline.test.js
```

These tests use a local fixture API and injected stages. They verify submitted URL propagation, `/astrahack` API routing, heartbeat and terminal statuses, prevention of a repeated attempt, private target rejection, request timeouts, shutdown handling, and publication of surviving evidence after stage failures. They do not call a paid model or start Chrome.
