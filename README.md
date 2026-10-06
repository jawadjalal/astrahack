# AstraHack

AstraHack is an early-stage system of agents that explores a startup's website or app, checks how it works, and turns what it learns into useful product and marketing outputs.

## Initial MVP

Given access to a website or app and a short brief, the agents should be able to:

1. **Explore and understand the product.** Use computer control to navigate the real website or app, try important user journeys, and build a grounded picture of what the product does and who it is for.
2. **Run practical QA.** Identify broken flows, confusing interactions, and other observable problems. Record the steps taken, expected and actual behavior, and supporting screenshots or video.
3. **Capture product assets.** Take screenshots and short screen recordings of meaningful features and flows that can be used in reports and promotional work.
4. **Create ad concepts and images.** Use the observed product experience and captured assets to propose messages and generate images for advertisements.
5. **Plan UGC campaigns.** Suggest creator angles, hooks, example scripts, and a campaign plan grounded in the product's actual features and audience.

The output of a run is a concise product understanding, a prioritized QA report with evidence, a set of captured product assets, ad image concepts, and a UGC campaign plan. The agents should distinguish what they directly observed from assumptions or proposed marketing claims.

## Our focus: computer use

We own the computer-use slice. Its job is to **use the website or app and understand it**, then give the other agents reliable context and evidence. In the MVP, that means:

- Open the website in a browser or the app in its supported environment, navigate its interface, and exercise key flows as a user would.
- Keep track of the actions taken, screens visited, and outcomes observed.
- Capture screenshots and video at useful moments.
- Describe the product's features, user journeys, and friction points in a structured handoff.
- Report failures with reproducible steps and evidence.

The computer-use agent is the source of observed product knowledge for QA and promotional planning. Generated ads and UGC ideas should build on that knowledge, while remaining clearly identified as creative proposals.

## MVP success criteria

For one supported website or app, a run should complete a small set of important user journeys and produce evidence that another person can review: what the agent did, what it saw, where it got stuck, and what it learned. The QA findings should be reproducible, and the promotional outputs should refer to features the agent actually found in the product.

## Computer-use runner: first vertical slice

The repository now includes a dependency-free Node.js runner. It controls a real Chromium page through the Chrome DevTools Protocol (CDP), executes a declared user journey, and writes a machine-readable evidence bundle. A website launches in its own temporary Chrome profile. An Electron app can be attached through a CDP port exposed by that app. This is a practical foundation for an agent to choose and run journeys; the current runner does **not** autonomously decide which product flows matter.

### Requirements

- Node.js 22 or newer.
- Google Chrome or another Chromium executable for website runs.
- For video, an `ffmpeg` executable with MJPEG input and VP8/WebM output. Video is optional.
- For an Electron app, an already running renderer with CDP enabled (for example, start an app you control with `--remote-debugging-port=9222`). Some apps disable this flag or require a different launch method.

No `npm install` is needed. The runner uses Node's built-in WebSocket client.

### Run a website

Copy and edit [`examples/website.json`](examples/website.json). Set `target.url`, then describe the journeys and assertions that matter for that product.

```sh
ASTRAHACK_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  node bin/astrahack.js examples/website.json --output runs/example
```

Use `--headed` to watch the browser. Pass `--ffmpeg /path/to/ffmpeg` (or set `ASTRAHACK_FFMPEG`) and set `"video": true` on a journey to record it. The captured WebM contains the browser viewport, sampled at 2 frames per second. It has no audio.

### Run an Electron app

Copy and edit [`examples/electron.json`](examples/electron.json). Set `target.cdpPort` and optionally `target.pageMatch` to select the renderer by URL or title. Start the app with remote debugging enabled, then run:

```sh
node bin/astrahack.js examples/electron.json --output runs/electron-check --ffmpeg /path/to/ffmpeg
```

Electron mode controls the renderer's page content. It cannot inspect native menus, file pickers, permission prompts, or other operating-system UI. General native macOS, Windows, iOS, and Android apps are not yet supported.

### Journey format

Each `journeys[]` entry has a `name`, optional `video`, and ordered `steps`. Supported actions are:

| Action | Fields | Effect |
| --- | --- | --- |
| `goto` | `url` | Navigate to a URL, relative to the target website URL when applicable. |
| `click` | `selector` | Click the visible element at its screen position. |
| `fill` | `selector`, `value` or `valueFromEnv` | Focus and type into a form field. Use environment variables for credentials. |
| `press` | `key` | Press `Enter`, `Tab`, `Escape`, or `Backspace`. |
| `waitFor` | `selector`, optional `timeoutMs` | Wait for an element to exist. |
| `assertText` | `text` | Require text somewhere on the page. |
| `assertUrl` | `contains` | Require a URL substring. |
| `wait` | `ms` | Pause up to 30 seconds. |
| `observe` | none | Capture the current screen and page summary. |

Any step may include `settleMs`, `expected`, `failureSummary`, and `severity`. A failing step stops that journey, captures evidence, and creates a QA finding. The next journey runs in the same session. Journey authors should add an initial `goto` when a flow needs a clean starting page.

### Evidence and handoff

Every run writes `report.json`, `screenshots/*.png`, and optional `video/*.webm` under the output directory. The report contains:

- `product`: observed URL, title, description, headings, visible controls, and a short excerpt of page text.
- `journeys`: every action, outcome, timestamp, page observation, and screenshot path.
- `findings`: failed assertions/actions with expected and actual behavior, reproduction steps, severity, and evidence path.
- `assets`: screenshot and video manifest for downstream marketing agents.

The report records observed facts only. Downstream agents should treat marketing claims and audience assumptions as proposals until verified. `fill` values are redacted in the JSON, but screenshots and video can show sensitive content; use test accounts and review evidence before sharing it. Runs are ignored by Git.

Exit status is `0` for a passing run, `1` for QA findings, and `2` for setup or runtime errors. Run `npm test` for the local fixture integration test.

### Adaptive computer-use QA fleet

The crawler inventories same-origin pages and saves screenshots. The fleet then starts three distinct scouts: a user journey, a feature map, and a controls or navigation audit. Additional workers cover observed pages and newly discovered routes or controls. Each worker has its own Chrome profile and uses screenshot-driven mouse and keyboard actions through the OpenAI `computer` tool. The initial inventory is sequential; worker missions run concurrently.

**GPT-6 Luna is the default.** Agent count follows the discovered work, with no fixed 60-agent allocation. Parallelism scales from three to 16 browsers based on discovered work and available CPU/RAM; the total number of agents is adaptive. There is no default API-call cap. A 15-minute run deadline (including initial crawl time), up to 20 turns/100 actions per worker, and 8,192 output tokens per response keep each run bounded; these are not a guaranteed dollar cap. Actual API token usage is recorded. There are no automatic paid retries or model upgrades. Set `OPENAI_QA_MODEL` or pass `--model` for a deliberate targeted rerun with another model.

Copy [`examples/qa.json`](examples/qa.json), set its URL, and put `OPENAI_API_KEY` in the ignored local `.env`. Then run:

```sh
ASTRAHACK_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  node bin/qa.js fleet examples/qa.json --output runs/site-fleet
```

The CLI loads `.env`. Omit `maxAgents`, `concurrency`, and `maxRequests` for automatic sizing without an API-call cap. Optional explicit ceilings are available for constrained environments; `maxAgents` must be at least three. `maxTurns` and `maxActions` apply per worker, while an optional `maxRequests` and the `maxDurationMs` deadline are shared. To collect evidence without API charges, use `crawl` instead of `fleet`; `agent` runs a single targeted worker.

The fleet writes `crawl.json`, `fleet.json`, a combined `qa-agent.json`, and `workers/A###/qa-agent.json`. Reports include worker IDs, globally numbered actions, actual token usage, screenshots, unscheduled missions, failed workers, and uncovered routes. An unfinished fleet reports partial coverage and exits with status 1; setup errors exit with status 2. Reaching a limit never means the whole site passed QA.

The browser adapter supports clicks, double clicks, scrolling, dragging, typing, and keyboard chords. It blocks external links and several consequential control labels. Native dialogs and authenticated sessions are outside the current isolated-profile setup. Assessments remain separate from action records; missing evidence references are marked unverified.

### Feature screenshots, analysis, and canvas

The downstream agents also default to Luna. They review observed evidence, produce a curated screenshot set and QA findings, and explicitly list coverage gaps. Each stage makes its own API call:

```sh
node --env-file-if-exists=.env bin/analyze-qa.js runs/site-fleet
node --env-file-if-exists=.env bin/feature-capture.js runs/site-fleet/fleet.json
```

Models can be overridden with `OPENAI_QA_ANALYSIS_MODEL`, `OPENAI_SCREENSHOT_MODEL`, or each CLI's `--model` option. Captures are written under `feature-captures/`; analysis writes `qa-analysis.json` and `qa-analysis.md`. See the [capture contract](docs/FEATURE_CAPTURE_CONTRACT.md) and [QA analysis guide](docs/QA_ANALYSIS.md).

To place evidence and curated features on a running canvas:

```sh
node canvas/scripts/push-run.mjs runs/site-fleet --canvas http://localhost:3000
node bin/feature-canvas.js runs/site-fleet/feature-captures/manifest.json --canvas-url http://localhost:3000
```

These import commands add to the canvas. See [canvas integration](docs/CANVAS_INTEGRATION.md) for server startup and the shared operations used by screenshots, findings, creative images, and campaign text. The QA workers do not generate ad creatives or UGC plans; those workstreams can consume this evidence and use the same canvas contract.

Run `npm test` for the local runner/fleet tests, which use real isolated Chrome sessions with mocked API responses and incur no model charges. Canvas checks are separate under `canvas/`.

## Generate five square ad creatives

The creative slice accepts a supplied prompt and produces five distinct 1024×1024 PNG ad images. No UI or running service is needed. Requires Node.js 22.9 or newer.

```sh
npm run generate -- --prompt-file brief.txt
```

Set `OPENAI_API_KEY` in your environment or local `.env` first. Without a key, prepare the five prompts:

```sh
npm run generate -- --prompt "Your product facts and ad brief" --dry-run
```

Images and a status manifest go into a unique folder under `artifacts/`. The computer-use runner above is preserved; its findings can inform the supplied prompt. See [creative generator usage](docs/CREATIVES.md) and [code integration](docs/INTEGRATION.md).

The docs in `docs/` describe the creative slice; the computer-use scope and usage remain documented above.

## Nano Banana (default)

Set `GEMINI_API_KEY` in your local `.env`, then run `npm run generate -- --prompt-file brief.txt`. Generates five distinct 1024×1024 PNGs using Google Nano Banana. Obtain the key from https://aistudio.google.com/api-keys; image generation requires model access and available quota. Use `--dry-run` without a key. To switch later, set `OPENAI_API_KEY` and pass `--provider openai`. Override the model with `--model`. Keys are never stored in output manifests.

## Generate X and Reddit GTM campaigns

Turn the same product brief into detailed text campaigns, alongside the image creatives:

```sh
npm run campaigns -- --prompt-file brief.txt
```

Uses `GEMINI_API_KEY` and a separate text model (`GEMINI_TEXT_MODEL`). Produces Markdown and JSON containing channel strategy, finished post drafts, a 14-day calendar, conversion tracking, experiments and launch checklists. Use `--channel x` or `--channel reddit` to select one channel, or `--dry-run` to prepare prompts without API calls. See [campaign generation and integration](docs/CAMPAIGNS.md).
