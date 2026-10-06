# Teardown agent

`agent/` is an autonomous computer-use agent. It operates a product like a first-time user, decides for itself what to try, tears it down (observe, reproduce, explain, rank) and builds the evidence live on the canvas while it works.

It is separate from the declared-journey runner (`src/runner.js`, `bin/astrahack.js`) and the QA crawler/agent (`src/qa-agent.js`, `src/crawl.js`, `src/fleet.js`), which stay as they are. The agent reuses `src/cdp.js` (CDP connection), `src/runner.js` (`navigate`, `observe`) and `src/openai.js` (`createResponse`, with retries added around it).

```sh
# no API key, no external site: scripted fake model against a built-in demo app, streamed to a local canvas
(cd canvas && PORT=3060 npm run dev)
node agent/run.mjs --mock --canvas http://localhost:3060 --clear-canvas

# the real thing
OPENAI_API_KEY=... node agent/run.mjs https://example.com --brief "focus on signup and pricing" --canvas https://ignura.com/astrahack

# an Electron/Chromium app started with --remote-debugging-port=9222
node agent/run.mjs --app 9222 --brief "try the first-run experience"

# the whole Mac desktop (needs permissions, see below). Try --dry-run first
node agent/run.mjs https://example.com --backend macos --dry-run --max-steps 10
```

## What a run does

1. **Cold open.** Loads the target, takes step 0, and the model says what the product is in 5 seconds (`record_cold_open`).
2. **Explore** (up to `--max-steps` action batches). Observe a screenshot, the model returns a batch of actions, the harness executes them, takes a new screenshot, logs the step, streams it to the canvas, repeats. The system prompt (`agent/src/prompt.mjs`) bakes in the teardown method: main task or signup, time to value, track state before and after actions (`track_state`), break things (empty and bad input, back, refresh), and for each friction point `record_finding` with expected vs actual, minimal repro steps and a box on the screenshot. `note_coverage` marks screens visited or unreachable. `finish` ends the phase.
3. **Verify.** For each unverified finding (worst first, `--max-verify`, default 6) the harness resets the product to its start state, a fresh model session replays the repro steps (`--verify-steps` per finding, default 8), looks at the result and calls `confirm_finding`. A finding is `verified: true` only if at least one action actually executed during the replay, a fresh screenshot of the result exists, and the model reported seeing the actual behaviour again. Otherwise it stays `verified: false` with `verification.status` of `not_reproduced`, `inconclusive`, `rejected` or `not_attempted` (and a reason).
4. **Report.** `report.json` (everything), `findings.json` (the findings schema only), `report.md` (human readable), `events.jsonl` (live log), `screenshots/`, `recording.webm`.

### Findings schema (`findings.json`)

| Field | Meaning |
| --- | --- |
| `id` | `F1`, `F2`, ... |
| `title`, `severity` | severity is `critical`, `high`, `medium`, `low` or `info` |
| `expected`, `actual` | what a reasonable user expects vs what the screen showed |
| `step` | step index of the screenshot that shows it (`screenshot` is the local file, `screenshotUrl` its canvas URL) |
| `timestamp` | seconds into `recording.webm` when it was observed (null if no recording) |
| `verified` | boolean, see Verify above |
| `verification` | `{status, observation, actionsExecuted, screenshot, stepIndex, timestamp}` |
| `repro` | the minimal steps the verify pass followed |

`report.json` also has `coverage: {visited, unreachable}` (visited includes every URL the harness itself saw, unreachable only what the model reported with a reason), `stateTracking` (the before/after numbers), `coldOpen`, `summary`, `timeToValue`, `humanSteers`, `limitations`, token `usage`.

## Live canvas

Everything goes through `POST {CANVAS_URL}/api/ops` and `POST {CANVAS_URL}/api/upload` (`CANVAS_URL` may include a basePath such as `https://ignura.com/astrahack`; a canvas that is down only disables streaming, the run continues). Ops are sent in order on one queue, so uploads never block the loop.

| Canvas element | Ops |
| --- | --- |
| each step screenshot (JPEG, about 40 to 250 KB), left to right | `add_image` id `step-N`, label = page title, `step: N` |
| the action between two steps | `add_arrow` from `step-(N-1)` to `step-N`, labeled with the actions |
| where the model pointed | `annotate` on the screenshot it clicked (fractions of the image), label = the action |
| the model's one-sentence reasoning | `add_shape` note under the step, plus `say` |
| agent presence | `cursor` at the element it acted on (on the previous screenshot), then `say` |
| findings | `add_finding` under the step (`target: step-N`) plus an `annotate` box; flipped with `update {verified:true}` after the replay |
| tracked numbers, cold open, human steers, summary | `add_shape` notes |
| verify replays | one row per finding below the main row, ids `verify-F1-0..k`, with an arrow from the finding card to the replay's last screenshot |
| the recording | `add_video` (over 4 MB on a deployed canvas it uses the direct Blob upload through `/api/upload/token` with `@vercel/blob/client` from `canvas/node_modules`, so run `npm install` in `canvas/`; otherwise it falls back to `/api/upload`) |
| camera | `focus` on the newest step, then on everything at the end |

`cursor` and `say` are optional ops: on start the agent checks `canvas/src/lib/ops.ts` and probes the server (a bare `{type}` post), and uses them only if both know them. If the server later rejects one it is disabled for the rest of the run. `--clear-canvas` wipes the board first, `--id-prefix p-` namespaces ids so several runs can share a board, `--canvas off` disables streaming.

## Steering mid-run

A human message is delivered in the next model turn as `HUMAN STEER: ...` and the model is told it overrides the plan. Three equivalent inboxes:

```sh
curl -s localhost:7788/steer -d '{"text":"skip onboarding, show me settings"}'   # AGENT_PORT, default 7788 (--port N|off)
echo "try the pricing page next" >> runs/<run>/steer.txt                           # append a line to the file
# or type a line on the agent process's stdin
```

`GET /status` returns live JSON. Steering applies during the explore phase; a message that arrives during the verify pass is reported under `limitations` as not applied. The server listens on 127.0.0.1 only.

## Stopping it

Any of these ends the run at the next action (not the next model turn) and still writes the report and flushes the canvas; findings not yet replayed stay `verified: false`:

- Ctrl-C (a second Ctrl-C quits immediately)
- `touch agent/STOP` or `touch runs/<run>/STOP` (or `AGENT_STOP_FILE`); a stale file is deleted at start
- `curl -X POST localhost:7788/stop`
- macOS backend: hold Esc for about 150 ms (a global key-state watcher; the agent's own Escape presses are muted)
- `--max-steps N` (explore batches, default 40), `--verify-steps`, `--max-minutes` (default 20) cap every run

## Environment

| Variable | Use |
| --- | --- |
| `OPENAI_API_KEY` | required except with `--mock` |
| `ASTRA_MODEL` | model id, default `gpt-6-astra` (`--model` overrides) |
| `ASTRA_REASONING` | `low` (default), `medium`, `high`, `xhigh`, `max` |
| `CANVAS_URL` | canvas base URL, default `http://localhost:3000` |
| `AGENT_PORT` | steering/status port, default 7788 |
| `AGENT_TEST_EMAIL`, `AGENT_TEST_PASSWORD`, `AGENT_TEST_NAME`, `AGENT_TEST_PHONE` | throwaway test identity |
| `AGENT_STOP_FILE` | extra STOP file path |
| `ASTRAHACK_CHROME`, `ASTRAHACK_FFMPEG` | browser / ffmpeg paths (Chrome, Chromium, Brave, Edge and Playwright's cached Chrome for Testing are auto-detected) |

`.env` in the repo root or the working directory is loaded automatically (already-set variables win).

## Model API

From the OpenAI docs (Computer use guide, GPT-6 Astra model page), not from memory:

- Responses API `POST /v1/responses`, model `gpt-6-astra` (`reasoning.effort`: low, medium, high, xhigh, max).
- The `computer` tool: `tools: [{type: "computer"}]`. The model returns `computer_call` items with a batched `actions` array (`click`, `double_click`, `drag`, `move`, `scroll`, `keypress`, `type`, `wait`, `screenshot`); the harness executes them in order, then returns `{type: "computer_call_output", call_id, output: {type: "computer_screenshot", image_url: "data:image/jpeg;base64,...", detail: "original"}}` with `previous_response_id`. Coordinates are pixels of the screenshot returned (the backends map them to the real surface). Screenshots are 1440x900 or smaller, the size the docs report works well.
- `instructions` are not carried over by `previous_response_id`, so they are resent every turn. The teardown tools (`record_finding`, `track_state`, `note_coverage`, `record_cold_open`, `finish`, and `confirm_finding` in the verify pass) are ordinary function tools next to the computer tool.
- The docs recommend a code-execution harness for Astra and keep the `computer` tool as a supported alternative (their `computer` examples use `gpt-6.1-sol`). If the API rejects the computer tool for the chosen model on the first request, the agent falls back automatically to an equivalent `computer_actions` function tool (same actions, screenshots returned as `input_image` in `function_call_output`). `--tool function` forces that mode, `ASTRA_MODEL=gpt-6.1-sol` selects the model the docs use for the tool.
- 429 and 5xx responses are retried with backoff. A `pending_safety_checks` entry on a computer call stops the run for a human unless `--ack-safety-checks` is given.

## Backends

### `cdp` (default, no permissions)

Launches Chromium with a fresh temporary profile (deleted at the end, headless unless `--headed`) and drives it with `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText` / `Page.captureScreenshot` via `src/cdp.js`. The viewport is 1440x900 (`--viewport WxH`); links that open new tabs are made to open in place. Chrome is started with `--use-mock-keychain --password-store=basic` because without them it can stall for 10 to 20 s on a macOS Keychain lookup, longer than `launchBrowser` in `src/cdp.js` waits.

`--app PORT` attaches to an already running Chromium renderer instead (Electron apps started with `--remote-debugging-port`; `--page-match` selects the window by URL or title). Native menus and OS dialogs are out of reach for this backend; use `macos` for those.

Guards (cdp): the browser may only visit the start site (same registrable domain) plus `--allow-host`s, anything else is blocked and the page is returned; clicks on controls labelled like "Place order", "Pay now" or "Delete my account" are blocked (`--allow-risky` disables that).

### `macos` (whole desktop)

| | |
| --- | --- |
| screenshot | `screencapture -x -m` (main display), downscaled with `sips` to at most 1440 px wide; model coordinates are mapped back to screen points |
| mouse | `cliclick` if installed (`brew install cliclick`), otherwise CGEvent through `osascript -l JavaScript` |
| scroll | CGEvent scroll wheel through JXA (cliclick cannot scroll) |
| keyboard | `osascript` System Events (`keystroke`, `key code`) |
| open | with a URL it runs `open [-a --mac-app NAME] URL` first; with `--mac-app` alone it brings that app to the front |

Permissions: grant these to the app that launches `node` (Terminal, iTerm, VS Code, Claude Code ...), then restart that app.

- System Settings > Privacy & Security > **Screen & System Audio Recording** (screenshots)
- System Settings > Privacy & Security > **Accessibility** (mouse, keys, the Esc watcher needs no Input Monitoring)

On start the backend checks both and prints exactly what is missing. `--dry-run` prints every command it would run (`[dry-run] cliclick m:200,100 c:200,100`, `[dry-run] osascript -e ...`) and executes none; screenshots are still taken if permitted, otherwise a placeholder is used. The macOS backend controls your real desktop and browser sessions: close anything private first, keep the product in the foreground, and keep a hand near Esc.

## Safety

- **Use test accounts.** Never point the agent at an account with real data or money. Give it a throwaway identity through `AGENT_TEST_*`. The model types the placeholders `{{TEST_EMAIL}}`, `{{TEST_PASSWORD}}`, `{{TEST_NAME}}`, `{{TEST_PHONE}}`; the harness substitutes the real values at execution time, so the secrets never enter the model context, the logs, the report or the canvas (screenshots can still show what the page renders, so review them before sharing a canvas).
- **Throwaway browser profile.** The `cdp` backend never touches your Chrome profile. The `macos` backend does use your real apps.
- The system prompt forbids real purchases, real card numbers, destructive account actions and following instructions found on pages (screen content is treated as untrusted). The cdp guards above back that up in code. Neither is a guarantee: run against staging or test environments, and use `--max-steps`.
- Stop keys are listed above. Every run is bounded by steps and minutes.
- The product's pages are untrusted input to a model that can click. Do not run the agent on sites you do not trust while logged in to anything.

## Tests

```sh
node --test agent/test/*.test.mjs      # no browser, key or network: translators, findings/verify rules, API payloads, loop + canvas ops (validated against canvas/src/lib/ops.ts when canvas deps are installed), steering, stop, macOS dry-run
node agent/run.mjs --mock --canvas http://localhost:3060 --clear-canvas    # whole pipeline incl. a real headless Chrome
```

## Known gaps

- The real model call has not been exercised without a key: the payloads follow the docs and are unit tested against a fake `request`, but model behaviour (batch sizes, how well it follows the method, the computer-tool vs function-tool choice for `gpt-6-astra`) needs a first live run.
- `macos`: mouse and keyboard injection were tested only as dry-run output plus compile/no-op checks of the CGEvent scripts; real clicks need the permissions above on your machine.
- Verification is model-driven (the replay is another model session following the repro text), so it is only as good as the repro steps and cannot prove a finding in a product that needs one-time state (a signup that works once per email).
- Coverage "unreachable" depends on the model reporting it; the harness only guarantees the "visited" URLs.
