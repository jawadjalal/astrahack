# Demo and pitch (60 seconds)

What we show: a computer-use agent uses a client's product like a user, writes down what it saw, and the evidence lands on a shared canvas an agency can walk the client through. For Ignura (ignura.com, "We ignite your startup", the consumer-app launch studio).

What we claim, and nothing more:

- The agent drives a real browser (Chrome through CDP, or the Astra computer-use agent), records each step with screenshots and optional video, and reports findings with expected vs actual and reproduction steps. Findings are functional only: observable broken behavior (a button that does nothing, a counter that does not update, an error), never colors, spacing or copy opinions. See [QA_ANALYSIS.md](QA_ANALYSIS.md).
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

The seeded board has 6 mock screens (onboarding, sign up, paywall, home, settings, empty garden), 6 highlight boxes, 6 ranked findings (4 verified, 2 unverified), all functional: the paywall close button is unresponsive, the first tap on Create account is ignored, the reminder count does not update after watering, the reminder time reverts to 8:00 AM, the Home badge disagrees with the list, and Add (+) on an empty garden does nothing. The content lives in `canvas/scripts/demo-findings.mjs` and the seed refuses to post a finding the filter would drop (`--dry-run` prints the ops without posting). The board also has a run-recording slot, a legend and a fix-first list. It is fictional data. The video is a 5-second stand-in clip, so the finding timestamps run 0:01 to 0:05. Say so if asked.

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

## The 60-second script

Layout: canvas full screen on the projector, Follow on, board empty, one hidden terminal. A real agent run takes minutes, so a one-minute slot never shows one end to end. Use a replay: `node canvas/scripts/seed-demo.mjs --live` (about 15 s, sample app) or `node canvas/scripts/push-run.mjs runs/demo --live --delay 250 --clear` (a real recorded run). Say "recorded run" out loud either way. Never call a replay live.

| Time | Beat | Say | Do |
| --- | --- | --- | --- |
| 0:00 | Hook | "Every launch agency has this meeting. You say the onboarding leaks. The client says: show me." | Empty board. Press Enter in the hidden terminal to start the replay as you finish the sentence. |
| 0:08 | Observe | "So an agent uses the app like a customer. Every box is a real screenshot, in order." | Camera follows. Point at the arrows and step badges as they draw in. |
| 0:25 | Reproduce | "When something breaks it tries again. Verified means it happened twice. Unverified means it only saw it once, and says so." | Point at a Verified card, then an Unverified one. |
| 0:40 | Explain | "Each finding sits on a box over the exact spot, and every one is something that is broken, not a matter of taste." | Click the red box on the paywall close button. |
| 0:47 | Human in the loop | "And I can add my own evidence." | Drag a screenshot from the desktop onto the board. It uploads and appears. |
| 0:53 | Present | "That's the client view." | Click Present. |
| 0:57 | Close | "Ignura: a teardown first, then we fix the top of the list and launch it. Find us after." | Hold on the board. |
| 1:00 | End | | |

Cut for time, mention only in Q&A: the run recording playback, the ranking walkthrough, mid-run steering by an MCP agent, UGC and ads.

Rehearse with a timer. If you run long, drop the Reproduce beat to one sentence; do not drop Present.

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

Backup plan (decide by 0:08, not later):

1. Live run fails to start, hangs, or the network is bad: stop it, say nothing, run `node canvas/scripts/seed-demo.mjs --live` and continue the same script. The script works the same.
2. Canvas is down: restart `PORT=3000 npm run dev`, reseed. About 10 seconds.
3. Projector fails: the whole story fits in 2 slides (below) and in the seeded board on a laptop screen.

## Two-slide outline

Slide 1, only if the canvas is not ready (otherwise skip):

- Title: "Show me." The meeting every launch agency has.
- Left: today. A Loom, screenshots in Figma, a Notion page. Stale, unverifiable.
- Right: with us. A computer-use agent uses the product, records the run, and builds the evidence on a shared canvas. Observe, reproduce, explain, rank.
- Footer line: verified vs unverified is stated on every finding.

Slide 2, the offer (shown during questions):

- Title: "Ignite your launch, starting with a teardown."
- Three steps: 1. We run the agent on your app with a test account. 2. You get the board: screens, evidence, ranked fixes, read-only client view. 3. We fix the top of the list, then launch it: design, launch film, UGC, launch day.
- Contact: ignura.com. A screenshot of the finished board behind the text.

## Questions to expect

- "Is this live?" Say which one it was. Live run: yes. Seeded board: "a prepared sample run of a fictional app".
- "What if the agent is wrong?" Findings it saw once are marked Unverified, and observed facts are kept separate from its guesses.
- "Does it work on a native app?" Not yet. It runs on websites and Electron renderers.
- "Can it fix things?" No. It finds and ranks. Ignura does the fixing and the launch.
