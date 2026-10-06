# Runbook: from a fresh laptop to the demo

For a teammate who just cloned the repo, or whose machine just died. Everything the product needs is in git. Keys live in `.env` (not in git). The shared board lives on Vercel Blob at https://ignura.com/astrahack.

## Six steps to a working demo

1. **Get Node 22.18 or newer and git.** `node -v` must print `v22.18` or higher (`nvm install 22`). Chrome and ffmpeg are optional: the mock demo needs neither.
2. **Clone and install.** One install, in the canvas app. The repo root has no dependencies.
   ```sh
   git clone https://github.com/jawadjalal/astrahack.git && cd astrahack
   npm run setup            # same as: cd canvas && npm install
   ```
3. **Check the machine.** Copy the env file (keys are optional) and run the doctor. It prints exactly what to fix and never prints a secret.
   ```sh
   cp .env.example .env     # add OPENAI_API_KEY / GEMINI_API_KEY if you have them
   npm run doctor
   ```
4. **See a full board with no keys and no Chrome** (about 30 seconds the first time). This starts the canvas for you if it is down, draws a recorded run of ignura.com and the launch kit (ad placeholders, X/Reddit drafts, UGC plan), and opens the browser.
   ```sh
   npm run teardown -- --mock --open
   ```
   It leaves the canvas running at http://localhost:3000/?view=canvas and prints how to stop it. Say "recorded run" and "sample kit" out loud; never call it live.
5. **Run it for real** on a URL with a throwaway or public target. Without `OPENAI_API_KEY` this uses scripted journeys (needs Chrome); with it, the Astra computer-use agent drives the browser and streams to the board live.
   ```sh
   npm run teardown -- https://ignura.com --kit --live
   ```
6. **Check the shared board** before anyone points a client at it, then rehearse with [DEMO.md](DEMO.md).
   ```sh
   npm run smoke:prod       # writes and reads back a few smoke- ops and an upload, then removes exactly those
   ```

## Commands

| Command | What it does |
| --- | --- |
| `npm run doctor` | Node, canvas deps, keys (set/missing only), Chrome, ffmpeg, local and deployed canvas, Blob-backed store. `-- --launch` also starts a real headless Chrome. |
| `npm run teardown -- <url>` | Canvas up (started if local and down), teardown run, evidence drawn on the board. Add `--kit` for ads, X/Reddit campaigns and a UGC plan. |
| `npm run teardown -- --mock` | No keys, no Chrome. `--fixture ignura` (default): recorded ignura.com run plus sample kit, all three lanes. `--fixture fernly`: instant fictional board with ranked findings (the one for the Reproduce and Explain beats), no kit. |
| `npm run teardown -- --replay <runDir>` | Draw an existing run directory (`report.json` or `qa-agent.json`). Runs are git-ignored, so only `ugc/fixtures/ignura` exists on a fresh clone. |
| `npm run smoke:prod` | Smoke test of the deployed canvas (`-- --canvas URL` for any other). Safe on a live board. |
| `npm run canvas` | Just the canvas (`PORT=3100 npm run canvas` for another port). |
| `npm run agent -- <url> --brief "..."` | The autonomous Astra agent directly ([AGENT.md](AGENT.md)). `--mock` needs no key. |
| `npm run ugc -- <runDir> --mock` | UGC plan ([UGC.md](UGC.md)). |
| `npm run generate` / `npm run campaigns` | Ad creatives and X/Reddit campaigns ([CREATIVES.md](CREATIVES.md), [CAMPAIGNS.md](CAMPAIGNS.md)). `--dry-run` needs no key. |
| `npm run worker` | The URL-first worker that serves ignura.com/astrahack ([WEB_RUNS.md](WEB_RUNS.md)). Needs `ASTRAHACK_WORKER_TOKEN`. |
| `npm test`, `npm run test:all`, `npm run check` | Unit tests (no install needed), plus the canvas MCP test (needs `npm run setup`), syntax check of every script. |

`teardown` flags worth knowing: `--canvas URL`, `--live` (animate), `--no-clear` / `--clear`, `--agent auto|astra|runner|custom`, `--brief TEXT`, `--paths /a,/b`, `--config journeys.json`, `--dry-run`, `--out DIR`. A local board is cleared first; a remote board is never cleared unless you pass `--clear`. `--mock` refuses a remote canvas unless you pass `--canvas` explicitly, so sample data cannot land on the shared board by accident.

Every optional piece is skipped with a one-line reason when its key or file is missing (no `GEMINI_API_KEY`: the ads lane shows the five prompts as grey cards and campaigns are skipped; no model key for UGC: the deterministic grounded plan is used).

## Who owns what

| Area | Owner | Where |
| --- | --- | --- |
| Canvas, MCP server, deploy (Vercel, Blob), `ops.ts` contract | @jawadjalal | `canvas/` ([MCP.md](MCP.md), [CANVAS_INTEGRATION.md](CANVAS_INTEGRATION.md)) |
| Operator: runner and run to canvas, marketing generators (ads, campaigns) | @niketh-putta | `src/runner.js`, `generate.mjs`, `campaigns.mjs` |
| UGC plan | @avi-aggarwal14 | `ugc/`, `bin/ugc.js` |
| Demo and pitch | @Welddevelopment | [DEMO.md](DEMO.md) |
| QA fleet, URL-first worker | Joel Jeon | `src/fleet.js`, `src/qa-agent.js`, `bin/web-worker.js` |
| Autonomous teardown agent, launch kit lane | see git log | `agent/`, `canvas/scripts/push-kit.mjs` |

See [CHANNELS.md](CHANNELS.md): one GitHub issue per workstream, label `ws:*`, post blockers as a comment tagging the owner with `status:blocked`. Contract changes to `canvas/src/lib/ops.ts` get a ping in issue #1 first.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `npm run doctor` says canvas dependencies missing | `npm run setup`. The canvas is the only package with dependencies. |
| `canvas/scripts` fail with a `.ts` import error | Node older than 22.18. `nvm install 22 && nvm use 22`. |
| Port 3000 busy, or "Another next dev server is already running" | Next allows one dev server per checkout. `teardown` detects a running one and uses it. Otherwise `PORT=3100 CANVAS_URL=http://localhost:3100 npm run teardown -- --mock`. Stop only your own: `kill -- -<pid>` as printed. Never `pkill`. |
| `git pull --rebase` refuses: unstaged changes | A tracked file got modified. `git status`, then `git stash push -u -m mine` (never a bare `git stash`: it is shared with other worktrees), pull, `git stash apply`. |
| "No Chrome/Chromium found" | Install Chrome, or `npx playwright install chromium` (found automatically), or set `ASTRAHACK_CHROME` in `.env`. `--mock` needs no browser. |
| "Chrome did not expose a CDP port" | Chrome started but never opened its DevTools port. Usual causes: the macOS display is asleep or locked (keep it awake: `caffeinate -d` in another terminal), a very loaded machine (startup can take 10 to 30 s; the wait is 30 s), or stale Chrome processes from killed runs (quit those by pid, not `pkill`). `npm run doctor -- --launch` reproduces it. Tests: `ASTRAHACK_SKIP_BROWSER_TESTS=1 npm test`. |
| Agent steps fail on macOS (`--backend macos`) | System Settings > Privacy & Security: Screen Recording and Accessibility for your terminal app, then quit and reopen it. The default `cdp` backend needs neither. |
| `OPENAI_API_KEY is required` / `Set GEMINI_API_KEY` | Put the key in `.env` (copy `.env.example`). Without keys use `--mock`, `--agent runner`, `--dry-run`. |
| Image generation 403 or 429 | The Gemini key lacks image-model access or quota. Try `--provider openai` with `OPENAI_API_KEY`, or `--dry-run`. |
| Board is empty after a push | Open `/?view=canvas`, not `/` (the root is the URL intake page). Check the toolbar says live. `curl -s $CANVAS_URL/api/state \| head -c 300`. A second push of the same run is ignored unless you `--clear`. |
| Deployed board loses data or `smoke:prod` fails on read-back | The Vercel project needs `CANVAS_STORE=blob` and a linked Blob store (`BLOB_READ_WRITE_TOKEN`). Ask @jawadjalal. |
| Upload over about 4.5 MB fails on the deployed canvas | Vercel body limit. `push-run.mjs` switches to direct Blob upload for big files when `canvas/node_modules` is installed. |
| The URL intake queues a run but nothing happens | `npm run worker` must be running on a machine with Chrome, `OPENAI_API_KEY` and the same `ASTRAHACK_WORKER_TOKEN` as the deployment ([WEB_RUNS.md](WEB_RUNS.md)). |
| Projector or canvas down mid-demo | Backup plan in [DEMO.md](DEMO.md). `npm run teardown -- --mock --fixture fernly --live` rebuilds a board in about 15 s. |

## If your machine dies

- **Everything is in git.** Clone on any teammate's laptop and follow the six steps. Nothing else is needed for the mock demo.
- **Push early, push often.** Commit your own files only (`git add <paths>`, never `-A`), then `git pull --rebase origin main && git push origin HEAD:main`. Retry if someone pushed in between. Unpushed work on a dead laptop is gone.
- **Not in git, so re-create it:** `.env` (ask the team for keys through your password manager, never chat or an issue), `runs/` (recorded runs: re-record, or use `ugc/fixtures/ignura`), `artifacts/` (generated ads and campaigns: re-run, or use `scripts/fixtures/mock-kit`), `canvas/public/uploads/` (local uploads).
- **The shared board survives.** https://ignura.com/astrahack is Blob-backed, so a dead laptop does not lose it. To rebuild it: `npm run teardown -- --mock --canvas https://ignura.com/astrahack --clear` (this wipes the board for everyone: only before the room is watching).
- **Safe handover of a long run:** the agent writes everything to its run directory as it goes; copy that directory (or `git add -f` it to a branch) before the laptop closes, then `npm run teardown -- --replay <runDir>` anywhere.
