# QA evidence analysis

## What counts as a finding

The board flags **functional** issues only. A finding is observable broken behavior, not an opinion about design.

Functional (reported):

- A flow that cannot be completed.
- An action with no effect or the wrong effect: a button that does nothing, a save that does not persist.
- An error, crash, blank screen or stuck state.
- Wrong or inconsistent data or state: a counter, balance or total that does not update or contradicts another number on screen.
- Validation that blocks valid input or accepts invalid input.
- A dead link, a 404 or a redirect loop.
- Broken navigation, back or refresh (state lost).
- A console error or failed network request (4xx or 5xx) tied to a user action.
- An accessibility blocker that stops task completion: a control that cannot be reached, a focus trap.
- Slowness only when it blocks the task: a timeout, a spinner that never ends.

Not functional, left out by default: colors, spacing, typography, "could be clearer" copy, taste, layout preferences, missing polish, marketing suggestions, and speculation about what might go wrong.

Every finding carries a `category` (`functional`, `usability` or `visual`), exact reproduction steps, `expected` and `actual` behavior, and evidence (a step, screenshot or evidence ID). A finding missing any of these is discarded. A reference to a step that was never recorded does not count as evidence.

One small module, `src/findings-filter.js`, holds the definition, the prompt text and the filter (`isFunctionalFinding`, `filterFindings`). `canvas/src/lib/findings-filter.mjs` is a byte-identical copy so the canvas deploys on its own; a test fails if the two drift (copy `src` over `canvas` after editing). Every producer states the definition in its prompt, asks the model for `category: "functional"` only, and passes what it emits through the filter:

| Producer | Where | What is left out |
| --- | --- | --- |
| Scripted runner | `src/runner.js` | Steps the author labeled `usability` or `visual` go to `report.excludedFindings` |
| Crawler | `src/crawl.js` | HTTP and navigation errors are functional. Missing title or H1 are `usability`, recorded only with `--include-design` |
| QA agent | `src/qa-agent.js` | `assessment.excludedIssues` lists dropped issues with reasons |
| Fleet | `src/fleet.js` | Merged issues are re-checked; an issue whose step is not in the combined run is dropped |
| QA analysis | `src/qa-analysis.js` | `qa-analysis.json` `excludedFindings` |
| Teardown agent | `agent/` | `report.json` `rejectedFindings`; the model is told why |
| Canvas | `runToOps.ts`, `push-run.mjs` | Printed on stderr; no card is drawn |

The filter works two ways. By category: an explicit `usability` or `visual` is a design observation. By wording: a finding labeled `functional` that reads as taste (color, font, spacing, looks, prefer, consider, could be, unclear, contrast) is reclassified, unless it also shows behavior breaking (does nothing, error, 500, not updated, stuck, cannot). The wording check is a safety net, not a replacement for a good prompt.

`--include-design` (on `astrahack.js`, `qa.js`, `analyze-qa.js`, `agent/run.mjs` and `push-run.mjs`) keeps `usability` and `visual` findings. They are always severity `info`, sorted after the functional ones, and on the canvas their title is prefixed `[usability]` or `[visual]`. They still need steps, expected vs actual and evidence.

## Running the analysis

Run the QA fleet, then analyze its saved crawl and computer-use evidence:

```sh
node bin/qa.js fleet examples/qa.json --output runs/example
OPENAI_API_KEY=... node bin/analyze-qa.js runs/example
```

The analysis command writes `qa-analysis.json` and `qa-analysis.md` in the run directory. It uses `gpt-6-luna` through the Responses API by default. Set `OPENAI_QA_ANALYSIS_MODEL` or pass `--model MODEL` to choose another model. `--no-images` sends the recorded observations and actions without screenshots.

Evidence IDs are stable within one analysis: `C001` identifies the first crawled page, `CF001` the first crawler finding, `W001` worker A001, and `Q001` the first global computer action. The report's evidence index maps each ID to its source JSON file, worker mission, URL, and screenshot path. Worker issue references are checked against both the global step index and worker ID. Missing screenshot files and mismatched screenshot references are called out. Invalid model references are discarded. Up to four screenshots are supplied to the model when available.

`recorded` findings come directly from crawler checks (HTTP and navigation errors). `agent_reported` findings come from the computer agent's assessment and link to its recorded action; their reproduction steps are agent proposed and need review. `unverified` flags a missing or mismatched action, worker, or screenshot reference. `hypothesis` findings are the analysis model's additional interpretations and require human reproduction. Findings are ordered by severity, with expected and actual behavior, reproduction steps, and evidence references. The report states crawl gaps, incomplete workers, and the portion of the evidence index sampled for model analysis. Every recorded finding remains in the report even when a large fleet run exceeds the model sample limit.

HTML title and H1 checks on linked media files such as MP4s are excluded from the findings and counted as an analysis limit; those files are assets, not HTML pages. On real pages these checks are `usability` findings, so they only appear with `--include-design`.

Candidates that are design opinions, speculation, or lack steps, expected vs actual or evidence are listed in `excludedFindings` (summary, category, reasons) and counted in `qa-analysis.md`; they never become findings.

Initial missing-title or missing-H1 checks are superseded when a later successful observation from a completed worker records that element at the same URL. The report preserves the original check and exact counter-evidence IDs in `dismissedFindings`; superseded checks are removed from the findings. `reconcileCrawlEvidence()` applies this correction to a saved report without making another API request.

## Canvas handoff

The shared canvas push script reads `qa-analysis.json` beside `qa-agent.json` or `crawl.json`. Inspect the generated operations without uploading or posting anything:

```sh
node canvas/scripts/push-run.mjs runs/example --dry-run > runs/example/canvas-ops.json
```

For a running local canvas, use `node canvas/scripts/push-run.mjs runs/example --canvas http://localhost:3000`. It uploads screenshots and posts the operations. Crawl page evidence (`C...`), crawler findings (`CF...`), and computer actions (`Q...`) link to their matching screenshots when present. The finding card includes its evidence IDs and reproduction text. This handoff makes no OpenAI request.
