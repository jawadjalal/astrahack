# Lead generation

A companion to the ad, campaign and UGC outputs: the agent's understanding of a product becomes a kit for finding the people who have the problem it solves. It plans, searches and drafts. It never posts, messages, emails or scrapes a logged-in platform. A human reviews every lead and sends every message.

## Run

Node.js 22.9+. Text planning uses `GEMINI_API_KEY` (and `GEMINI_TEXT_MODEL`, default `gemini-3.5-flash`) from `.env`, the same as `npm run campaigns`.

```sh
# no key, no network, deterministic: same input gives the same kit
npm run leads -- --input ugc/fixtures/ignura/report.json --mock

# plan with Gemini
npm run leads -- --input ugc/fixtures/ignura/report.json

# plan with Gemini and look for real public threads (Google Search grounding)
npm run leads -- --input <run dir | report.json | ugc-plan.json | brief.md> --search --max-queries 6

# prompts only
npm run leads -- --input ugc/fixtures/ignura/report.json --dry-run

# from one paragraph
npm run leads -- --brief "Fernly is a plant-care app that reminds busy renters when to water each plant." --mock
```

Options: `--input` or `--brief` (exactly one), `--mock`, `--dry-run`, `--search`, `--max-queries N` (default 6, max 20), `--name`, `--url`, `--model`, `--out DIR` (default `artifacts/leads-<time>-<id>/`). Output: `leads.json` and `leads.md` (dry runs write `prompts.json`).

Exit codes: 0 ok, 1 error, 2 files written but live discovery had errors (for example quota).

Inputs: a run's `report.json` (or the run directory), a UGC plan (`ugc-plan.json`, kind `astrahack.ugc-plan`), or a brief (`--brief`, or a `.md`/`.txt` file). From a run, each journey becomes an observed feature (`F1`...) with the screenshots that prove it. A brief has no evidence, and the kit says so.

## What you get

1. **ICP**: segments (who, pain, trigger, disqualifiers) each tied to observed feature ids, plus buying triggers, objections, not-a-fit, and an explicit list of assumptions the product did not show.
2. **Sources with search recipes**: specific subreddits with subreddit-scoped, site-wide and Google search links; X queries with operators; Hacker News (Algolia), Product Hunt and Indie Hackers searches; Discord, Slack and forum candidates; newsletters with the route to reach them (sponsor, submit, pitch); creator archetypes with search terms and TikTok, YouTube, X, LinkedIn and Instagram tag links; "I wish there was an app for..." intent phrases; competitor-complaint queries. Every link opens a platform's own public search page and is built by code from the query, never written by a model. Google links use one `site:` filter at most.
3. **Scored shortlist**: field list, a 0-10 rubric (fit 3, intent 3, reachability 2, recency 2) with action thresholds, and `shortlist.leads`, which humans or tools fill. `--search` fills it with real results.
4. **Outreach drafts**: Reddit comment (helps first, no link, affiliation stated), X reply, DM (only after they engage), cold email (published business contact, opt-out line). Each draft contains `{{EVIDENCE}}` and an `evidenceSlot` naming the observed feature and screenshot (or exact flow) that replaces it. Platform norms are attached to each. A linter adds warnings for overclaims, invented personal experience, missing affiliation, a link in a first Reddit comment, and X replies over 280 bytes.
5. **Seven-day cadence**: verify sources, listen, help first, expand, creators, follow up, review.

## Honesty rules

- `status: recipe`, `verified: false` on every source. Subreddits, communities and newsletters named by the model are candidates; the kit tells a human to confirm each exists and read its rules. Competitor names come from the model unless the input named them.
- Only `shortlist.leads` entries with `backing: "search-result"` are leads. Their URLs come from Google Search grounding metadata; handles are parsed from those URLs. Prose from the model never supplies a URL or a handle, and a response with no grounding produces no leads.
- Recency is never scored automatically. A human checks the date.
- Product marketing copy is not treated as customer language. Pain statements are inference and are labelled as assumptions.

## Live discovery

`--search` sends up to `--max-queries` grounded requests (`tools: [{ "google_search": {} }]`), taking the first query from each platform in rotation so a small budget spans Reddit, X, intent phrases, Hacker News, Indie Hackers, competitors and Product Hunt. From each response it reads `groundingMetadata.groundingChunks` (the result URLs) and `groundingSupports` (which sentences each result supports). Google's `vertexaisearch` redirect URLs are resolved with one request to Google with redirects not followed; the destination site is never opened. URLs are cleaned of tracking parameters and de-duplicated. A final request scores the results against the ICP by index, so the model never touches a URL. Search quota errors (HTTP 429) stop discovery at once, are recorded in `discovery.errors`, and the plan and recipes are still written.

Limits: Search grounding has its own quota, separate from text generation. On the free tier it can be zero. The code path is tested against a faked grounded response; it has not returned live results with the team's key (see the run notes in the pull request or issue). Search results are candidates. Open the page, confirm the person and need, check the date.

## Model requests

Planning uses three structured-output requests, not one: the combined schema, and even the research half alone, is rejected with HTTP 400 (too complex). Each request gets one repair pass if its output breaks a rule the schema cannot express (unknown feature id, bare subreddit names, the `{{EVIDENCE}}` token, seven distinct days). HTTP 503 is retried twice with a pause; 429 is never retried. Schemas and validation: `leads/schema.js`.

## Canvas

```sh
node canvas/scripts/push-leads.mjs --leads artifacts/leads-.../leads.json [--canvas URL] [--live] [--replace] [--dry-run]
```

Adds a "Leads" lane below whatever is already on the board (it reads `GET /api/state` for the lowest edge and left margin): an ICP card with segment cards and arrows, source cards with their search URLs as text and a link badge on the card, outreach drafts, the shortlist (or an empty template), and the seven-day cadence. It uses existing ops only: `add_shape` rectangles, `add_text`, `add_arrow`, `update` (card link), `say`, `focus`. Shape ids start with `ld-`; re-running does nothing unless `--replace`, which deletes the old lane and redraws it. `--live` posts one card at a time. Layout lives in `canvas/src/lib/leadsToOps.ts` (pure, no I/O).

## Library

```js
import { generateLeads } from './leads/index.mjs';
const { doc, dir } = await generateLeads({ input: 'ugc/fixtures/ignura/report.json', search: true, maxQueries: 6 });
```

Options: `input` | `brief`, `mock`, `dryRun`, `search`, `maxQueries`, `outputDir`, `apiKey`, `model`, `fetchImpl`, `resolveImpl`, `now`, `onProgress`. Call server-side; never expose the key to a browser. Tests: `node --test test/leads.test.mjs canvas/test/leadsToOps.test.mjs`.
