# Runner output on the canvas

A computer-use run (runner, QA agent or fleet) can be drawn on the live canvas as a left-to-right flow: one screenshot per step, arrows between steps, highlight boxes, finding cards under the step they belong to, and the recording.

## One-liner

```sh
# canvas running: cd canvas && npm run dev   (or point at a deployed canvas)
node canvas/scripts/push-run.mjs runs/example --canvas http://localhost:3000 --live
```

`<runDir>` is the output directory of `node bin/astrahack.js ... --output runs/example` (it reads `report.json`), or of `npm run qa -- agent|fleet` (it reads `qa-agent.json`). A `qa-analysis.json` in the same directory is picked up automatically. You can also pass a report file directly.

| Flag | Effect |
| --- | --- |
| `--canvas URL` | Canvas base URL. Default `$CANVAS_URL`, else `http://localhost:3000`. Base paths work: `CANVAS_URL=https://ignura.com/astrahack` calls `https://ignura.com/astrahack/api/...`. |
| `--live` | Posts one step at a time with ~400 ms between steps so the canvas animates for a watcher. `--delay ms` overrides. |
| `--clear` | Wipe the board first. Without it, a second push of the same run is ignored (ids already exist). |
| `--layout single` | Put every step on one row instead of one row per journey. |
| `--dry-run` | Print the ops, upload and post nothing. |

Screenshots and videos are uploaded through `POST /api/upload` (multipart `file`) and each op's `src` is the returned `url` unchanged. Files over 4 MB try direct Blob upload through `/api/upload/token` when `@vercel/blob` is installed, then fall back to multipart. Files the report mentions but that are missing on disk are skipped, along with their steps.

## From code

```js
import { runToOps } from './canvas/src/lib/runToOps.ts'; // Node >= 22.18 strips the types

const ops = runToOps(report, { analysis, srcMap, sizes });
await fetch(`${CANVAS_URL}/api/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ops) });
```

`runToOps(bundle, opts)` is pure: no I/O, returns `Op[]` (the contract in `canvas/src/lib/ops.ts`). `bundle` is a runner `report.json`, a `qa-agent.json` / fleet combined report, or `{ report, analysis }`.

Options: `srcMap` / `srcFor` (bundle path to hosted URL; unmapped paths pass through unchanged), `sizes` (`{ [path]: { w, h } }` natural pixel sizes, for exact aspect ratios and pixel regions), `analysis`, `layout` (`journeys` | `single`), `stepWidth` (520), `gap` (140), `includeInitial`, `title`, `focus` (false to omit the final focus).

## How a run becomes ops

| Bundle field | Op |
| --- | --- |
| report name, target URL, status, counts | one `add_shape` note `run-title` at the top |
| each `journeys[]` entry (or each `workerId` in an agent/fleet report) | a text header and one row |
| each step with a `screenshot` | `add_image` id `step-<index>`, `step` = index, `label` = step description (`goto /`, `click a.buy`, `assertText "Order total" (failed)`; agent steps: `click (10, 20)`) |
| consecutive steps in a row | `add_arrow` id `arrow-<index>` |
| `regions` / `region` / `box` on a step or finding | `annotate` on that step image. Fractions (0..1) pass through; `{ unit: "pixels" }` boxes are divided by the image size (from `sizes` or `viewport`) and dropped when no size is known |
| `findings[]` (runner), `assessment.issues[]` (agent), `findings[]` of `qa-analysis.json` | `add_finding` below the step image, `target` = that step id. With an analysis, its findings replace `assessment.issues` |
| `journeys[].video` or a top-level video asset | `add_video` at the end of its row |
| everything | final `focus` over all created ids |

Finding fields:

- **Step**: runner `evidence` path or `evidenceStep`; analysis `evidenceRefs` entries like `Q003` (action 3). Crawler refs (`C001`, `CF001`) have no step image, so those findings go in a "Findings without a screenshot" row at the bottom.
- **severity**: `critical|high|medium|low|info`. `blocker`/`p0` map to critical, `major`/`error` to high, `minor` to low, `note` to info, anything unknown to medium.
- **verified**: an explicit `verified`/`reproduced` boolean wins; else `verification` of `recorded`/`verified`/`reproduced` is true and `agent_reported`/`hypothesis`/`unverified` are false; else a runner finding is true when it recorded `stepsToReproduce` and has step evidence.
- **timestamp**: `finding.timestamp` when present; otherwise, for a runner finding in a journey that has a recording, `observedAt` minus the journey's `startedAt` in seconds (the recording starts at about that moment, so this is approximate). No recording, no timestamp.

Nothing is invented: missing fields are left off, and `expected`/`actual` are only shortened (to 300/400 characters) so the card stays readable.

## Test

```sh
node --test canvas/test/*.test.mjs     # also picked up by the root `npm test`
```
