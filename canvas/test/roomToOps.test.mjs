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
