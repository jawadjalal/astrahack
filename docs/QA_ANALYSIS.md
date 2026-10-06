# QA evidence analysis

Run the crawler and computer agent with the same output directory, then analyze their saved evidence:

```sh
node bin/qa.js crawl examples/qa.json --output runs/example
node bin/qa.js agent examples/qa.json --output runs/example
OPENAI_API_KEY=... node bin/analyze-qa.js runs/example
```

The analysis command writes `qa-analysis.json` and `qa-analysis.md` in the run directory. It uses GPT-6 Astra through the Responses API. `--no-images` sends the recorded observations and actions without screenshots; `--model MODEL` overrides the default model.

Evidence IDs are stable within one analysis: `C001` identifies the first crawled page, `CF001` the first crawler finding, and `Q001` the first computer action. The report's evidence index maps each ID to its source JSON file, URL, and screenshot path. Invalid model references are discarded. Up to eight screenshots are supplied to Astra when available.

`recorded` findings come directly from crawler checks. `agent_reported` findings come from the computer agent's assessment and link to its recorded action; review the screenshot before treating them as confirmed. `hypothesis` findings are Astra's additional interpretations and require human reproduction. Findings are ordered by severity, with exact expected and actual behavior, reproduction steps, and evidence references. The report also states crawl gaps and agent limits so unvisited journeys are not mistaken for passed tests.
