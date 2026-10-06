# Demo and pitch (3 minutes)

What we show: a computer-use agent uses a client's product like a user, writes down what it saw, and the evidence lands on a shared canvas an agency can walk the client through. For Ignura (ignura.com, "We ignite your startup", the consumer-app launch studio).

What we claim, and nothing more:

- The agent drives a real browser (Chrome through CDP, or the Astra computer-use agent), records each step with screenshots and optional video, and reports findings with expected vs actual and reproduction steps.
- Findings are marked verified or unverified. Observed facts stay separate from the agent's guesses.
- The canvas shows the run live (screens left to right, arrows, highlight boxes, finding cards, the recording). Any MCP-capable agent can draw on it. Humans can drag in files, move things and switch to Present mode for a read-only client view.
- We do not claim: it fixes the bugs, it covers native iOS or Android apps (web and Electron renderers only today), or that it finds everything. Coverage gaps are reported, not hidden.

## Two ways to run the demo

| | Live | Backup (seeded) |
| --- | --- | --- |
| What | Real run on a real target, pushed to the canvas | A finished teardown of a fictional plant-care app, "Fernly" |
| Command | see "Live run" below | `node canvas/scripts/seed-demo.mjs --canvas URL --live` |
| Needs | Chrome, API key, permissions, a test account | Only the canvas |
| Say out loud | nothing special | "This board is a prepared sample run." Do not call it live. |

The seeded board has 6 mock screens (onboarding, sign up, paywall, home, settings, empty garden), 5 highlight boxes, 6 ranked findings (4 verified, 2 unverified), a run-recording slot, a legend and a fix-first list. It is fictional data. The video is a 5-second stand-in clip, so the finding timestamps run 0:01 to 0:05. Say so if asked.

### Seed commands

```sh
cd canvas && npm install && PORT=3000 npm run dev          # local canvas, in its own terminal

node canvas/scripts/seed-demo.mjs                           # instant, to http://localhost:3000
node canvas/scripts/seed-demo.mjs --live                    # builds on screen, about 15 seconds
node canvas/scripts/seed-demo.mjs --canvas https://ignura.com/astrahack --live
CANVAS_URL=https://ignura.com/astrahack node canvas/scripts/seed-demo.mjs
```

The script clears the board first (`--no-clear` skips that). It is safe to rerun. Base paths work: the API is `CANVAS_URL + /api/ops`.

### Live run

```sh
# 1. run the agent or the scripted journeys against the target (test account only)
ASTRAHACK_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  node bin/astrahack.js examples/ignura.json --output runs/demo --headed --ffmpeg "$(which ffmpeg)"
# 2. draw the run on the canvas, one step at a time
node canvas/scripts/push-run.mjs runs/demo --canvas http://localhost:3000 --live --clear
```

For the model-driven agent see the README (`npm run qa -- agent ...`, needs `OPENAI_API_KEY`). Details of the push script are in [CANVAS_INTEGRATION.md](CANVAS_INTEGRATION.md). Agents that run inside Claude Code or Codex draw through the MCP server instead ([MCP.md](MCP.md)).

## The 3-minute script

Layout of the room: canvas full screen on the projector, one second terminal hidden behind it. Follow is on in the canvas toolbar so the camera tracks new items.

| Time | Beat | Say | Do |
| --- | --- | --- | --- |
| 0:00 | Hook | "Every launch agency has the same meeting. You tell the client their onboarding leaks. They say, show me." | Canvas is empty. Do not touch anything. |
| 0:20 | Problem | "Today that is a Loom, a Figma file full of screenshots and a Notion page. Nobody trusts it, and it is stale by Friday. We wanted the evidence to build itself." | Still empty. |
| 0:40 | Start | "This is an agent using the client's product the way a customer would. We give it a test account and a goal: get from install to first plant." | Start the run (or `seed-demo.mjs --live` for the backup). Screens begin to appear. |
| 0:55 | Observe | "It is not reading code. It sees the screen, taps, and records every step. Each box is a real screenshot in order." | Let the camera follow. Point at the Step badges and arrows. |
| 1:15 | Reproduce | "When something breaks it does not just say so. It tries again. This one is marked Verified because it happened twice. This one says Unverified because it only saw it once, and it tells us that." | When the paywall finding lands, point at the card: severity chip, expected, actual, the Verified chip. Then point at an Unverified card. |
| 1:35 | Steer | "And I am not locked out of the run." | See "The steering moment" below. About 20 seconds. |
| 1:55 | Explain | "Each finding says what it expected, what happened, and sits on a box over the exact spot." | Click a red box on the paywall close button. Press play on the run recording for 3 seconds. |
| 2:10 | Rank | "Then it ranks them. Paywall with no way out is number one. That is the order we would fix them in." | Click Fit all. Read finding #1 aloud. |
| 2:25 | Present | "Now the client view." | Click Present (bottom left). Toolbars vanish, board is read-only. Pan to the paywall, then back out. |
| 2:40 | Close | "Ignura launches consumer apps: design, launch film, UGC, launch day. Before we launch yours we run this teardown, hand you this board, and fix the top of the list first. If you want one on your app, find us after this." | Leave Present mode on the full board. |
| 3:00 | End | | |

### The steering moment

Goal: show the human can redirect the agent mid-run and new evidence appears on the same board.

- Option A (needs the agent to be an MCP agent in Claude Code or Codex with `astrahack-canvas` registered): type into the agent session, "Go back to the paywall and try to close it twice, then add the result." New items appear on the canvas. Rehearse this at least three times before using it on stage.
- Option B (always works): drag a screenshot from the desktop onto the canvas. It uploads and appears as a new image where you drop it. Say, "I can add my own evidence next to the agent's." Then drag a finding card or box next to it to show the board is editable.
- Backup mode: only Option B. Do not pretend the seeded board is responding.

If you are unsure which to use, use B. It cannot fail in front of the room.

## Stage checklist

Day before:

- [ ] Pick two targets. Target 1: the client app, with a throwaway test account (never a real person's account; screenshots and video show what is typed). Target 2: `examples/ignura.json` (ignura.com, needs no login) as a second live run.
- [ ] Record one clean backup run on each target. Keep `runs/` on the laptop. Push each with `push-run.mjs` once to check it draws.
- [ ] Run `seed-demo.mjs --live` end to end on the exact projector resolution. Check nothing overlaps.

Machine permissions (macOS, System Settings > Privacy and Security):

- [ ] Screen Recording enabled for the terminal app (or the agent app) that starts the run.
- [ ] Accessibility enabled for the same app. Quit and reopen it after toggling.
- [ ] Chrome path set: `ASTRAHACK_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`. `ffmpeg` on the PATH if you want video.
- [ ] `OPENAI_API_KEY` in the environment for the model-driven agent (never on screen; keep `.env` closed).
- [ ] Notifications off, Do Not Disturb on, laptop on power, sleep disabled, one display, screen mirror tested.

Safety:

- [ ] Stop key: Ctrl+C in the terminal that launched the run. Know which terminal that is. If it hangs, `kill <pid>` of that one process (do not pkill by name; other sessions may share the machine).
- [ ] The agent blocks external links and consequential button labels, but treat the target as live. Test account, no payment methods, nothing you would mind it clicking.

Canvas:

- [ ] Local: `cd canvas && PORT=3000 npm run dev`. Fastest, no network, safest. Only the sample video needs internet.
- [ ] Deployed: `https://ignura.com/astrahack`. Use it only if the client needs the link. Before going on, run the seed with `--canvas https://ignura.com/astrahack`, reload the page, and confirm the board is still there (`curl -s https://ignura.com/astrahack/api/state | head -c 200`). Uploads on the deployed canvas are limited to about 4.5 MB per request; the seed uses small inline images so it is fine.
- [ ] Clear before you start: toolbar Clear, or `curl -X DELETE <CANVAS_URL>/api/state`. Never clear in front of the room.
- [ ] Browser zoom 100%, full screen, one tab. Canvas toolbar shows "connected".
- [ ] Try Present mode and Exit present once so you know where the button is.

Backup plan (decide by 0:40, not later):

1. Live run fails to start, hangs, or the network is bad: stop it, say nothing, run `node canvas/scripts/seed-demo.mjs --live` and continue the same script. The script works the same.
2. Canvas is down: restart `PORT=3000 npm run dev`, reseed. About 10 seconds.
3. Projector fails: the whole story fits in 2 slides (below) and in the seeded board on a laptop screen.

## Two-slide outline

Slide 1, the problem and the product (shown 0:00 to 0:40 if the canvas is not ready, otherwise skip):

- Title: "Show me." The meeting every launch agency has.
- Left: today. A Loom, screenshots in Figma, a Notion page. Stale, unverifiable.
- Right: with us. A computer-use agent uses the product, records the run, and builds the evidence on a shared canvas. Observe, reproduce, explain, rank.
- Footer line: verified vs unverified is stated on every finding.

Slide 2, the offer (shown at 2:40 while taking questions):

- Title: "Ignite your launch, starting with a teardown."
- Three steps: 1. We run the agent on your app with a test account. 2. You get the board: screens, evidence, ranked fixes, read-only client view. 3. We fix the top of the list, then launch it: design, launch film, UGC, launch day.
- Contact: ignura.com. A screenshot of the finished board behind the text.

## Questions to expect

- "Is this live?" Say which one it was. Live run: yes. Seeded board: "a prepared sample run of a fictional app".
- "What if the agent is wrong?" Findings it saw once are marked Unverified, and observed facts are kept separate from its guesses.
- "Does it work on a native app?" Not yet. It runs on websites and Electron renderers.
- "Can it fix things?" No. It finds and ranks. Ignura does the fixing and the launch.
