# X and Reddit GTM campaigns

A companion to ad creative generation: one product brief becomes detailed organic campaign drafts for X and Reddit. This is a library and CLI feature, following the existing image generator. It does not publish, schedule posts, research live communities, or add a canvas UI.

## Run

Requires Node.js 22.9+ and `GEMINI_API_KEY` in your local `.env` (the same key used for Gemini image generation). Text generation uses `GEMINI_TEXT_MODEL`, defaulting to `gemini-2.5-flash`; it is independent of the image model.

```sh
npm run campaigns -- --prompt-file brief.txt
npm run campaigns -- --prompt "Your product, audience, supported benefits and goal" --channel x
npm run campaigns -- --prompt-file brief.txt --channel reddit
npm run campaigns -- --prompt-file brief.txt --dry-run
```

Options: `--channel both|x|reddit` (default both), `--model`, `--out` (default artifacts). Supply exactly one of `--prompt` and `--prompt-file`. Maximum brief length: 24,000 characters.

A useful brief includes product facts, target customer, pain points, brand voice, campaign objective, landing page URL, supported proof, offer, constraints, and any observed product findings. Missing facts become assumptions or placeholders, not fabricated claims.

## Deliverables

Each channel receives an objective, audience, positioning, assumptions, detailed strategy, conversion and attribution plan, measurement guidance, three experiments with decision rules, and a launch checklist.

- X: seven standalone posts, one 5–8 part thread, and engagement guidance. Draft copy includes its CTA. Copy is conservatively limited to 280 UTF-8 bytes; this is intentionally stricter than X's weighted character counting.
- Reddit: three full post drafts with titles, five suggested replies, 3–5 candidate communities requiring verification, and guidance on affiliation disclosure and community participation.
- Both: a 14-day action calendar referencing generated content IDs, including listening, publishing, engagement and review.

Each run creates `artifacts/campaigns-.../` with `x-campaign.md`, `reddit-campaign.md`, corresponding structured JSON, and `manifest.json`. Selecting one channel produces only its files. Dry runs save the generation prompts in the manifest without API calls.

The provider receives a JSON schema; returned content is validated before publication to files. Structure, post IDs, calendar completeness, references and X copy lengths are checked. Factual accuracy, persuasive quality and compliance with current community rules still require editorial review.

## Integrate into the marketing feature

```js
import { generateCampaigns } from './lib/campaigns.mjs';

const { runDir, manifest } = await generateCampaigns({
  prompt: productBrief,
  channels: ['x', 'reddit'],
  onProgress: ({ channel, status }) => console.log(channel, status),
});
```

Call server-side; never expose the API key in browser code. Optional inputs include `apiKey`, `model`, `outputDir`, `dryRun`, and `fetchImpl`. `planCampaigns(brief, channels)` provides prompts and schemas without filesystem or network access. `campaignSchema(channel)` exposes the output contract.

Manifest statuses are `complete`, `partial`, `failed`, or `dry-run`. One request per channel, sequentially, with no automatic paid retries. Successful channel files survive another channel's failure. The CLI exits nonzero when any requested channel fails. Provider error bodies are not persisted. No live provider test has been performed without a configured key.

Provider contract: [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output).
