// Smoke test for the astrahack-canvas MCP server.
//   node mcp/test.mjs                      -> spins up a throwaway mock canvas HTTP server and tests against it
//   CANVAS_URL=http://localhost:3000 node mcp/test.mjs  -> tests against a REAL running canvas (clears it first!)
import http from "node:http";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const REAL = process.env.CANVAS_URL;

// ---- throwaway mock of the canvas HTTP API (only used when CANVAS_URL is unset) ----
function startMock() {
  const log = []; let seq = 0, n = 0, uploads = 0;
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const send = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url === "/api/ops" && req.method === "POST") {
        const ops = [].concat(JSON.parse(body.toString()));
        const seqs = [], ids = [];
        for (const op of ops) {
          if (!op.id && op.type !== "clear" && op.type !== "focus") op.id = `auto-${++n}`;
          log.push({ seq: ++seq, ts: Date.now(), op }); seqs.push(seq); if (op.id) ids.push(op.id);
        }
        return send({ ok: true, seqs, ids });
      }
      if (req.url === "/api/state" && req.method === "GET") return send({ seq, ops: log });
      if (req.url === "/api/state" && req.method === "DELETE") { log.length = 0; log.push({ seq: ++seq, ts: Date.now(), op: { type: "clear" } }); return send({ ok: true }); }
      if (req.url === "/api/upload" && req.method === "POST") {
        assert.match(String(req.headers["content-type"]), /multipart\/form-data/);
        assert.ok(body.includes(Buffer.from('name="file"')), "multipart has a `file` part");
        return send({ url: `/uploads/mock-${++uploads}.png` });
      }
      send({ error: "not found" }, 404);
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, url: `http://127.0.0.1:${srv.address().port}`, log })));
}

// 2x1... actually a 200x100 PNG header is enough for the size sniffing (server only reads IHDR).
function tinyPng(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}

const text = (r) => r.content.map((c) => c.text).join("\n");
const idOf = (r) => /id=([^\s.]+?)[\s.]/.exec(text(r) + " ")[1];

async function run(base) {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(here, "server.ts")],
    cwd: join(here, ".."),
    env: { ...process.env, CANVAS_URL: base },
    stderr: "inherit",
  }));

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log("tools:", names.join(", "));
  for (const n of ["canvas_add_screenshot", "canvas_add_video", "canvas_add_shape", "canvas_add_arrow", "canvas_annotate", "canvas_add_finding", "canvas_move", "canvas_update", "canvas_delete", "canvas_focus", "canvas_clear", "canvas_get_state", "canvas_layout_flow", "canvas_batch"]) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); console.log(`> ${name}:`, text(r).split("\n")[0]); return r; };

  await call("canvas_clear", {});
  const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
  const pngA = join(dir, "a.png"), pngB = join(dir, "b.png");
  writeFileSync(pngA, tinyPng(390, 844)); writeFileSync(pngB, tinyPng(390, 844));

  const a = await call("canvas_add_screenshot", { path_or_url: pngA, x: 0, y: 0, w: 390, label: "Login", step: 1, id: "s1" });
  assert.ok(!a.isError, text(a));
  const b = await call("canvas_add_screenshot", { path_or_url: pngB, x: 100, y: 500, label: "Home", step: 2, id: "s2" });
  assert.equal(idOf(b), "s2");
  const url = await call("canvas_add_screenshot", { path_or_url: "https://example.com/x.png", x: 0, y: 1200, id: "s3" });
  assert.ok(!url.isError);
  const b64 = await call("canvas_add_screenshot", { base64: tinyPng(100, 50).toString("base64"), mime: "image/png", x: 0, y: 1800, id: "s4" });
  assert.ok(!b64.isError, text(b64));
  const vid = await call("canvas_add_video", { path_or_url: "https://example.com/v.mp4", x: 2000, y: 0, seek_to: 12.5, label: "repro", id: "v1" });
  assert.ok(!vid.isError, text(vid));
  const note = await call("canvas_add_shape", { kind: "note", x: 2000, y: 600, text: "hello", color: "yellow" });
  assert.ok(!note.isError);

  const ann = await call("canvas_annotate", { target: "s1", box: { x: 0.31, y: 0.76, w: 0.5, h: 0.06 }, label: "Button dead", severity: "high" });
  assert.ok(!ann.isError, text(ann));
  const bad = await client.callTool({ name: "canvas_annotate", arguments: { target: "s1", box: { x: 0.8, y: 0.1, w: 0.5, h: 0.1 }, severity: "low" } });
  assert.ok(bad.isError, "out-of-range box must error");
  const f = await call("canvas_add_finding", { x: 500, y: 0, title: "Tap does nothing", severity: "critical", expected: "navigate", actual: "stays", target: "s1", verified: true });
  assert.ok(!f.isError, text(f));

  const flow = await call("canvas_layout_flow", { ids: ["s1", "s2"], start_x: 0, start_y: 0, gap: 100, arrow_labels: ["tap Sign in"] });
  assert.ok(!flow.isError, text(flow));
  await call("canvas_move", { id: "s4", x: 5, y: 6 });
  await call("canvas_update", { id: "s4", props: { label: "renamed" } });
  await call("canvas_add_arrow", { from: "s1", to: "s3", label: "x" });
  await call("canvas_focus", { ids: ["s1", "s2"] });
  await call("canvas_delete", { id: "s3" });
  const batch = await call("canvas_batch", { ops: [{ type: "add_shape", id: "b1", kind: "rectangle", x: 1, y: 1 }] });
  assert.ok(!batch.isError, text(batch));
  const badBatch = await client.callTool({ name: "canvas_batch", arguments: { ops: [{ type: "move", id: "b1" }] } });
  assert.ok(badBatch.isError && /invalid/.test(text(badBatch)), "invalid batch op must error clearly");

  const state = text(await client.callTool({ name: "canvas_get_state", arguments: {} }));
  console.log("\n" + state + "\n");
  assert.match(state, /s1 \[image\] at \(0,0\) size 390x844/); // aspect ratio from PNG header kept
  assert.match(state, /s2 \[image\] at \(490,0\) size 900x1950|s2 \[image\] at \(490,0\)/); // laid out right of s1 (390 + gap 100)
  assert.match(state, /s4 \[image\] at \(5,6\).*"renamed"/);
  assert.doesNotMatch(state, /\bs3\b.*\[image\]/); // deleted
  assert.match(state, /\[finding\].*Tap does nothing/);
  assert.match(state, /\[annotation\]/);

  // server-down error is actionable
  const dead = new Client({ name: "dead", version: "0.0.0" });
  await dead.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", join(here, "server.ts")], cwd: join(here, ".."), env: { ...process.env, CANVAS_URL: "http://127.0.0.1:9" }, stderr: "ignore" }));
  const down = await dead.callTool({ name: "canvas_get_state", arguments: {} });
  assert.ok(down.isError && /npm run dev/.test(text(down)), text(down));
  console.log("> server-down:", text(down).slice(0, 120));
  await dead.close();
  await client.close();
}

let mock;
try {
  let base = REAL;
  if (!base) { mock = await startMock(); base = mock.url; console.log("using mock canvas at", base); }
  await run(base);
  console.log("\nALL MCP TESTS PASSED");
  mock?.srv.close();
  process.exit(0);
} catch (e) {
  console.error("\nTEST FAILED:", e);
  mock?.srv.close();
  process.exit(1);
}
