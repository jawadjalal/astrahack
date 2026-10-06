# Canvas MCP server

`canvas/mcp/server.ts` is a stdio MCP server (`astrahack-canvas`) that lets any MCP-capable agent draw on the live canvas: screenshots, videos, arrows, annotation boxes and finding cards. It is a thin client of the canvas HTTP API (`canvas/src/lib/ops.ts`): `POST /api/ops`, `GET /api/state`, `POST /api/upload`, `DELETE /api/state`.

## Run prerequisites

```bash
cd canvas && npm install && npm run dev      # canvas at http://localhost:3000
```

The server reads `CANVAS_URL` (default `http://localhost:3000`). If the canvas is down, every tool returns an error telling the agent to run `cd canvas && npm run dev`.

Smoke test (starts its own mock canvas, no app needed): `cd canvas && npm run mcp:test`. Set `CANVAS_URL` to run it against a real canvas (it clears the board first).

## Register with Claude Code

`tsx` is a devDependency of `canvas/`, so run `npm install` in `canvas/` first. Use the absolute path to the local `tsx` binary so the working directory does not matter:

```bash
# from the repo root:
claude mcp add astrahack-canvas -e CANVAS_URL=http://localhost:3000 -- \
  "$PWD/canvas/node_modules/.bin/tsx" "$PWD/canvas/mcp/server.ts"

# or, from inside canvas/ (cwd matters for npx here):
cd canvas && claude mcp add astrahack-canvas -- npx tsx mcp/server.ts
```

Project-scoped alternative: a `.mcp.json` in the repo root (command runs from the repo root):

```json
{ "mcpServers": { "astrahack-canvas": { "command": "sh", "args": ["-c", "cd canvas && exec npx tsx mcp/server.ts"] } } }
```

## Register with Codex / OpenAI-style `mcp.json`

```json
{
  "mcpServers": {
    "astrahack-canvas": {
      "command": "npx",
      "args": ["tsx", "mcp/server.ts"],
      "cwd": "/ABSOLUTE/PATH/TO/astrahack/canvas",
      "env": { "CANVAS_URL": "http://localhost:3000" }
    }
  }
}
```

Codex `config.toml` equivalent:

```toml
[mcp_servers.astrahack-canvas]
command = "npx"
args = ["tsx", "/ABSOLUTE/PATH/TO/astrahack/canvas/mcp/server.ts"]
env = { CANVAS_URL = "http://localhost:3000" }
```

The OpenAI Responses API only accepts remote MCP servers over HTTP (`{"type":"mcp","server_label":"astrahack-canvas","server_url":"https://.../mcp"}`), so this stdio server needs an stdio-to-HTTP bridge in front of it, plus a public tunnel to reach it. Codex CLI and Claude Code launch the stdio server directly and need neither.

## Tools

| Tool | What it does |
| --- | --- |
| `canvas_add_screenshot` | Add an image from a local path (auto-uploaded), http(s) URL, data URL, or `base64`+`mime`. Keeps aspect ratio (default width 900). Returns id. |
| `canvas_add_video` | Add mp4/webm/mov the same way; `autoplay`, `seek_to` (seconds). Default 640x360. |
| `canvas_add_shape` | `rectangle`, `ellipse`, `line`, `text`, `note` with optional text/color/size. |
| `canvas_add_arrow` | Arrow between two existing element ids, optional label/color. |
| `canvas_annotate` | Highlight box on a screenshot/video. Box is fractions (0..1) of the target: `x=px_x/W, y=px_y/H, w=px_w/W, h=px_h/H`. Severity colors it. |
| `canvas_add_finding` | Finding card: title, severity, expected/actual, verified, target id, video timestamp. |
| `canvas_move` / `canvas_update` / `canvas_delete` | Edit an element by id. |
| `canvas_focus` | Pan/zoom the human's viewport to `ids` or a pixel `box`. |
| `canvas_cursor` | Glide your avatar (orange Ignura cursor + name tag) to canvas `x,y`; optional `label` sets the tag. Add/edit tools already move it for you; use this to point at something you have not changed. |
| `canvas_say` | Leave a speech bubble on the board (`text`), hung off an element (`target` id) or pointing at `x,y`. It stays on the canvas (shows in screenshots) and your cursor glides to it. |
| `canvas_clear` | Wipe the board (`DELETE /api/state`). |
| `canvas_get_state` | Compact element list (id, type, position, size, label, props) replayed from the op log, with overall bounds and next free x/y. |
| `canvas_layout_flow` | Lay existing ids out left-to-right (or `down`) with a gap and add arrows between consecutive ones. |
| `canvas_batch` | Post raw ops (validated against `OpSchema`) in one call. |

All `add_*` tools accept an optional `id`. Pick your own ids when later calls reference them; otherwise ids are generated and returned in the tool result.

## Agent presence: cursor and speech

The canvas shows your agent as an orange Ignura cursor with a name tag (default "Iggy") that glides to every element you add, and an **Activity** panel on the left lists what you did in plain language ("Added screenshot: Signup", "Flagged high: Signup button does nothing"). Clicking a row zooms to that element. Two additive ops (raw JSON works with `POST /api/ops` and `canvas_batch` too):

```json
{ "type": "cursor", "x": 560, "y": 120, "label": "QA agent" }
{ "type": "say", "text": "This button does nothing on the second tap", "target": "signup" }
{ "type": "say", "text": "Starting with the signup flow", "x": 0, "y": -40 }
```

`say` bubbles are real canvas elements (they have an id, can be moved/deleted like anything else). New arrows and annotation boxes draw themselves on, cards pop in, findings stamp in; all of it is skipped on reload and under `prefers-reduced-motion`.

## Example agent run: teardown map

```
1. canvas_add_screenshot {path_or_url:"/tmp/shots/01-login.png", x:0,    y:0, w:390, label:"Login",    step:1, id:"login"}
2. canvas_add_screenshot {path_or_url:"/tmp/shots/02-home.png",  x:550,  y:0, w:390, label:"Home",     step:2, id:"home"}
3. canvas_add_screenshot {path_or_url:"/tmp/shots/03-cart.png",  x:1100, y:0, w:390, label:"Cart",     step:3, id:"cart"}
4. canvas_layout_flow    {ids:["login","home","cart"], gap:160, arrow_labels:["tap Sign in","tap Cart"]}
5. canvas_annotate       {target:"cart", box:{x:0.08,y:0.86,w:0.84,h:0.07}, label:"Checkout CTA below fold", severity:"high"}
6. canvas_add_finding    {x:1100, y:1000, title:"Checkout CTA clipped on small screens", severity:"high", expected:"CTA visible without scrolling", actual:"CTA cut off by tab bar", target:"cart", verified:true}
7. canvas_add_arrow      {from:"finding-xxxx", to:"cart", label:"see"}   // use the id returned in step 6
8. canvas_get_state      {}                                              // check layout, find free space
9. canvas_say            {text:"Cart CTA is the weak spot", target:"cart"}
10. canvas_focus         {ids:["login","home","cart"]}
```

## Gotchas

- stdout is the MCP transport; the server logs only to stderr.
- Arrows, annotations and findings with `target` need the referenced ids to exist already; add media first.
- `canvas_add_screenshot` with only `w` and a URL source cannot know the aspect ratio, so height is left to the canvas; `canvas_get_state` marks such sizes "estimated" and `canvas_layout_flow` falls back to 640x400 proportions.
- Local file upload goes through `POST /api/upload`, so the canvas must be running even when screenshots come from disk. Use `data:` URLs or http(s) URLs to skip the upload.
- `canvas_batch` takes already-hosted `src` URLs; use `canvas_add_screenshot` for local files.
