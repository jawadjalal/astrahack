// Run: node --test canvas/test   Per-run boards: id rules, store isolation (memory + a fake blob), and the sample-data guard.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertSampleWriteAllowed, boardApi, boardForRun, parseBoard, withBoard } from "../src/lib/board.mjs";
import * as store from "../src/server/store.ts";

const note = (id, text = "x") => ({ type: "add_shape", id, kind: "note", x: 0, y: 0, text });

test("board ids: default main, strict alphabet, 64 chars", () => {
  assert.equal(parseBoard(undefined), "main");
  assert.equal(parseBoard(""), "main");
  assert.equal(parseBoard("0b7e4f3c-1111-2222-3333-444455556666"), "0b7e4f3c-1111-2222-3333-444455556666");
  for (const bad of ["../x", "a/b", "a b", "a_b", "x".repeat(65), "é"]) assert.equal(parseBoard(bad), null, bad);
  assert.equal(boardForRun("run_1"), "run-1");
  assert.equal(boardForRun("a".repeat(80)).length, 64);
});

test("withBoard / boardApi leave main URLs unchanged and add ?board= elsewhere (base paths ok)", () => {
  assert.equal(withBoard("/api/ops", "main"), "/api/ops");
  assert.equal(withBoard("/api/events?since=3", "r1"), "/api/events?since=3&board=r1");
  assert.equal(boardApi("https://ignura.com/astrahack/", "r1")("/ops"), "https://ignura.com/astrahack/api/ops?board=r1");
  assert.equal(boardApi("http://localhost:3000", undefined)("/state"), "http://localhost:3000/api/state");
});

test("memory store: boards are isolated, clear only resets its own board, listeners are per board", async () => {
  delete process.env.CANVAS_STORE;
  store.__resetStoreForTests();
  const seen = { a: [], main: [] };
  const offA = store.subscribe((e) => seen.a.push(e.op.id), "board-a");
  const offM = store.subscribe((e) => seen.main.push(e.op.id));
  await store.appendMany([note("a1"), note("a2")], "board-a", "tab1");
  await store.append(note("m1"));
  assert.deepEqual((await store.list(0, "board-a")).map((e) => e.op.id), ["a1", "a2"]);
  assert.deepEqual((await store.list()).map((e) => e.op.id), ["m1"]);
  assert.equal((await store.list(0, "board-a"))[0].src, "tab1");
  assert.deepEqual(seen, { a: ["a1", "a2"], main: ["m1"] });
  await store.clear("board-a");
  assert.equal((await store.list(0, "board-a")).length, 1); // just the clear marker
  assert.equal((await store.list(0, "board-a"))[0].op.type, "clear");
  assert.equal((await store.list()).length, 1); // main untouched
  assert.equal((await store.list(0, "never-used")).length, 0);
  offA(); offM();
  await assert.rejects(store.list(0, "../evil"), /invalid board id/);
});

function fakeBlob() {
  const files = new Map();
  return {
    files,
    async list(prefix) { return { blobs: [...files.keys()].filter((p) => p.startsWith(prefix)).map((pathname) => ({ pathname, url: `fake://${pathname}` })), hasMore: false }; },
    async put(pathname, body) { files.set(pathname, body); },
    async del(urls) { for (const u of urls) files.delete(u.replace("fake://", "")); },
    async read(url) { const b = files.get(url.replace("fake://", "")); return b ? JSON.parse(b) : null; },
  };
}

test("blob store: main keeps ops/, other boards use boards/<id>/ops/, and neither sees the other", async () => {
  process.env.CANVAS_STORE = "blob";
  const blob = fakeBlob();
  store.__resetStoreForTests();
  store.__setBlobApiForTests(blob);
  try {
    await store.append(note("m1"));
    await store.appendMany([note("r1"), note("r2")], "run-1");
    await store.append(note("r3"), "run-2");
    const paths = [...blob.files.keys()];
    assert.equal(paths.filter((p) => p.startsWith("ops/")).length, 1);
    assert.equal(paths.filter((p) => p.startsWith("boards/run-1/ops/")).length, 1);
    assert.equal(paths.filter((p) => p.startsWith("boards/run-2/ops/")).length, 1);
    assert.deepEqual((await store.list()).map((e) => e.op.id), ["m1"]);
    assert.deepEqual((await store.list(0, "run-1")).map((e) => e.op.id), ["r1", "r2"]);
    assert.deepEqual((await store.list(0, "run-2")).map((e) => e.op.id), ["r3"]);
    assert.equal(store.prefixOf("main"), "ops/");
    // clear on a run board deletes only that board's older blobs
    await new Promise((r) => setTimeout(r, 3));
    await store.clear("run-1");
    assert.deepEqual((await store.list(0, "run-1")).map((e) => e.op.type), ["clear"]);
    assert.deepEqual((await store.list()).map((e) => e.op.id), ["m1"]);
    assert.deepEqual((await store.list(0, "run-2")).map((e) => e.op.id), ["r3"]);
  } finally {
    store.__setBlobApiForTests(null);
    store.__resetStoreForTests();
    delete process.env.CANVAS_STORE;
  }
});

test("sample guard: main on a remote canvas is refused without --force-prod; boards and localhost are fine", () => {
  const remote = "https://ignura.com/astrahack";
  assert.throws(() => assertSampleWriteAllowed({ board: "main", canvasUrl: remote }), /refusing/);
  assert.throws(() => assertSampleWriteAllowed({ canvasUrl: remote }), /refusing/);
  assert.doesNotThrow(() => assertSampleWriteAllowed({ board: "main", canvasUrl: remote, forceProd: true }));
  assert.doesNotThrow(() => assertSampleWriteAllowed({ board: "sample-demo", canvasUrl: remote }));
  assert.doesNotThrow(() => assertSampleWriteAllowed({ board: "main", canvasUrl: "http://localhost:3000" }));
  assert.doesNotThrow(() => assertSampleWriteAllowed({ board: "main", canvasUrl: "http://127.0.0.1:3100" }));
});

test("seed-demo.mjs refuses main on a remote canvas (exit 1, before any request) and labels the sample", () => {
  const script = fileURLToPath(new URL("../scripts/seed-demo.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [script, "--canvas", "https://canvas.invalid/astrahack"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to write/);
  const ops = JSON.parse(execFileSync(process.execPath, [script, "--dry-run"], { encoding: "utf8" }));
  assert.ok(ops.some((o) => o.id === "sample-label" && o.text === "Sample (not a real run)"));
});
