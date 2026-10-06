# Computer-use QA end-to-end trial

Verified on 6 October 2026 against `https://ignura.com` using real Chromium sessions and the GPT-6 Luna Responses API.

## Result

- 33 of 33 worker missions completed across 16 website pages.
- 146 recorded computer actions and 188 screenshot observations.
- No unassigned discovered routes, unfinished missions, or crawl errors in the final fleet report.
- Live QA analysis and feature selection completed. The selector produced 19 feature groups and 30 curated PNG screenshots.
- The canvas received 155 evidence images and 30 curated images. Browser verification confirmed every image decoded and found no rendering exceptions.
- The URL intake, authenticated queue, claim/status flow, and status reload were separately verified locally.

The actual run is saved locally under `runs/ignura-complete/`, including `fleet.json`, `qa-agent.json`, `qa-analysis.json`, worker reports/PNGs, and `feature-captures/manifest.json`. Runtime evidence and credentials are ignored by Git. Browser proof is under `runs/canvas-e2e/`.

## What completion means

Completed means the assigned read-only QA missions returned assessments. It does not prove that every possible state, device size, authenticated workflow, external destination, or consequential action has been tested. Feature groups can overlap; unmapped agent labels and batch-level screenshot review notes are retained separately from confirmed missing evidence.

Final review dismissed an early crawl observation claiming `/work` had no H1: later completed worker observations Q018 and Q046 contain the visible heading. The corrected report and canvas retain zero findings. One transient provider 500 error was recovered; the original attempt is retained in the worker evidence.

## Defaults and fixes exercised

The current fleet has no default shared API-call or total-agent cap. It starts with at least three workers and sizes simultaneous browsers to discovered work and available CPU/RAM, up to 16. Defaults allow 20 turns, 100 actions, 8,192 output tokens per response, and a 15-minute deadline. The trial used shorter focused missions, preserved completed work when its earlier deadline expired, and continued only the remaining assignments.

Live verification exercised fixes for slow-loading pages, single/batched computer actions, final assessments with the computer tool still enabled, transient API failures, screenshot evidence mapping, production upload serving, and multiple canvas imports with independent IDs and placement.

## Deployment boundary

The URL-first app is deployed at `https://ignura.com/astrahack`. Public job submission remains disabled until the deployment and a persistent Chrome worker share `ASTRAHACK_WORKER_TOKEN`. The model key stays only on the worker. This hosting configuration is separate from the successful local model-to-canvas trial. Setup is documented in [WEB_RUNS.md](WEB_RUNS.md).
