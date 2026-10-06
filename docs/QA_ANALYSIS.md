# QA evidence analysis

Run the QA fleet, then analyze its saved crawl and computer-use evidence:

```sh
node bin/qa.js fleet examples/qa.json --output runs/example
OPENAI_API_KEY=... node bin/analyze-qa.js runs/example
```

The analysis command writes `qa-analysis.json` and `qa-analysis.md` in the run directory. It uses `gpt-6-luna` through the Responses API by default. Set `OPENAI_QA_ANALYSIS_MODEL` or pass `--model MODEL` to choose another model. `--no-images` sends the recorded observations and actions without screenshots.

Evidence IDs are stable within one analysis: `C001` identifies the first crawled page, `CF001` the first crawler finding, `W001` worker A001, and `Q001` the first global computer action. The report's evidence index maps each ID to its source JSON file, worker mission, URL, and screenshot path. Worker issue references are checked against both the global step index and worker ID. Missing screenshot files and mismatched screenshot references are called out. Invalid model references are discarded. Up to four screenshots are supplied to the model when available.

`recorded` findings come directly from crawler checks. `agent_reported` findings come from the computer agent's assessment and link to its recorded action; their reproduction steps are agent proposed and need review. `unverified` flags a missing or mismatched action, worker, or screenshot reference. `hypothesis` findings are the analysis model's additional interpretations and require human reproduction. Findings are ordered by severity, with expected and actual behavior, reproduction steps, and evidence references. The report states crawl gaps, incomplete workers, and the portion of the evidence index sampled for model analysis. Every recorded finding remains in the report even when a large fleet run exceeds the model sample limit.
