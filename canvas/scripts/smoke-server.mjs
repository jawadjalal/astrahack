// Usage: BASE=http://localhost:3000 node scripts/smoke-server.mjs
import assert from "node:assert/strict";

const BASE = process.env.BASE ?? "http://localhost:3000";
const post = (body) =>
  fetch(`${BASE}/api/ops`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

await fetch(`${BASE}/api/state`, { method: "DELETE" });

// open SSE first, then write, assert events arrive live
const ac = new AbortController();
const sse = await fetch(`${BASE}/api/events`, { signal: ac.signal });
assert.equal(sse.status, 200);
assert.match(sse.headers.get("content-type") ?? "", /text\/event-stream/);
assert.equal(sse.headers.get("access-control-allow-origin"), "*");
const received = [];
const reader = sse.body.getReader();
const dec = new TextDecoder();
(async () => {
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (frame.startsWith("data: ")) received.push(JSON.parse(frame.slice(6)));
      }
    }
  } catch {
    /* aborted */
  }
})();

// invalid op in a batch -> 400, nothing applied
let r = await post([{ type: "add_shape", kind: "rectangle", x: 0, y: 0 }, { type: "bogus" }]);
assert.equal(r.status, 400);
assert.equal((await r.json()).ok, false);
let st = await (await fetch(`${BASE}/api/state`)).json();
assert.equal(st.ops.length, 1, "only the clear op should exist; invalid batch must apply nothing");

// single op, server assigns id
r = await post({ type: "add_shape", kind: "rectangle", x: 10, y: 20, w: 100, h: 50, text: "hi", color: "blue" });
let j = await r.json();
assert.equal(r.status, 200);
assert.equal(j.ok, true);
assert.match(j.ids[0], /^n_[a-z0-9]{6}$/);

// batch: caller id note + non-creating op
r = await post([
  { type: "add_shape", id: "mynote", kind: "note", x: 200, y: 20, text: "a note" },
  { type: "move", id: "mynote", x: 300, y: 40 },
]);
j = await r.json();
assert.deepEqual(j.ids, ["mynote", "mynote"]); // move echoes its target id
assert.equal(j.seqs.length, 2);

// CORS preflight
r = await fetch(`${BASE}/api/ops`, { method: "OPTIONS" });
assert.equal(r.status, 204);
assert.equal(r.headers.get("access-control-allow-origin"), "*");

// state: clear + 3 ops, assigned id is stored in the log
st = await (await fetch(`${BASE}/api/state`)).json();
assert.equal(st.ops.length, 4);
assert.equal(st.ops[0].op.type, "clear");
assert.match(st.ops[1].op.id, /^n_[a-z0-9]{6}$/);
assert.equal(st.seq, st.ops.at(-1).seq);

// upload
const fd = new FormData();
fd.append("file", new File([new Uint8Array([137, 80, 78, 71])], "te st.png", { type: "image/png" }));
r = await fetch(`${BASE}/api/upload`, { method: "POST", body: fd });
j = await r.json();
assert.match(j.url, /\/uploads\/[0-9a-f]{8}-te_st\.png$/);
assert.equal((await fetch(new URL(j.url, BASE).href)).status, 200);

// let SSE flush ~1s
await new Promise((res) => setTimeout(res, 1000));
assert.ok(received.length >= 3, `expected >=3 live events, got ${received.length}`);
assert.ok(received.some((e) => e.op.type === "add_shape"));

// replay with since
const since = st.ops[0].seq;
const ac2 = new AbortController();
const rep = await fetch(`${BASE}/api/events?since=${since}`, { signal: ac2.signal });
const first = await rep.body.getReader().read();
const text = new TextDecoder().decode(first.value);
assert.ok(text.includes(`"seq":${since + 1}`), `replay should start at seq ${since + 1}: ${text.slice(0, 200)}`);
assert.ok(!text.includes(`"seq":${since},`), "replay must not include since itself");
ac2.abort();

// delete -> clear
r = await fetch(`${BASE}/api/state`, { method: "DELETE" });
assert.equal((await r.json()).ok, true);
st = await (await fetch(`${BASE}/api/state`)).json();
assert.equal(st.ops.length, 1);
assert.equal(st.ops[0].op.type, "clear");
await new Promise((res) => setTimeout(res, 200));
assert.equal(received.at(-1).op.type, "clear");

ac.abort();
console.log("smoke-server OK");
process.exit(0);
