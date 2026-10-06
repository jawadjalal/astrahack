# Ship list: make it work for everyone

Status key: [x] done and checked, [~] in progress, [ ] not started, [!] blocked on a person.

## P0: a visitor pastes a URL and gets a real board
- [x] Board renders on ignura.com/astrahack (tldraw trial license set, expires 2027-01-14).
- [x] Blob-backed ops, uploads and live stream on production.
- [x] OpenAI key valid (gpt-6-astra, luna, sol available); stored server-side only.
- [x] Chrome launches reliably (mock keychain flags, commit ee735fd).
- [x] Fake demo board (plant-care "Fernly") removed from the live board.
- [~] Always-on worker: runs wait forever when no laptop worker is up. Building a Vercel Sandbox worker triggered on run creation, plus a cron safety net.
- [~] Per-run boards so visitors don't collide, and nothing stale ever shows.
- [~] Human delete / move / reset shared on the board (today edits are local to a tab).
- [ ] One real production run proven end to end: screenshots, findings, feature captures on that run's board.
- [ ] Failed or stuck runs show a clear message instead of "Waiting for an exploration worker".

## P1: product quality
- [~] Intake screen restyled in the Ignura hand-drawn style.
- [x] Findings are functional only (design opinions filtered).
- [ ] Annotation boxes on real runs (the runner emits no regions; the Astra agent should).
- [ ] Real Astra agent run with the OpenAI key (only mock-tested so far).
- [ ] Add menu and toolbar polish pass on a phone-width screen.

## P2: GTM outputs (UGC, campaigns, leads, ads)
- [x] UGC planner (real Gemini run on the Ignura fixture works with gemini-3.1-flash-lite).
- [x] X and Reddit campaigns, lead generation, launch kit lane on the board.
- [!] Ad images: Google free tier has no image quota. Needs billing on the Gemini key or `--provider openai`.
- [!] Live lead search (`--search`) returns 429 on the shared Gemini key.
- [ ] Wire UGC, campaigns, leads and ads into the worker so a run produces them automatically.
- [ ] UGC creator discovery: search recipes exist; real creator shortlists need a live search source.

## P3: before the demo
- [ ] Rehearse the 60-second script on the production URL.
- [ ] Backup: `npm run teardown -- --mock` on a local canvas.
- [ ] Decide what happens to the shared board between demos (per-run boards make this moot).
