// Run: node --test canvas/test   (Node >= 22.18 strips the TS types in ops.ts natively)
// Contract tests for the markup ops (draw, arrow_to, highlight, add_text, group, lock, order).
import test from "node:test";
import assert from "node:assert/strict";
import { OpSchema, markupOps } from "../src/lib/ops.ts";

const ok = (op) => {
  const r = OpSchema.safeParse(op);
  assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues));
  return r.data;
};
const bad = (op, re) => {
  const r = OpSchema.safeParse(op);
  assert.ok(!r.success, `expected invalid: ${JSON.stringify(op)}`);
  if (re) assert.match(JSON.stringify(r.error.issues), re);
};
const line = (n) => Array.from({ length: n }, (_, i) => ({ x: i, y: i * 2 }));

test("all seven markup op types are in the OpSchema union and existing ops are untouched", () => {
  const types = markupOps.map((s) => s.shape.type.value).sort();
  assert.deepEqual(types, ["add_text", "arrow_to", "draw", "group", "highlight", "lock", "order"]);
  // pre-existing ops still parse exactly as before
  ok({ type: "add_shape", kind: "note", x: 1, y: 2 });
  ok({ type: "add_arrow", from: "a", to: "b" });
  ok({ type: "annotate", target: "t", box: { x: 0, y: 0, w: 1, h: 1 } });
  ok({ type: "clear" });
  bad({ type: "nope" });
});

test("draw: 2..500 canvas points, optional style/size/color/animate", () => {
  const d = ok({ type: "draw", points: line(2) });
  assert.equal(d.points.length, 2);
  ok({ type: "draw", id: "s1", points: line(500), color: "red", size: "xl", style: "highlighter", animate: true });
  ok({ type: "draw", points: [{ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.8 }], target: "shot", space: "target" });
  bad({ type: "draw", points: line(1) }, /points/);
  bad({ type: "draw", points: line(501) }, /points/);
  bad({ type: "draw", points: [] });
  bad({ type: "draw" });
  bad({ type: "draw", points: line(3), size: "xxl" });
  bad({ type: "draw", points: line(3), style: "crayon" });
  bad({ type: "draw", points: line(3), space: "page" });
  bad({ type: "draw", points: [{ x: 1 }, { x: 2, y: 3 }] });
  bad({ type: "draw", points: line(3), color: "pink" });
});

test("draw: id is capped at 64 chars like every other op", () => {
  bad({ type: "draw", id: "x".repeat(65), points: line(2) });
  bad({ type: "draw", id: "", points: line(2) });
});

test("arrow_to: each end is an element id, a canvas point, or a spot on an element", () => {
  ok({ type: "arrow_to", from: "note1", to: "shot" });
  ok({ type: "arrow_to", from: { x: 0, y: 0 }, to: { x: 100, y: 50 }, label: "here", color: "red", bend: -40 });
  ok({ type: "arrow_to", from: "note1", to: { target: "shot", fx: 0.4, fy: 0.9 } });
  ok({ type: "arrow_to", from: { target: "shot", fx: 1.5, fy: 0.5, dx: 12, dy: -8 }, to: { target: "shot", fx: 0.5, fy: 0.5 }, attach: "shot", size: "l" });
  const a = ok({ type: "arrow_to", from: "a", to: "b" });
  assert.equal(a.from, "a");
  bad({ type: "arrow_to", to: "b" }, /from/);
  bad({ type: "arrow_to", from: "a" }, /to/);
  bad({ type: "arrow_to", from: { x: 1 }, to: "b" });
  bad({ type: "arrow_to", from: { target: "shot", fx: 0.5 }, to: "b" });
  bad({ type: "arrow_to", from: "a", to: "b", bend: "lots" });
  bad({ type: "arrow_to", from: "", to: "b" });
});

test("highlight: fractional box on a target, rectangle or ellipse, optional label/opacity", () => {
  const h = ok({ type: "highlight", target: "shot", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } });
  assert.equal(h.kind, undefined);
  ok({ type: "highlight", id: "h1", target: "shot", box: { x: 0, y: 0, w: 1, h: 1 }, kind: "ellipse", color: "light-blue", label: "look here", opacity: 0.5 });
  bad({ type: "highlight", box: { x: 0, y: 0, w: 1, h: 1 } }, /target/);
  bad({ type: "highlight", target: "shot" }, /box/);
  bad({ type: "highlight", target: "shot", box: { x: 0, y: 0, w: 1 } });
  bad({ type: "highlight", target: "shot", box: { x: 0, y: 0, w: 1, h: 1 }, kind: "triangle" });
  bad({ type: "highlight", target: "shot", box: { x: 0, y: 0, w: 1, h: 1 }, opacity: 0 });
  bad({ type: "highlight", target: "shot", box: { x: 0, y: 0, w: 1, h: 1 }, opacity: 1.5 });
});

test("add_text: canvas position or anchored to a target, with typography options", () => {
  ok({ type: "add_text", text: "hello", x: 10, y: 20 });
  ok({ type: "add_text", id: "t", text: "Hi", x: 0, y: 0, w: 240, size: "xl", color: "violet", align: "middle", font: "mono" });
  ok({ type: "add_text", text: "caption", target: "shot", at: { fx: 1, fy: 0.5 }, offset: { x: 24, y: -4 } });
  ok({ type: "add_text", text: "above", target: "shot" });
  bad({ type: "add_text", x: 0, y: 0 }, /text/);
  bad({ type: "add_text", text: "x", x: 0, y: 0, align: "left" });
  bad({ type: "add_text", text: "x", x: 0, y: 0, font: "comic" });
  bad({ type: "add_text", text: "x", x: 0, y: 0, w: 0 });
  bad({ type: "add_text", text: "x", target: "s", at: { fx: 1 } });
  bad({ type: "add_text", text: "x", target: "s", offset: { x: 1 } });
});

test("group / lock / order", () => {
  ok({ type: "group", ids: ["a", "b"] });
  ok({ type: "group", id: "g", ids: ["a", "b", "c"], label: "Checkout flow" });
  ok({ type: "group", ids: ["g"], ungroup: true });
  bad({ type: "group", ids: [] });
  bad({ type: "group" });
  bad({ type: "group", ids: ["a", ""] });

  assert.equal(ok({ type: "lock", ids: ["a"] }).locked, true); // defaults to locking
  assert.equal(ok({ type: "lock", ids: ["a"], locked: false }).locked, false);
  bad({ type: "lock", ids: [] });
  bad({ type: "lock", ids: ["a"], locked: "yes" });

  for (const to of ["front", "back", "forward", "backward"]) ok({ type: "order", ids: ["a", "b"], to });
  bad({ type: "order", ids: ["a"], to: "top" });
  bad({ type: "order", ids: ["a"] });
  bad({ type: "order", ids: [], to: "front" });
});

test("a batch mixing old and new ops validates op by op", () => {
  const batch = [
    { type: "add_shape", id: "n", kind: "note", x: 0, y: 0, text: "x" },
    { type: "highlight", target: "n", box: { x: 0, y: 0, w: 0.5, h: 0.5 } },
    { type: "arrow_to", from: "n", to: { x: 5, y: 5 } },
    { type: "group", ids: ["n", "n2"] },
  ];
  assert.ok(batch.every((o) => OpSchema.safeParse(o).success));
});
