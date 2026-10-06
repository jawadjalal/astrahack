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
          if (!op.id && /^(add_|annotate$|draw$|arrow_to$|highlight$|group$)/.test(op.type)) op.id = `auto-${++n}`; // mirrors store.ts CREATES
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

async function run(base, log) {
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
  for (const n of ["canvas_add_screenshot", "canvas_add_video", "canvas_add_shape", "canvas_add_arrow", "canvas_annotate", "canvas_add_finding", "canvas_move", "canvas_update", "canvas_delete", "canvas_focus", "canvas_clear", "canvas_get_state", "canvas_layout_flow", "canvas_batch", "canvas_draw", "canvas_arrow_to", "canvas_highlight", "canvas_add_text", "canvas_group", "canvas_lock", "canvas_order"]) {
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

  // ---- mark-up tools (draw / arrow_to / highlight / add_text / group / lock / order) ----
  const lastOps = (n) => (log ? log.slice(-n).map((e) => e.op) : null);
  const fails = async (name, args, re) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(r.isError, `${name} should error for ${JSON.stringify(args)}`);
    if (re) assert.match(text(r), re);
  };

  const circ = await call("canvas_draw", { shape: "circle", target: "s1", box: { x: 0.1, y: 0.8, w: 0.8, h: 0.1 }, color: "red", id: "circ1", animate: true });
  assert.ok(!circ.isError, text(circ));
  if (log) {
    const [o] = lastOps(1);
    assert.equal(o.type, "draw"); assert.equal(o.id, "circ1"); assert.equal(o.target, "s1"); assert.equal(o.space, "target");
    assert.ok(o.points.length >= 20 && o.points.length <= 500, "circle has a smooth point count");
    assert.ok(o.points.every((p) => p.x > -0.2 && p.x < 1.2 && p.y > 0.6 && p.y < 1.1), "circle stays around its fractional box");
    assert.equal(o.animate, true);
  }
  const cross = await call("canvas_draw", { shape: "cross", box: { x: 400, y: 300, w: 60, h: 60 }, id: "x1" });
  assert.match(text(cross), /x1-2/);
  if (log) { const [a1, a2] = lastOps(2); assert.equal(a1.id, "x1"); assert.equal(a2.id, "x1-2"); assert.equal(a1.space, undefined); }
  const hand = await call("canvas_draw", { points: [{ x: 0, y: 0 }, { x: 40, y: 10 }, { x: 80, y: 0 }], style: "highlighter", color: "yellow", size: "xl", id: "hand1" });
  assert.ok(!hand.isError, text(hand));
  await fails("canvas_draw", { points: [{ x: 100, y: 200 }, { x: 150, y: 220 }], target: "s1" }, /not a fraction/);
  await fails("canvas_draw", { shape: "circle" }, /box/);
  await fails("canvas_draw", {}, /shape \+ box, or points/);
  await fails("canvas_draw", { points: [{ x: 1, y: 1 }] }); // schema: min 2 points

  const arr = await call("canvas_arrow_to", { target: "s1", at: { fx: 0.5, fy: 0.9 }, label: "dead button", color: "red", id: "arr1" });
  assert.ok(!arr.isError, text(arr));
  if (log) {
    const [o] = lastOps(1);
    assert.deepEqual({ ...o.to }, { target: "s1", fx: 0.5, fy: 0.9 });
    assert.equal(o.from.target, "s1"); assert.ok(o.from.dx < 0 && o.from.dy < 0, "default tail is up-left of the tip");
  }
  const arr2 = await call("canvas_arrow_to", { from: "s1", target: "s2", at: { fx: 0.2, fy: 0.3 }, bend: 40 });
  assert.ok(!arr2.isError, text(arr2));
  const arr3 = await call("canvas_arrow_to", { from: { x: 0, y: 0 }, to: { x: 50, y: 50 } });
  assert.ok(!arr3.isError, text(arr3));
  const arr4 = await call("canvas_arrow_to", { to: { x: 500, y: 500 }, from_dir: "down", tail: 100 });
  assert.ok(!arr4.isError, text(arr4));
  if (log) assert.deepEqual(lastOps(1)[0].from, { x: 500, y: 600 });
  await fails("canvas_arrow_to", { target: "s1" }, /together/);
  await fails("canvas_arrow_to", { label: "nowhere" }, /Say where/);
  await fails("canvas_arrow_to", { to: "s1" }, /needs a `from`/);

  const hl = await call("canvas_highlight", { target: "s1", at: { fx: 0.5, fy: 0.5 }, w: 0.4, h: 0.1, kind: "ellipse", label: "look", id: "hl1" });
  assert.ok(!hl.isError, text(hl));
  if (log) { const [o] = lastOps(1); assert.equal(o.kind, "ellipse"); assert.ok(Math.abs(o.box.x - 0.3) < 1e-9 && Math.abs(o.box.w - 0.4) < 1e-9); }
  const hl2 = await call("canvas_highlight", { target: "s1", box: { x: 0.1, y: 0.1, w: 0.5, h: 0.2 } });
  assert.ok(!hl2.isError, text(hl2));
  await fails("canvas_highlight", { target: "s1", box: { x: 0.8, y: 0.1, w: 0.5, h: 0.1 } }, /outside the target/);
  await fails("canvas_highlight", { target: "s1" }, /box.*or at/);

  const tx = await call("canvas_add_text", { text: "Broken CTA", target: "s1", at: { fx: 1, fy: 0.8 }, offset: { x: 24, y: 0 }, color: "red", id: "txt1" });
  assert.ok(!tx.isError, text(tx));
  if (log) { const [o] = lastOps(1); assert.equal(o.target, "s1"); assert.deepEqual(o.at, { fx: 1, fy: 0.8 }); assert.deepEqual(o.offset, { x: 24, y: 0 }); }
  const tx2 = await call("canvas_add_text", { text: "Section", x: 10, y: 20, size: "xl", font: "sans", w: 300, align: "middle", id: "txt2" });
  assert.ok(!tx2.isError, text(tx2));
  await fails("canvas_add_text", { text: "floating" }, /x and y/);
  await fails("canvas_add_text", { text: "x", x: 1, y: 1, at: { fx: 0, fy: 0 } }, /needs a `target`/);

  const grp = await call("canvas_group", { ids: ["s1", "circ1", "hl1"], label: "Login review", id: "grp1" });
  assert.ok(!grp.isError, text(grp));
  await fails("canvas_group", { ids: ["only"] }, /at least 2/);
  const lock = await call("canvas_lock", { ids: ["grp1"] });
  assert.ok(!lock.isError, text(lock));
  if (log) assert.deepEqual(lastOps(1)[0], { type: "lock", ids: ["grp1"], locked: true });
  await call("canvas_lock", { ids: ["grp1"], locked: false });
  if (log) assert.equal(lastOps(1)[0].locked, false);
  const ord = await call("canvas_order", { ids: ["circ1", "hl1"], to: "front" });
  assert.ok(!ord.isError, text(ord));
  await fails("canvas_order", { ids: ["a"], to: "top" });
  const ungroup = await call("canvas_group", { ids: ["grp1"], ungroup: true });
  assert.match(text(ungroup), /Ungrouped/);

  // raw batch accepts the new ops, and rejects malformed ones with a precise message
  const mb = await call("canvas_batch", { ops: [{ type: "draw", points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] }, { type: "order", ids: ["s1"], to: "back" }] });
  assert.ok(!mb.isError, text(mb));
  const mbad = await client.callTool({ name: "canvas_batch", arguments: { ops: [{ type: "draw", points: [{ x: 0, y: 0 }] }] } });
  assert.ok(mbad.isError && /invalid/.test(text(mbad)), "draw with 1 point must be rejected");

  const state = text(await client.callTool({ name: "canvas_get_state", arguments: {} }));
  console.log("\n" + state + "\n");
  assert.match(state, /s1 \[image\] at \(0,0\) size 390x844/); // aspect ratio from PNG header kept
  assert.match(state, /s2 \[image\] at \(490,0\) size 900x1950|s2 \[image\] at \(490,0\)/); // laid out right of s1 (390 + gap 100)
  assert.match(state, /s4 \[image\] at \(5,6\).*"renamed"/);
  assert.doesNotMatch(state, /\bs3\b.*\[image\]/); // deleted
  assert.match(state, /\[finding\].*Tap does nothing/);
  assert.match(state, /\[annotation\]/);
  // mark-up elements show up in the summary
  assert.match(state, /circ1 \[draw\].*target=s1/);
  assert.match(state, /hand1 \[highlighter\] at \(0,0\) size 80x10/);
  assert.match(state, /hl1 \[highlight-box\].*"look".*target=s1/);
  assert.match(state, /txt2 \[text\] at \(10,20\).*"Section"/);
  assert.match(state, /arr1 \[arrow\].*"dead button"/);
  assert.doesNotMatch(state, /grp1 \[group\]/); // ungrouped
  assert.match(state, /Mark-up tip:/);
  const noMarks = text(await client.callTool({ name: "canvas_get_state", arguments: { include_annotations: false } }));
  assert.doesNotMatch(noMarks, /\[draw\]|\[highlight-box\]|\[annotation\]/);

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
  await run(base, mock?.log);
  console.log("\nALL MCP TESTS PASSED");
  mock?.srv.close();
  process.exit(0);
} catch (e) {
  console.error("\nTEST FAILED:", e);
  mock?.srv.close();
  process.exit(1);
}
