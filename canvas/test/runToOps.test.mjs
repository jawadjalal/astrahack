// Run: node --test canvas/test   (Node >= 22.18 strips the TS types in runToOps.ts natively)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runToOps, mapSeverity } from "../src/lib/runToOps.ts";

const fx = (n) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)), "utf8"));
const report = fx("run-report.json");
const analysis = fx("qa-analysis.json");

const SIZES = { "screenshots/003-Checkout-assertText.png": { w: 1280, h: 720 } };
const srcMap = Object.fromEntries(
  ["screenshots/001-Checkout-goto.png", "screenshots/002-Checkout-click.png", "screenshots/003-Checkout-assertText.png",
   "screenshots/004-Pricing-goto.png", "screenshots/005-Pricing-observe.png", "video/Checkout.webm"].map((p) => [p, `/up/${p.split("/").pop()}`]),
);
const ops = runToOps(report, { srcMap, sizes: SIZES });
const of = (t) => ops.filter((o) => o.type === t);

test("one add_image per step screenshot, ids step-N, src from srcMap, label is the step description", () => {
  const imgs = of("add_image");
  assert.deepEqual(imgs.map((o) => o.id), ["step-1", "step-2", "step-3", "step-4", "step-5"]);
  assert.deepEqual(imgs.map((o) => o.step), [1, 2, 3, 4, 5]);
  assert.equal(imgs[0].src, "/up/001-Checkout-goto.png");
  assert.equal(imgs[0].label, "goto /");
  assert.equal(imgs[1].label, "click a.add-to-cart");
  assert.equal(imgs[2].label, 'assertText "Order total" (failed)');
  // step 6 has no screenshot and the initial view is not a step: neither invents an image
  assert.equal(imgs.length, 5);
});

test("flow is left-to-right per journey with arrows between consecutive steps", () => {
  const img = Object.fromEntries(of("add_image").map((o) => [o.id, o]));
  assert.ok(img["step-1"].x < img["step-2"].x && img["step-2"].x < img["step-3"].x);
  assert.equal(img["step-1"].y, img["step-3"].y);
  assert.ok(img["step-4"].y > img["step-1"].y, "second journey sits on its own row");
  assert.deepEqual(of("add_arrow").map((o) => [o.from, o.to]), [["step-1", "step-2"], ["step-2", "step-3"], ["step-4", "step-5"]]);
  // 16:9 size is honoured from opts.sizes
  assert.equal(img["step-3"].h, Math.round(520 * 720 / 1280));
});

test("annotate boxes are fractions, from bundle regions only", () => {
  const ann = of("annotate");
  const s1 = ann.find((o) => o.target === "step-1");
  assert.deepEqual(s1.box, { x: 0.1, y: 0.2, w: 0.5, h: 0.1 });
  assert.equal(s1.label, "Hero headline");
  assert.equal(s1.severity, "info");
  const f = ann.find((o) => o.target === "step-3");
  assert.deepEqual(f.box, { x: 0.5, y: 0.5, w: 0.25, h: 0.25 }); // 640,360,320x180 px on 1280x720
  assert.equal(f.severity, "high");
  for (const a of ann) for (const v of Object.values(a.box)) assert.ok(v >= 0 && v <= 1);
  // pixel region without a known image size is dropped, not guessed
  const noSize = runToOps(report, { srcMap }).filter((o) => o.type === "annotate");
  assert.equal(noSize.some((o) => o.target === "step-3"), false);
});

test("finding card sits below its step, targets the step image, severity mapped, verified from reproduction", () => {
  const [f] = of("add_finding");
  const step3 = of("add_image").find((o) => o.id === "step-3");
  assert.equal(f.target, "step-3");
  assert.equal(f.x, step3.x);
  assert.ok(f.y >= step3.y + step3.h, "below the screenshot");
  assert.equal(f.severity, "high");
  assert.equal(f.verified, true);
  assert.equal(f.title, "Cart shows no order total");
  assert.equal(f.expected, "The cart displays an order total");
  assert.equal(f.timestamp, 8.5); // observedAt - journey.startedAt, journey has a recording
});

test("video: one add_video for the recording, only when the bundle has one", () => {
  const v = of("add_video");
  assert.equal(v.length, 1);
  assert.equal(v[0].src, "/up/Checkout.webm");
  const noVideo = structuredClone(report);
  delete noVideo.journeys[0].video;
  noVideo.assets = noVideo.assets.filter((a) => a.type !== "video");
  assert.equal(runToOps(noVideo, { srcMap }).filter((o) => o.type === "add_video").length, 0);
  assert.equal(of("add_finding")[0].timestamp, 8.5);
  assert.equal(runToOps(noVideo, { srcMap }).find((o) => o.type === "add_finding").timestamp, undefined);
});

test("title note first, focus last, ids unique, every reference exists before use", () => {
  assert.equal(ops[0].type, "add_shape");
  assert.equal(ops[0].kind, "note");
  assert.match(ops[0].text, /Acme checkout walkthrough/);
  assert.match(ops[0].text, /5 steps/);
  const last = ops.at(-1);
  assert.equal(last.type, "focus");
  assert.ok(last.ids.includes("step-1") && last.ids.includes("video-1"));
  const ids = ops.map((o) => o.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
  const seen = new Set();
  for (const o of ops) {
    if (o.type === "add_arrow") assert.ok(seen.has(o.from) && seen.has(o.to), `arrow ${o.id}`);
    if (o.type === "annotate") assert.ok(seen.has(o.target), `annotate ${o.id}`);
    if (o.type === "add_finding" && o.target) assert.ok(seen.has(o.target), `finding ${o.id}`);
    if (o.id) seen.add(o.id);
  }
});

test("QA analysis findings: Q-refs attach to steps, verification and severity mapped, no id clashes", () => {
  const withAnalysis = runToOps(report, { srcMap, sizes: SIZES, analysis });
  const fs = withAnalysis.filter((o) => o.type === "add_finding");
  assert.equal(fs.length, 4); // 1 runner + 3 analysis
  const byTitle = Object.fromEntries(fs.map((f) => [f.title, f]));
  assert.equal(byTitle["Add-to-cart button does nothing"].target, "step-2");
  assert.equal(byTitle["Add-to-cart button does nothing"].verified, false); // agent_reported
  assert.equal(byTitle["Add-to-cart button does nothing"].severity, "critical");
  assert.equal(byTitle["Pricing Buy button leads nowhere"].verified, false); // hypothesis
  assert.equal(byTitle["Checkout 500s"].verified, true); // recorded
  assert.equal(byTitle["Checkout 500s"].severity, "critical"); // blocker
  assert.equal(byTitle["Checkout 500s"].target, undefined); // crawl evidence has no step image
  assert.equal(new Set(fs.map((f) => f.id)).size, 4);
});

test("agent / fleet bundle: steps[] grouped by worker, assessment issues become findings", () => {
  const agent = {
    target: "https://acme.test/", status: "completed",
    workers: [{ id: "A001", mission: "journey", status: "completed" }, { id: "A002", mission: "controls", status: "completed" }],
    steps: [
      { index: 1, type: "click", action: { type: "click", x: 10, y: 20 }, status: "passed", screenshot: "workers/A001/screenshots/001-click.png", workerId: "A001" },
      { index: 2, type: "type", action: { type: "type", text: "[redacted]" }, status: "blocked_or_failed", screenshot: "workers/A001/screenshots/002-type.png", workerId: "A001" },
      { index: 3, type: "scroll", action: { type: "scroll", x: 5, y: 5, scroll_y: 300 }, status: "passed", screenshot: "workers/A002/screenshots/001-scroll.png", workerId: "A002" },
    ],
    assessment: { issues: [{ summary: "Search ignored input", severity: "medium", expected: "Results", actual: "Nothing", reproduction: ["Type a query", "Press Enter"], evidenceStep: 2, evidence: "workers/A001/screenshots/002-type.png", verification: "agent_reported" }] },
  };
  const o = runToOps(agent);
  const imgs = o.filter((x) => x.type === "add_image");
  assert.deepEqual(imgs.map((i) => i.label), ["click (10, 20)", 'type "[redacted]" (blocked)', "scroll (5, 5) down"]);
  assert.equal(imgs[0].src, "workers/A001/screenshots/001-click.png"); // no srcMap: path passes through
  assert.equal(imgs[2].y > imgs[0].y, true);
  const f = o.find((x) => x.type === "add_finding");
  assert.equal(f.target, "step-2");
  assert.equal(f.verified, false);
  assert.equal(o.filter((x) => x.type === "add_arrow").length, 1);
});

test("crawl and analyst evidence attach C/CF findings without duplicating crawler checks", () => {
  const crawl = {
    target: "https://acme.test/", pages: [
      { url: "https://acme.test/", screenshot: "screenshots/crawl-home.png" },
      { url: "https://acme.test/pricing", screenshot: "screenshots/crawl-pricing.png" },
    ], findings: [{ type: "http_error", actual: "HTTP 500", evidence: "screenshots/crawl-pricing.png" }],
  };
  const agent = { target: "https://acme.test/", steps: [{ index: 1, workerId: "A001", type: "click", status: "passed", screenshot: "workers/A001/click.png" }] };
  const qa = { evidence: [
    { id: "C001", screenshot: "screenshots/crawl-home.png" },
    { id: "CF001", screenshot: "screenshots/crawl-pricing.png" },
    { id: "Q001", screenshot: "workers/A001/click.png" },
  ], findings: [
    { id: "QA-001", summary: "HTTP 500", severity: "high", expected: "Pricing loads", actual: "Server error", reproduction: ["Open /pricing"], evidenceRefs: ["CF001"], verification: "recorded" },
    { id: "QA-002", summary: "Get started link goes nowhere", severity: "low", expected: "Sign up opens", actual: "The page does not change", reproduction: ["Open home", "Click Get started"], evidenceRefs: ["C001"], verification: "hypothesis" },
    { id: "QA-003", summary: "Button did nothing", severity: "medium", expected: "A panel opens", actual: "No response", evidenceRefs: ["Q001"], verification: "agent_reported", reproduction: ["Open home", "Click button"] },
  ] };
  const converted = runToOps({ report: agent, crawl, analysis: qa });
  const images = converted.filter((o) => o.type === "add_image");
  assert.deepEqual(images.map((o) => o.id), ["crawl-1", "crawl-2", "step-1"]);
  const findings = Object.fromEntries(converted.filter((o) => o.type === "add_finding").map((o) => [o.title, o]));
  assert.equal(findings["HTTP 500"].target, "crawl-2");
  assert.equal(findings["HTTP 500"].verified, true);
  assert.match(findings["HTTP 500"].actual, /Evidence: CF001/);
  assert.equal(findings["Get started link goes nowhere"].target, "crawl-1");
  assert.equal(findings["Button did nothing"].target, "step-1");
  assert.match(findings["Button did nothing"].actual, /Reproduce: Open home → Click button/);
  const crawlOnly = runToOps({ report: crawl, crawl, analysis: qa });
  assert.equal(crawlOnly.filter((o) => o.type === "add_finding").length, 3);
});

test("single layout puts every step on one row with arrows across journeys", () => {
  const o = runToOps(report, { srcMap, layout: "single" });
  const imgs = o.filter((x) => x.type === "add_image");
  assert.equal(new Set(imgs.map((i) => i.y)).size, 1);
  assert.equal(o.filter((x) => x.type === "add_arrow").length, 4);
});

test("mapSeverity", () => {
  assert.deepEqual(["critical", "major", "Medium", "minor", "note", "weird", undefined].map(mapSeverity),
    ["critical", "high", "medium", "low", "info", "medium", "medium"]);
});

test("empty / foreign input does not throw", () => {
  const o = runToOps({});
  assert.equal(o[0].id, "run-title");
  assert.equal(o.at(-1).type, "focus");
});

// ---- functional-only findings --------------------------------------------------------------------------
const design = (over = {}) => ({ id: "D1", severity: "high", summary: "Hero font looks dated", expected: "Modern type", actual: "Looks dated", reproduction: ["Open home"], evidenceRefs: ["Q002"], verification: "agent_reported", ...over });
const withAnalysis = (findings, opts = {}) => runToOps(report, { srcMap, analysis: { findings }, ...opts }).filter((o) => o.type === "add_finding");

test("design opinions never become finding cards by default", () => {
  const dropped = [];
  const fs = withAnalysis(
    [design(), design({ id: "D2", summary: "Possibly unclear pricing CTA", expected: "A clear action", actual: "Ambiguous wording" }),
     design({ id: "D3", category: "visual", summary: "Checkout does nothing", actual: "Nothing happens" })],
    { onExcluded: (x) => dropped.push(...x) },
  );
  assert.deepEqual(fs.map((f) => f.title), ["Cart shows no order total"], "only the runner's functional finding remains");
  assert.equal(dropped.length, 3);
  assert.match(dropped[0].reasons[0], /design or taste opinion/);
  assert.equal(dropped[2].category, "visual");
});

test("findings without steps, evidence, or expected and actual are dropped", () => {
  const fs = withAnalysis([
    design({ id: "F1", summary: "Add to cart does nothing", actual: "No effect" }),
    design({ id: "F2", summary: "Checkout fails", actual: "An error", reproduction: [] }),
    design({ id: "F3", summary: "Search fails", actual: "An error", evidenceRefs: [] }),
    design({ id: "F4", summary: "Login fails", actual: "", expected: "" }),
  ]);
  assert.deepEqual(fs.map((f) => f.title).sort(), ["Add to cart does nothing", "Cart shows no order total"]);
});

test("--include-design keeps design findings, prefixed and at severity info", () => {
  const fs = withAnalysis([design({ category: "visual" }), design({ id: "D2", category: "usability", severity: "critical", summary: "Confusing flow wording", actual: "Wording is vague" })], { includeDesign: true });
  const byTitle = Object.fromEntries(fs.map((f) => [f.title, f]));
  assert.equal(byTitle["[visual] Hero font looks dated"].severity, "info");
  assert.equal(byTitle["[usability] Confusing flow wording"].severity, "info");
  assert.equal(byTitle["Cart shows no order total"].severity, "high");
});

test("a scripted runner failure keeps its category even when the observed text mentions design words", () => {
  const r = structuredClone(report);
  r.findings[0].actual = 'Expected page text "Order total"; observed "Choose a color and font. We recommend the large size."';
  assert.equal(runToOps(r, { srcMap }).filter((o) => o.type === "add_finding").length, 1);
  r.findings[0].category = "visual";
  assert.equal(runToOps(r, { srcMap }).filter((o) => o.type === "add_finding").length, 0);
  assert.equal(runToOps(r, { srcMap, includeDesign: true }).filter((o) => o.type === "add_finding").length, 1);
});
