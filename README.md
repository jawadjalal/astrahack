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

### QA crawl and Astra agent

The QA fleet has two more stages. A bounded crawler follows same-origin HTML links and saves a page inventory, screenshots, basic navigation findings, and an `observations[]` handoff for feature capture. A GPT-6 Astra computer-use agent then exercises read-only flows in an isolated Chrome profile and records each UI action with an observation and screenshot.

Copy and edit [`examples/qa.json`](examples/qa.json), then run:

```sh
ASTRAHACK_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  npm run qa -- crawl examples/qa.json --output runs/site-crawl

OPENAI_API_KEY=... ASTRAHACK_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  npm run qa -- agent examples/qa.json --output runs/site-agent
```

The crawler writes `crawl.json`; the agent writes `qa-agent.json`. Both are accepted by the feature capture tool. The agent uses the OpenAI Responses API with model `gpt-6-astra` and the `computer` tool. It sends current viewport screenshots to the API, then executes bounded mouse and keyboard actions in Chrome. `maxTurns` and `maxActions` limit the run. It blocks external links and several consequential button labels, and resets navigation if the page leaves the starting origin. Treat these as MVP safeguards: run against a test account and review any site that can make consequential changes through innocuous controls. Agent assessments are kept separate from observed action records; issue references without a matching evidence step are marked unverified.

The crawler is read-only and does not bypass login, expand every interaction, or infer all product features from links alone. The model agent can interact with visible controls but cannot handle native dialogs. The `OPENAI_API_KEY` variable is needed only for the model-driven stage. The local tests use a mocked API response and do not incur API charges.

### Capture major feature screenshots

After a run, use the dedicated feature capture agent to review the observed screens with GPT-6 Astra and create a curated screenshot set:

```sh
OPENAI_API_KEY=... node bin/feature-capture.js runs/example/report.json
```

It writes `feature-captures/manifest.json` and selected PNGs beside the QA report. The manifest links each screenshot to its source observation and lists evidence gaps. The QA report remains the input contract; see [the capture contract](docs/FEATURE_CAPTURE_CONTRACT.md) for the supported crawler shape and limitations. The agent requires an OpenAI API key and sends short page observations to the Responses API.

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
