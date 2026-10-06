# Launch kit on the canvas

The teardown puts the evidence on the canvas. The launch kit puts what we make from that evidence next to it: the five ad creatives, the X and Reddit GTM drafts, and the UGC video concepts, in three labelled lanes below the teardown flow.

```
 teardown flow (push-run)       step-1 -> step-2 -> step-3 ...
        ^  ^  ^   arrows from UGC cards to the screenshots that back them
 LAUNCH KIT  ·  <product>
 +- UGC CONCEPTS ------------------------------------------------+
 +- AD CONCEPTS --------------------------------------------------+
 +- GTM POSTS ----------------------------------------------------+
```

Everything here is a draft. Nothing is published, scheduled or posted anywhere.

## The chain, end to end

```sh
# 0. the teardown, already on the canvas (existing)
node bin/astrahack.js <journey.json> --output runs/example  # or any other run that leaves a report.json (see docs/CANVAS_INTEGRATION.md)
node canvas/scripts/push-run.mjs runs/example --canvas http://localhost:3000

# 1. five ad creatives (GEMINI_API_KEY; --dry-run writes only the prompts)
npm run generate -- --prompt-file brief.txt                 # -> artifacts/ads-<run>/ (01-hero.png ... + manifest.json)

# 2. X + Reddit campaigns (GEMINI_API_KEY)
npm run campaigns -- --prompt-file brief.txt                # -> artifacts/campaigns-<run>/ (x-campaign.json, reddit-campaign.json)

# 3. UGC plan from the same run (--mock needs no key)
npm run ugc -- runs/example                                 # -> runs/example/ugc-plan.json

# 4. the kit onto the canvas
node canvas/scripts/push-kit.mjs \
  --ads artifacts/ads-<run> --campaigns artifacts/campaigns-<run> --ugc runs/example/ugc-plan.json \
  --run runs/example --canvas http://localhost:3000 --live
```

On the deployed canvas, replace the canvas URL with `https://ignura.com/astrahack` (the base path is handled).

Any subset works. Pass only `--ads` and you get the ads lane; the banner and the other lanes are left out.

## push-kit flags

| Flag | Effect |
| --- | --- |
| `--ads <dir>` | The ads run folder (or its `manifest.json`). The PNGs are uploaded through `POST /api/upload`; each `src` is the url the server returns, unchanged. |
| `--campaigns <dir\|file>` | A campaigns run folder (reads `x-campaign.json` and `reddit-campaign.json`) or one of those files. Repeatable. |
| `--ugc <file>` | `ugc-plan.json` (contract in `ugc/schema.js`). |
| `--run <dir\|report.json>` | The teardown on the canvas. Gives exact screenshot-to-step mapping and lets a `--dry-run` draw the evidence arrows offline. |
| `--run-prefix run-<12 hex>` | Which teardown the evidence arrows point at when several runs share the board. Default: the one `--run` produced, else the latest on the board. |
| `--canvas URL` | Default `$CANVAS_URL`, else `http://localhost:3000`. Base paths work. |
| `--origin x,y` | Top-left of the kit in canvas px. Default: the left edge of the existing content, 240 px below its lowest element (read from `GET /api/state`). |
| `--live` | One lane per batch with a pause between, so a watcher sees it build. `--delay ms` overrides. |
| `--replace` | Delete the kit already on the board (ids `kit-*`, `ad-*`, `gtm-*`, `ugc-*`) and place it again in the same spot. Without it a second push is refused. |
| `--dry-run` | Print the ops as JSON on stdout. Nothing is uploaded or posted. Reads the board when it is reachable, else assumes an empty one. |

## What lands where

| Lane | Contents | Ids |
| --- | --- | --- |
| Ad concepts | The five PNGs as `add_image` (400 px), captioned `Ad 1 · hero` plus the art direction text parsed from the manifest prompt. An ad with no image (dry run, failed) keeps its id as a grey card that says why. | `ad-1` .. `ad-5`, `ad-N-direction` |
| GTM posts | X: seven post cards, then the thread as a chain of cards joined by arrows. Reddit: three draft cards (body clipped to 700 characters on the card; the full text is in `reddit-campaign.md`). Each card opens with a platform chip line (`X · POST 3 of 7 · x-3`, `REDDIT · POST 1 of 3 · reddit-1`) and the copy is verbatim. Each set is also grouped, so it moves as one. | `gtm-x-x-1`, `gtm-x-thread-1`, `gtm-reddit-reddit-1` |
| UGC concepts | One card per script: platform, format, duration, the hook, what it opens on, the creator, every beat (voiceover, on-screen text, shot), CTA. A hook no script uses gets its own card. Up to two arrows per card run to the teardown screenshots its beats show (the `assetRef` paths). | `ugc-S1`, `ugc-H5`, `kit-arrow-ugc-S1-1` |

When the UGC cards have arrows to the teardown, that lane goes first so the arrows are short and do not cross the other lanes; otherwise the order is ads, GTM posts, UGC. A path like `screenshots/005-Browse-...png` maps to the canvas id `step-5`, or `run-<hash>-step-5` for a push-run board. The initial view (`000-initial.png`) is not a step and gets no arrow. An arrow is only drawn when that id exists on the board.

A `say` speech bubble ("Launch kit is on the board: 5 ad concepts, ...") hangs beside the banner when `ops.ts` has the `say` op. `say` and `group` are feature-detected from the local `ops.ts` and posted last, one request each, so a deployed canvas that does not know them skips them without losing the cards.

## From code

```js
import { kitToOps, kitToOpsDetailed, stateBounds, originBelow, detectSayOp } from './canvas/src/lib/kitToOps.ts'; // Node >= 22.18

const ops = kitToOps({ ads: manifest, campaigns: { x, reddit }, ugcPlan }, {
  origin: { x: 0, y: 4000 },
  srcMap: { '01-hero.png': '/uploads/abc.png' },   // manifest filename -> hosted url
  stepIds: boardIds,                                 // UGC cards arrow only to ids in here
  say: detectSayOp(OpSchema),
});
```

`kitToOps` is pure: no I/O, returns `Op[]` in the `ops.ts` contract. `kitToOpsDetailed` also returns `ids`, `bounds`, per-lane boxes and counts. Options: `origin`, `srcMap` / `srcFor`, `sizes`, `stepIds`, `stepPrefix`, `stepIdFor`, `say`, `group`, `banner`, `focus`, `redditBodyChars`, `maxEvidenceArrows`.

## MCP tools

Added to `canvas/mcp/server.ts`, same layout rules, default placement below the lowest existing element:

| Tool | Does |
| --- | --- |
| `canvas_push_ad_creatives` | `run_dir` (an ads folder) or `images[]`: uploads the PNGs and places the ads lane, ids `ad-1`..`ad-5`. Refuses if `ad-1` already exists. |
| `canvas_add_campaign_post` | One X post, thread part (`thread_part`) or Reddit draft as a card. Later cards of the same kind go to the right of the previous one; thread parts chain with an arrow. |
| `canvas_add_ugc_concept` | One UGC card (hook, beats, CTA). `evidence_ids` and beat `asset_ref` draw arrows to screenshots on the board; an unknown id is an error. |

## Without API keys

- Ads: `npm run generate -- --prompt "..." --dry-run` writes the five prompts and no images; push-kit shows five grey "not generated yet" cards with their art direction.
- UGC: `npm run ugc -- ugc/fixtures/ignura --mock`.
- Demo fixtures: `KIT_FIXTURES_DIR=/tmp/kit node canvas/test/kit.test.mjs` writes real PNG placeholders (through the repo's own generator with a mocked Gemini response), a mocked campaigns run for Ignura and a UGC plan, then prints the `push-run` and `push-kit` commands to put them on a local canvas.

## Test

```sh
node --test canvas/test/*.test.mjs     # also picked up by the root `npm test`
```

`kit.test.mjs` generates its fixtures, checks every op against the `ops.ts` schema, layout (no overlaps, inside lane backdrops, below an existing teardown), evidence arrows, `say` / `group` detection, push-kit against a mock canvas with a base path (upload, placement, `--replace`), and the three MCP tools over stdio. Without `canvas/node_modules` the contract and MCP parts skip.
