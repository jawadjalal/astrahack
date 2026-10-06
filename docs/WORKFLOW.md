# Workflow

1. Read a prompt from `--prompt` or `--prompt-file`.
2. Build five prompts using hero, editorial, benefit, context, and typography treatments.
3. Request one square PNG for each prompt from OpenAI, with two requests in flight at most.
4. Validate PNG signature and expected dimensions, then save each result.
5. Write prompts and per-image status to `manifest.json`.

A dry run performs steps 1–2 and saves the manifest without needing a key. Real runs use `OPENAI_API_KEY` from the environment or local `.env`; keys are never included in the manifest.

Each run has a unique directory, so previous images are not overwritten. A failed request is recorded; other successful files are retained. No retries are automatic. Each request has a five-minute timeout; the provider may still charge for a timed-out request. An incomplete set returns a nonzero CLI exit code.

No persistent service or frontend is needed. Syntax checks and six mocked-provider tests pass. Actual image generation awaits an API key.
