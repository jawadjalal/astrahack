<p align="center">
  <img src="docs/img/astra-hero.png" width="420" alt="Astra, a hand-drawn star, lighting a rocket">
</p>

<h1 align="center">AstraHack</h1>
<p align="center"><b>Paste your website. Astra uses it like a customer, and shows you what's broken.</b></p>
<p align="center"><a href="https://ignura.com/astrahack">ignura.com/astrahack</a> · built for the GPT-6 Astra Hackathon · for <a href="https://ignura.com">Ignura</a></p>

---

## The problem

Every launch agency has the same meeting. You tell the founder their signup leaks. They say: *show me.*
Today "show me" is a Loom, a folder of screenshots and a Notion page nobody trusts, stale by Friday.

## What Astra does

1. **Uses your product.** An agent drives a real browser with GPT-6 Astra: it signs up, clicks, types, goes back, refreshes, and tries to break things.
2. **Reproduces before it accuses.** A finding is only marked *Verified* if Astra replays the steps and sees it happen again. Anything it saw once is marked *Unverified*. Only functional bugs count: broken flows, wrong results, dead ends. Not "I'd prefer another colour."
3. **Draws the evidence on a whiteboard.** Real screenshots in order, arrows between steps, a box on the exact spot, a card per bug with expected vs actual. You watch Astra's cursor move as it works.
4. **Hands the agency a launch kit.** From what it actually saw: ad images, X and Reddit posts, UGC hooks and scripts, and where to find leads.

The whiteboard is built for agents. Any MCP-capable agent can draw on it, and people can drag in screenshots and MP4s, move things, delete things, and switch to a read-only client view.

## Try it

Live: **[ignura.com/astrahack](https://ignura.com/astrahack)**. Enter a public website URL.

Or run it yourself (Node 22.18+, no keys needed for the first run):

```sh
git clone https://github.com/jawadjalal/astrahack.git && cd astrahack
npm run setup
npm run teardown -- --mock --open     # a full sample board, canvas started for you
```

Add `OPENAI_API_KEY` (and optionally `GEMINI_API_KEY`) to `.env` for real runs: `npm run teardown -- https://your-site.com --kit --live`.

## How it fits together

```
 URL ─▶ Astra agent (real Chrome, GPT-6 Astra) ─▶ verified findings + screenshots + recording
                                                        │
                       whiteboard (Next.js + tldraw, MCP + HTTP ops) ◀─┘
                                                        │
                    launch kit: ads · X/Reddit · UGC plan · leads ◀────┘
```

## Honest status

- Working and checked: the whiteboard on production, live streaming of ops, uploads and video, the markup tools agents use, the functional-only finding filter, the UGC planner, lead generation, and real ad images.
- Still being proven: the always-on cloud worker that runs submitted sites for everyone, and the macOS desktop-app backend. See [docs/TODO.md](docs/TODO.md) for the current list.

## Team

[@jawadjalal](https://github.com/jawadjalal) · [@niketh-putta](https://github.com/niketh-putta) · [@avi-aggarwal14](https://github.com/avi-aggarwal14) · [@Welddevelopment](https://github.com/Welddevelopment)

## Go deeper

[Demo script (60s)](docs/DEMO.md) · [Runbook](docs/RUNBOOK.md) · [Agent](docs/AGENT.md) · [Canvas MCP tools](docs/MCP.md) · [Launch kit](docs/LAUNCH_KIT.md) · [UGC](docs/UGC.md) · [Leads](docs/LEADS.md) · [Everything else](docs/REFERENCE.md)
