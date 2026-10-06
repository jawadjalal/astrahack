// Run: node --test canvas/test   (Node >= 22.18 strips the TS types in leadsToOps.ts natively)
import test from "node:test";
import assert from "node:assert/strict";
import { leadsToOps, leadsToSteps, stateBounds, LANE_PREFIX } from "../src/lib/leadsToOps.ts";
import { OpSchema } from "../src/lib/ops.ts";
import { generateLeads } from "../../leads/index.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = new URL("../../ugc/fixtures/ignura/report.json", import.meta.url).pathname;
const dir = await mkdtemp(join(tmpdir(), "leads-canvas-"));
const { doc } = await generateLeads({ input: FIXTURE, mock: true, outputDir: dir, now: new Date("2026-10-06T12:00:00Z") });
await rm(dir, { recursive: true, force: true });

const ops = leadsToOps(doc, { originX: 100, originY: 5000 });
const shapeOps = ops.filter((o) => o.id);

test("every op parses against the canvas contract and only existing op types are used", () => {
  for (const op of ops) OpSchema.parse(op);
  const types = new Set(ops.map((o) => o.type));
  assert.deepEqual([...types].sort(), ["add_arrow", "add_shape", "add_text", "focus", "say", "update"]);
});

test("ids are unique, stable between runs and carry the lane prefix", () => {
  const ids = shapeOps.filter((o) => o.type !== "update").map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((i) => i.startsWith(LANE_PREFIX) && i.length <= 64));
  assert.deepEqual(leadsToOps(doc, { originX: 100, originY: 5000 }), ops);
});

test("the lane sits at the origin and never above it", () => {
  const ys = ops.filter((o) => typeof o.y === "number" && o.type !== "focus").map((o) => o.y);
  assert.ok(Math.min(...ys) >= 5000);
  assert.ok(ops.filter((o) => typeof o.x === "number" && o.type !== "focus").every((o) => o.x >= 100));
});

test("cards: ICP, one per source, outreach drafts, seven cadence days; source urls are printed as text and set as card links", () => {
  const cards = ops.filter((o) => o.type === "add_shape" && o.kind === "rectangle");
  assert.ok(cards.some((c) => c.id === "ld-icp"));
  assert.equal(cards.filter((c) => c.id.startsWith("ld-src-")).length, doc.sources.length);
  assert.equal(cards.filter((c) => c.id.startsWith("ld-out-")).length, doc.outreach.length);
  assert.equal(cards.filter((c) => c.id.startsWith("ld-day-")).length, 7);
  const texts = ops.filter((o) => o.type === "add_text");
  assert.ok(texts.some((t) => /^https:\/\/www\.reddit\.com\/r\/\w+\/search\//.test(t.text)), "search url is on the board as text");
  assert.ok(ops.some((o) => o.type === "update" && /^https:\/\//.test(o.props.url)), "card carries a link");
  assert.ok(texts.some((t) => t.text.includes("{{EVIDENCE}}")), "drafts keep their evidence slot");
});

test("honest framing: header says recipes are unverified, mock plans are labelled, empty shortlist is explicit", () => {
  const texts = ops.filter((o) => o.type === "add_text").map((o) => o.text).join("\n");
  assert.match(texts, /Mock plan \(no model ran\)/);
  assert.match(texts, /not leads/);
  assert.match(texts, /No live leads yet/);
});

test("live leads become blue cards with their url as text and as a link", () => {
  const withLead = structuredClone(doc);
  withLead.shortlist.leads = [{ id: "lead-1", handle: "r/startups", platform: "reddit", url: "https://www.reddit.com/r/startups/comments/abc/x", title: "Someone asks for a launch studio", whyTheyFit: "Asks", intentSignal: "Explicit", outreachId: "o-1", foundVia: { query: "q" }, backing: "search-result", status: "unreviewed", score: { total: 7, outOf: 8 } }];
  const o = leadsToOps(withLead, { originY: 0 });
  assert.ok(o.some((x) => x.type === "add_text" && x.text === "https://www.reddit.com/r/startups/comments/abc/x"));
  assert.ok(o.some((x) => x.type === "add_shape" && x.id === "ld-lead-lead-1" && x.color === "blue"));
  for (const op of o) OpSchema.parse(op);
  assert.ok(!o.some((x) => x.id === "ld-shortlist-template"));
});

test("steps: one card per step so --live animates; flat ops equal the concatenated steps", () => {
  const steps = leadsToSteps(doc);
  assert.ok(steps.length > 40);
  assert.deepEqual(steps.flat(), leadsToOps(doc));
});

test("stateBounds: extents from the op log, delete/clear/move honoured, ids include arrows", () => {
  const log = [
    { op: { type: "add_shape", id: "a", kind: "rectangle", x: 10, y: 20, w: 100, h: 50 } },
    { op: { type: "add_image", id: "img", src: "/x", x: 400, y: 100, w: 500 } },
    { op: { type: "add_arrow", id: "arr", from: "a", to: "img" } },
    { op: { type: "add_text", id: "t", x: 0, y: 900, text: "hi" } },
  ];
  const b = stateBounds(log);
  assert.equal(b.minX, 0);
  assert.equal(b.maxY, Math.max(900 + 140, 100 + 500 * 1.7));
  assert.deepEqual(b.ids.sort(), ["a", "arr", "img", "t"]);
  assert.equal(stateBounds([...log, { op: { type: "delete", id: "t" } }]).maxY, 100 + 500 * 1.7);
  assert.equal(stateBounds([...log, { op: { type: "clear" } }]), null);
  assert.equal(stateBounds([...log, { op: { type: "move", id: "a", x: 0, y: 5000 } }]).maxY, 5050);
  assert.equal(stateBounds([]), null);
});
