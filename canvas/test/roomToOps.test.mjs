import assert from "node:assert/strict";
import test from "node:test";
import { OpSchema } from "../src/lib/ops.ts";
import { roomToOps, roomToSteps, roomFromPayload, ROOM_PREFIX } from "../src/lib/roomToOps.ts";

const payload = {
  name: "Acme", blurb: "A room.",
  board: "rm-0123456789abcdef01234567",
  columns: [{ id: "c1", title: "Up next", position: 0 }, { id: "c2", title: "Done", position: 1 }],
  cards: [
    { id: "k1", column_id: "c1", title: "Fix hero", body: "Hook: x\nFormat: y", position: 0, placeholder: false, client_visible: true },
    { id: "k2", column_id: "c1", title: "Internal card", body: "no", position: 1, placeholder: false, client_visible: false },
    { id: "k3", column_id: "c2", title: "Placeholder", body: "p", position: 0, placeholder: true, client_visible: true },
  ],
  findings: [{ id: "f1", title: "Site", body: "Checked.", href: "https://acme.test", image_url: "https://acme.test/shot.png", position: 0, placeholder: false, client_visible: true }],
  sections: [
    { id: "s1", title: "The read", body: "Good line.", position: 0, placeholder: false, client_visible: true },
    { id: "s2", title: "Pitch (internal)", body: "secret", position: 1, placeholder: false, client_visible: false },
  ],
  drawings: [{ id: "d1", title: "Sketches", note: "Nothing drawn.", strokes: [], position: 0, placeholder: false, client_visible: true }],
};

test("every op is valid and ids are stable and unique", async () => {
  const ops = await roomToOps(roomFromPayload(payload), async () => ({ w: 1000, h: 500 }));
  assert.ok(ops.length > 10);
  for (const op of ops) assert.ok(OpSchema.safeParse(op).success, JSON.stringify(op));
  const ids = ops.filter((op) => op.type !== "update").map((op) => op.id).filter(Boolean); // an update names the shape it changes
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id.startsWith(ROOM_PREFIX) && id.length <= 64));
  const again = await roomToOps(roomFromPayload(payload), async () => ({ w: 1000, h: 500 }));
  assert.deepEqual(again, ops);
});

test("only what a client may see reaches the board", async () => {
  const text = JSON.stringify(await roomToOps(roomFromPayload(payload)));
  assert.ok(text.includes("Fix hero") && text.includes("The read") && text.includes("Site"));
  assert.ok(!text.includes("Internal card") && !text.includes("secret") && !text.includes('"Placeholder"'));
});

test("a finding's screenshot becomes an image sized to its ratio, inside its card", async () => {
  const steps = await roomToSteps(roomFromPayload(payload), async () => ({ w: 1000, h: 500 }));
  const ops = steps.flat();
  const img = ops.find((op) => op.type === "add_image");
  assert.equal(img.src, "https://acme.test/shot.png");
  assert.equal(Math.round(img.h / img.w * 100), 50);
  const card = ops.find((op) => op.id === img.id.replace(/-i$/, ""));
  assert.ok(img.y > card.y && img.y + img.h <= card.y + card.h);
});

test("cards never overlap inside a lane", async () => {
  const many = { ...payload, sections: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, title: `T${i}`, body: "word ".repeat(120), position: i, client_visible: true })) };
  const rects = (await roomToOps(roomFromPayload(many))).filter((op) => op.type === "add_shape");
  for (const a of rects) for (const b of rects) {
    if (a === b) continue;
    const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
    assert.ok(apart, `${a.id} overlaps ${b.id}`);
  }
});

test("a new room with only placeholders still draws its title card", async () => {
  const blank = { name: "New", blurb: "", columns: [], cards: [{ id: "k", column_id: "c", title: "Placeholder", placeholder: true, client_visible: true }], findings: [], sections: [], drawings: [] };
  const ops = await roomToOps(roomFromPayload(blank));
  assert.ok(ops.some((op) => op.type === "add_text" && op.text === "New"));
});

const diagramRoom = {
  name: "D", blurb: "", columns: [], cards: [], findings: [], sections: [], drawings: [],
  diagrams: [
    { id: "loop", title: "The loop", layout: "cycle", nodes: [{ id: "a", text: "Run an event" }, { id: "b", text: "Film it", sub: "10+ clips" }, { id: "c", text: "Post" }, { id: "d", text: "Waitlist" }] },
    { id: "flow", title: "Today", layout: "flow", nodes: [{ id: "a", text: "TikTok", color: "red" }, { id: "b", text: "Site" }, { id: "c", text: "Chat" }], edges: [{ from: "a", to: "b", label: "0 videos" }, { from: "b", to: "c" }] },
    { id: "hub", title: "Angles", layout: "hub", nodes: [{ id: "h", text: "UGC" }, { id: "x", text: "One" }, { id: "y", text: "Two" }, { id: "z", text: "Three" }] },
  ],
};

test("diagrams: valid ops, arrows come after their nodes, defaults per layout", async () => {
  const steps = await roomToSteps(roomFromPayload(diagramRoom));
  const ops = steps.flat();
  for (const op of ops) assert.ok(OpSchema.safeParse(op).success, JSON.stringify(op));
  const arrows = ops.filter((op) => op.type === "add_arrow");
  assert.equal(arrows.length, 4 + 2 + 3); // ring of 4 closes, the flow keeps its 2 edges, the hub has 3 spokes
  const firstArrowAt = ops.findIndex((op) => op.type === "add_arrow");
  for (const a of arrows) {
    const made = ops.findIndex((op) => op.id === a.from);
    const to = ops.findIndex((op) => op.id === a.to);
    assert.ok(made >= 0 && to >= 0 && made < ops.indexOf(a) && to < ops.indexOf(a), `${a.id} points at a node that does not exist before it`);
  }
  assert.ok(firstArrowAt > 0);
  assert.ok(arrows.some((a) => a.label === "0 videos"));
  const ids = ops.filter((op) => op.type !== "update").map((op) => op.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
});

test("diagram boxes sit inside their frame and never overlap each other", async () => {
  const ops = (await roomToOps(roomFromPayload(diagramRoom))).filter((op) => op.type === "add_shape");
  const frames = ops.filter((o) => o.id.endsWith("-frame"));
  const nodes = ops.filter((o) => /-n\d+$/.test(o.id));
  assert.equal(frames.length, 3);
  for (const n of nodes) {
    const f = frames.find((fr) => n.id.startsWith(fr.id.replace(/-frame$/, "-")));
    assert.ok(n.x >= f.x && n.y >= f.y && n.x + n.w <= f.x + f.w && n.y + n.h <= f.y + f.h, `${n.id} leaves its frame`);
  }
  for (const a of nodes) for (const b of nodes) {
    if (a === b) continue;
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} overlaps ${b.id}`);
  }
  for (const a of frames) for (const b of frames) {
    if (a === b) continue;
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} overlaps ${b.id}`);
  }
});

const visualRoom = {
  name: "V", blurb: "", columns: [], cards: [], findings: [], sections: [], drawings: [],
  diagrams: [
    { id: "stars", title: "Store ratings", layout: "bars", max: 5, rows: [
      { label: "Loop", value: 4.6, display: "4.6", sub: "1k ratings" },
      { label: "Rivet iOS", value: 4.0, display: "4.0", color: "orange" },
      { label: "Rivet Play", value: 3.7, display: "3.7", color: "orange" },
    ] },
    { id: "store", title: "The store listing", layout: "gallery", images: [
      { src: "https://x.test/1.png", caption: "Where people pick", note: "Vague" },
      { src: "https://x.test/2.png", caption: "Get introduced" },
      { src: "https://x.test/3.png", caption: "Verified profiles" },
    ] },
  ],
};

test("bars: width follows the value, the highlight is orange, values are written out", async () => {
  const ops = (await roomToOps(roomFromPayload(visualRoom))).filter((o) => o.id && o.id.startsWith("rd-b-stars-"));
  for (const op of ops) assert.ok(OpSchema.safeParse(op).success, JSON.stringify(op));
  const bars = ops.filter((o) => o.type === "add_shape" && /-r\d$/.test(o.id));
  assert.equal(bars.length, 3);
  assert.ok(bars[0].w > bars[1].w && bars[1].w > bars[2].w, "longest value, longest bar");
  assert.equal(Math.round((bars[0].w / bars[1].w) * 100) / 100, Math.round((4.6 / 4.0) * 100) / 100);
  assert.deepEqual(bars.map((b) => b.color), ["grey", "orange", "orange"]);
  assert.ok(ops.some((o) => o.type === "add_text" && o.text === "3.7"));
  assert.equal(ops.filter((o) => o.type === "update" && o.props.fill === "pattern").length, 3);
});

test("gallery: images keep their ratio, in a row, each inside the frame, with numbered captions", async () => {
  const ops = await roomToOps(roomFromPayload(visualRoom), async () => ({ w: 1000, h: 2000 }));
  const mine = ops.filter((o) => o.id && o.id.startsWith("rd-v-store-"));
  for (const op of mine) assert.ok(OpSchema.safeParse(op).success, JSON.stringify(op));
  const imgs = mine.filter((o) => o.type === "add_image");
  const frame = mine.find((o) => o.id.endsWith("-frame"));
  assert.equal(imgs.length, 3);
  for (const i of imgs) {
    assert.equal(i.h / i.w, 2);
    assert.ok(i.x >= frame.x && i.x + i.w <= frame.x + frame.w && i.y + i.h <= frame.y + frame.h);
  }
  assert.ok(imgs[0].x + imgs[0].w < imgs[1].x);
  assert.ok(mine.some((o) => o.type === "add_text" && o.text === "2. Get introduced"));
});

test("a long note gets a wide card and is trimmed on the board", async () => {
  const long = { name: "L", blurb: "", columns: [], cards: [], findings: [], drawings: [], sections: [
    { id: "a", title: "Short", body: "Hi.", position: 0, client_visible: true },
    { id: "b", title: "Long", body: "Sentence one is here. ".repeat(160), position: 1, client_visible: true },
  ] };
  const ops = await roomToOps(roomFromPayload(long));
  const rects = ops.filter((o) => o.type === "add_shape");
  const narrow = rects.find((r) => r.id.includes("-s-a"));
  const wide = rects.find((r) => r.id.includes("-s-b"));
  assert.ok(wide.w > narrow.w * 2 - 1, "the long note spans two columns");
  const body = ops.find((o) => o.id === `${wide.id}-b`).text;
  assert.ok(body.length < 700 && body.endsWith("more on the Notes page"));
});
