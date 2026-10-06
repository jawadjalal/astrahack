# Major-feature screenshot capture contract

`bin/feature-capture.js` is a post-run agent for the QA crawler. It reviews **observed** screens using `gpt-6-luna` by default through the OpenAI Responses API, then copies selected PNGs into a separate, reviewable asset set. It never claims coverage of a feature it did not observe.

```sh
OPENAI_API_KEY=... node bin/feature-capture.js runs/site-fleet/fleet.json
```

Set `OPENAI_SCREENSHOT_MODEL` or pass `--model MODEL` to override the screenshot selector's model. The CLI option takes precedence. This is separate from the QA fleet model.

The input is a finished JSON report in a run directory (`fleet.json` is preferred; `report.json`, `crawl.json`, and `qa-agent.json` also work). The capture module supports the journey runner shape: `product`, `assets[]` (initial screenshot), and `journeys[].steps[]` with `observation` and `screenshot`. It also accepts fleet and crawler `observations[]` entries with `{screenshot, observation, journey, step}` and QA agent top-level `steps[]` entries with `observation` and `screenshot`. When reading `fleet.json`, it also reads the sibling combined `qa-agent.json` if present, to reconcile agent-reported features. Screenshot paths are relative to the report directory and must point to PNGs inside it. An observation may include `url`, `title`, `headings`, `controls`, and `text`. The crawler should save a screenshot at each meaningful state after settling animations; the capture agent can only select from available evidence.

Output defaults to `feature-captures/` beside the report. `manifest.json` contains `features[]` with a name, evidence rationale, optional links to agent-reported feature names, and `screenshots[]` (`path`, `sourcePath`, `observationId`, journey, step, URL, title). `coverage` explicitly says the set covers observed screens only and counts available screenshots, unassigned pages, and incomplete workers. `gaps[]` records missing screenshots, unassigned routes, incomplete workers, unlinked agent-reported features, and model-identified evidence gaps. The asset set does not assert complete website coverage. All paths in the manifest are relative to the manifest directory. The QA report is read only; the two tasks can run independently. The feature asset set complements the QA report's `assets[]` and findings.

For long runs, the module reviews screenshot observations in groups of 60 and merges equal normalized feature names. The selection prompt sends short text descriptions of observed screens, not image pixels, to the API. It therefore cannot judge visual quality, discover hidden features, or prove that every major site feature was reached. Human review is still needed before promotional reuse, especially for sensitive page content. The API key is read from `OPENAI_API_KEY`; it is never saved in the manifest. If no screenshots are available, the module writes a manifest with an explicit gap without calling the API.
