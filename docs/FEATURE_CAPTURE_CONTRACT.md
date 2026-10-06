# Major-feature screenshot capture contract

`bin/feature-capture.js` is a post-run agent for the QA crawler. It reviews **observed** screens using `gpt-6-astra` through the OpenAI Responses API, then copies selected PNGs into a separate, reviewable asset set. It never claims coverage of a feature it did not observe.

```sh
OPENAI_API_KEY=... node bin/feature-capture.js runs/example/report.json
```

The input is a finished `report.json` in a run directory. The capture module supports the existing runner shape: `product`, `assets[]` (initial screenshot), and `journeys[].steps[]` with `observation` and `screenshot`. A newer crawler may instead provide `observations[]` with `{screenshot, observation, journey, step}`. Screenshot paths are relative to the report directory and must point to PNGs inside it. An observation may include `url`, `title`, `headings`, `controls`, and `text`. The crawler should save a screenshot at each meaningful state after settling animations; the capture agent can only select from available evidence.

Output defaults to `feature-captures/` beside the report. `manifest.json` contains `features[]` with a name, evidence rationale, and `screenshots[]` (`path`, `sourcePath`, `observationId`, journey, step, URL, title). `gaps[]` names observed major features without suitable screenshot evidence. All paths in the manifest are relative to the manifest directory. The QA report is read only; the two tasks can run independently. The feature asset set complements, rather than replaces, the QA report's `assets[]` and findings.

For long runs, the module reviews screenshot observations in groups of 60 and merges equal normalized feature names. The selection prompt sends short text descriptions of observed screens, not the image pixels, to the API. Human review is still needed before promotional reuse, especially for sensitive page content. The API key is read from `OPENAI_API_KEY`; it is never saved in the manifest. The model ID is fixed to the requested `gpt-6-astra`.
