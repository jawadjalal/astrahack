# OpenAI generators

Set `OPENAI_API_KEY` in `.env`. The generators make real provider requests and save local artifacts. They do not publish campaigns. Errors remain failures; no mock output or alternate paid endpoint is substituted.

```sh
npm run generate -- --provider openai --prompt-file brief.txt --out artifacts
npm run campaigns -- --provider openai --prompt-file brief.txt --out artifacts
npm run ugc -- runs/example/report.json --provider openai --out artifacts/ugc
```

Image generation defaults to the Responses API, using `gpt-6-luna` to call the `gpt-image-2` tool at low quality. It creates five 1024×1024 PNGs, two requests at a time. Override with `--model` for the image model, `--response-model` for the text model, and `--quality low|medium|high|auto`. `--openai-api images` explicitly selects the legacy direct Images endpoint. Environment equivalents are `OPENAI_IMAGE_MODEL`, `OPENAI_TEXT_MODEL`, `OPENAI_IMAGE_QUALITY`, and `OPENAI_IMAGE_API`.

X and Reddit campaigns use `gpt-6-luna` and produce separate validated JSON and Markdown documents. UGC also defaults to Luna and produces scripts, hooks, a shot plan, and a campaign calendar grounded in the report's observed features and assets. UGC currently consumes the runner `report.json` format with `journeys[]`; a fleet integration must convert its observations into that shape.

`--dry-run` avoids provider calls. Paid image and campaign requests are not automatically retried. The UGC planner may retry once when its generated structure fails validation. Each artifact records its model; image and campaign manifests also record returned API usage where available.

OpenAI documents [Luna's image-tool and structured-output support](https://developers.openai.com/api/docs/models/gpt-6-luna) and the [Responses image-generation tool](https://developers.openai.com/api/docs/guides/tools-image-generation). Access to the Responses endpoint alone does not prove that a particular project can use every image model; a denied request is reported as failed.
