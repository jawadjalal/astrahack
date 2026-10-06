// Run: node --test canvas/test   The seeded demo board must obey the same rule as every real run:
// only functional findings (observable broken behavior, with steps, expected vs actual, evidence).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEMO_FINDINGS } from "../scripts/demo-findings.mjs";
import { assessFinding, isFunctionalFinding, designMarkers } from "../src/lib/findings-filter.mjs";

const script = fileURLToPath(new URL("../scripts/seed-demo.mjs", import.meta.url));
const ops = JSON.parse(execFileSync(process.execPath, [script, "--dry-run"], { encoding: "utf8" }));
const cards = ops.filter((o) => o.type === "add_finding");

test("the demo board keeps its shape: 6 findings, 4 verified, 2 unverified", () => {
  assert.equal(cards.length, 6);
  assert.equal(cards.filter((c) => c.verified).length, 4);
  assert.equal(cards.filter((c) => !c.verified).length, 2);
  assert.equal(DEMO_FINDINGS.length, 6);
});

test("every demo finding is functional, with steps, expected vs actual and a screen", () => {
  for (const f of DEMO_FINDINGS) {
    const candidate = { ...f, category: "functional", summary: f.title, evidenceStep: f.screen + 1 };
    assert.equal(isFunctionalFinding(candidate), true, `${f.id}: ${assessFinding(candidate).reasons.join("; ")}`);
    assert.deepEqual(designMarkers(candidate), [], f.id);
    assert.ok(f.steps.length >= 2, `${f.id} has steps`);
    assert.ok(f.expected && f.actual, f.id);
  }
});

test("no sample card reads as a design opinion", () => {
  for (const c of cards) {
    const verdict = assessFinding({ summary: c.title, expected: c.expected, actual: c.actual, reproduction: ["x"], evidenceStep: 1 });
    assert.equal(verdict.category, "functional", c.title);
    assert.doesNotMatch(`${c.title} ${c.expected} ${c.actual}`, /\b(color|colour|font|spacing|looks?|prefer|consider|could be|opacity|contrast)\b/i, c.title);
  }
});

test("each finding links to a screen that exists and the board shows its problem spot", () => {
  const ids = new Set(ops.filter((o) => o.type === "add_image").map((o) => o.id));
  for (const c of cards) assert.ok(ids.has(c.target), `${c.id} targets ${c.target}`);
  const annotated = new Set(ops.filter((o) => o.type === "annotate").map((o) => o.target));
  for (const c of cards) assert.ok(annotated.has(c.target), `${c.target} has a highlight box`);
  // the three flagship bugs are on the board
  const titles = cards.map((c) => c.title).join("\n");
  assert.match(titles, /Sign up button ignores the first tap/);
  assert.match(titles, /Reminder count not updated/);
  assert.match(titles, /Paywall close button is unresponsive/);
});
