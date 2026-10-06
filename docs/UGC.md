# UGC planner

Turns a computer-use run into a UGC campaign plan: creator angles, hooks, platform and format picks, three to five example scripts with beat-by-beat shots, a creator brief and a short campaign plan. Every product claim points at features the run actually observed. Anything else is labelled a proposal.

The contract is [`ugc/schema.js`](../ugc/schema.js) (`PLAN_SCHEMA`). Input is the `report.json` from `node bin/astrahack.js` (see the README). Output is `ugc-plan.json`, plus a readable `ugc-plan.md`.

## Run

```sh
# No key needed: deterministic plan straight from the report
npm run ugc -- ugc/fixtures/ignura --mock

# Real model (Gemini or OpenAI), with a brief
npm run ugc -- runs/demo --brief "Founders of consumer apps. TikTok and Reels. Goal: free-call bookings"
npm run ugc -- runs/demo --provider openai --out out/ugc

# See exactly what would be sent, without calling anything
npm run ugc -- runs/demo --dry-run
```

`node bin/ugc.js <runDir|report.json> [options]` works the same way without npm. Pass a run directory (it reads `report.json` inside) or the file itself.

| Option | Effect |
| --- | --- |
| `--brief TEXT` / `--brief-file PATH` | What the team wants: audience, goal, platforms, tone. Platforms named in it (TikTok, Reels, Shorts, LinkedIn, X) narrow the plan to those. |
| `--provider gemini\|openai` | Default: `UGC_PROVIDER`, else whichever API key is set (Gemini first). |
| `--model ID` | Override the text model. |
| `--out DIR` | Where to write the files. Default: the run directory, next to `report.json`. |
| `--mock` | Deterministic plan with no network and no key. Same input, same output. |
| `--dry-run` | Print the system prompt, user prompt and schema size. Writes nothing. |

After writing, the CLI re-reads `ugc-plan.json` and validates it. A plan that fails validation exits 1.

## Environment

Same variables as the rest of the repo, loaded from `.env` (`npm run ugc` uses `--env-file-if-exists`; the bare `node bin/ugc.js` also reads `.env` from the current directory).

| Variable | Use |
| --- | --- |
| `GEMINI_API_KEY` | Gemini text model. |
| `GEMINI_TEXT_MODEL` | Default `gemini-3.5-flash`, the same variable `npm run campaigns` uses. |
| `OPENAI_API_KEY` | OpenAI text model, through the shared helper in `src/openai.js`. |
| `OPENAI_TEXT_MODEL` | Default `gpt-6-astra`, the model `src/qa-analysis.js` uses. |
| `UGC_PROVIDER` | `gemini` or `openai`, to pin the provider. |

Keys are read from the environment only and never written to the output. Provider error bodies are not printed or saved.

## How it works

1. **Extract** (`ugc/extract.mjs`, no model). Each page or section the run visited becomes an observed feature `F1..Fn`: its name, what the run saw (asserted text with the page copy around it, headings, clicks and whether the page changed), and its evidence (screenshot paths, plus the journey video when there is one). A journey that crosses several pages is split per page. The extractor also collects the figures the site states about itself ("from £1,500", "50k views") as site claims, the journeys with per-step screenshots and video timestamps, and QA findings and run limitations as friction.
2. **Plan** (`ugc/prompt.mjs`, then the model, or `ugc/mock.mjs`). The model gets the features, an asset index (path, feature, what it shows), the site claims, the friction and the brief, and returns structured JSON for everything creative. `PLAN_SCHEMA` is sent as the response schema, minus `product.observedFeatures` and `product.frictionFromQa`, which the planner fills from step 1. The model never writes evidence paths, so it cannot invent them.
3. **Repair** (`ugc/repair.mjs`). Nothing the model cites is trusted:
   - Unknown feature ids on an angle or script are removed. An angle left with none is attached to the closest feature by text, or dropped. A script left with none inherits its angle's features.
   - Unknown audience, angle, hook or creator ids are reassigned to a valid one or the item is dropped. Calendar entries for unknown scripts are dropped. More than five scripts are trimmed.
   - A beat's `assetRef` must be a path from the run. `path@12s` and `path#t=12` are split into the path and a `(video at 0:12)` note in the shot. An unknown path is replaced with a screenshot from the script's own features, or cleared.
   - Every figure in script copy (money, percentages, "10k+", "50k views") is checked against the page text the run read, and flagged in `proposals`.
   Every change is listed in `grounding.repairs`.
4. **Validate** (`ugc/validate.mjs`). `PLAN_SCHEMA` shape, `checkGrounding` from `schema.js`, unique ids, 3 to 5 scripts, and every beat asset known. If the model's output still fails, it is re-asked once with the exact errors, then the command fails with the list.

## Output

`ugc-plan.json` is `wrapPlan(plan, meta)` from `schema.js`: `schemaVersion`, `kind: "astrahack.ugc-plan"`, `generatedAt`, `source` (`report`, `runDir`, `target`, `runName`), `model` (the model id, or `"mock"`), then the `PLAN_SCHEMA` fields: `product`, `audiences`, `angles`, `creators`, `hooks`, `scripts`, `creatorBrief`, `campaign`, `proposals`. It also carries one extra block that is not part of the contract:

```json
"grounding": { "provider": "mock", "observedFeatureCount": 11, "evidenceRoot": "ugc/fixtures/ignura",
               "repairs": ["..."], "flaggedFigures": 5, "note": "..." }
```

Evidence paths (`observedFeatures[].evidence`, `beats[].assetRef`) are relative to `source.runDir`, the same as in `report.json`. A beat with `assetRef: null` is the creator on camera. When the asset is a video, the timestamp is in the `shot` text.

`ugc-plan.md` renders the same content for people: features with evidence, angles and hooks, scripts as beat tables with the asset to show, the creator brief, the campaign calendar and KPIs, proposals and repairs.

A sample, generated with `--mock` from the committed Ignura run, is at [`ugc/fixtures/ignura/ugc-plan.json`](../ugc/fixtures/ignura/ugc-plan.json).

## Observed versus proposed

| Observed (from the run) | Proposed (creative or assumed) |
| --- | --- |
| `product.observedFeatures`: which pages and sections were visited, what text was confirmed, what was clicked, and the screenshots and video | `product.oneLiner`, `category`, `whoItsFor`: read from the site title and description, not from using the product |
| `product.frictionFromQa`: QA findings and run limitations. Never used as ad claims | `audiences`, `creators`: assumptions about who to reach and who to cast |
| Each angle's and script's `featureIds`: the observed features its claims rest on | Hooks, voiceover wording, shots, CTA phrasing, calendar, KPI targets, budget |
| `beats[].assetRef`: a screenshot or video the run captured | Anything listed in `proposals` |

`proposals` always states what the run did not do (for example, "the run did not sign up, pay or use any logged-in flow"). It also lists every figure that appears in script copy. A figure the pages showed is marked as the site's own claim, read but not verified. A figure no page showed is marked as unobserved and should be removed or confirmed before use. KPI targets are starting benchmarks, not forecasts.

## What needs a real key

`--mock` and `--dry-run` need nothing. A real run needs `GEMINI_API_KEY` or `OPENAI_API_KEY`.

- The mock is template-driven: it picks angles by matching feature text (pricing, proof, process, FAQ, free first step), quotes real page copy, and cites real screenshots. It is good for demos and schema tests, but its hooks and scripts are generic compared with a model's.
- The prompts, schema wiring and response handling for both providers are covered by tests with fake `fetch` and `request` functions. They have not been run against live APIs. If a provider rejects the schema (for example `type: ["string","null"]` on `assetRef`, or a model name your key cannot use), the command fails with a short message and nothing is written. Set `--model` or the `*_TEXT_MODEL` variable.
- The model sees page text and the asset index, not the screenshot pixels. Whether a screenshot really shows what a beat says is a human check.
- Page text is untrusted: the prompt tells the model to treat it as data. Review scripts before sending them to creators.

## Library

```js
import { planUgc, dryRunPrompts } from './ugc/plan.mjs';
import { renderPlan } from './ugc/render.mjs';

const plan = await planUgc({ report, brief, provider: 'gemini', runDir: 'runs/demo' });   // or { mock: true }
const markdown = renderPlan(plan);
```

`planUgc` options: `report`, `brief`, `provider`, `model`, `apiKey`, `mock`, `reportPath`, `runDir`, `maxAttempts` (default 2), and `fetchImpl` / `request` for tests. `validatePlan(plan, { assets })` returns a list of problems, empty when valid.

## Tests

```sh
node --test test/ugc.test.mjs
```

Runs against `ugc/fixtures/ignura` with the mock and with fake providers: schema validation, deterministic output, repair of unknown features, ids and assets, video timestamps, retry, provider requests, and the CLI.
