// Run: node --test canvas/test   (Node >= 22.18 strips the TS types in kitToOps.ts / ops.ts natively)
//
// Fixtures are generated here, not checked in: the ad PNGs come out of the repo's real generator
// (lib/generate.mjs) fed by a mocked Gemini response, the campaigns out of lib/campaigns.mjs the same way,
// and the UGC plan is hand-built to the ugc/schema.js contract and grounded in ugc/fixtures/ignura.
//
//   KIT_FIXTURES_DIR=/tmp/kit node canvas/test/kit.test.mjs     writes the fixtures there and prints the push-kit command
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { deflateSync, crc32 } from "node:zlib";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { generateCreatives, planCreatives } from "../../lib/generate.mjs";
import { generateCampaigns, campaignSchema } from "../../lib/campaigns.mjs";
import { checkGrounding } from "../../ugc/schema.js";
import {
  kitToOps, kitToOpsDetailed, detectSayOp, stateBounds, stateElements, liveIds, originBelow, isKitId, artDirection, defaultStepIdFor,
} from "../src/lib/kitToOps.ts";

// The contract checks and the MCP test need canvas/node_modules (zod, the MCP SDK, tsx). The root `npm test` may run
// without them: then those parts skip with a reason instead of failing the whole file.
const optional = async (spec) => { try { return await import(spec); } catch (e) { if (e?.code === "ERR_MODULE_NOT_FOUND") return null; throw e; } };
const opsModule = await optional("../src/lib/ops.ts");
const sdkClient = await optional("@modelcontextprotocol/sdk/client/index.js");
const sdkStdio = await optional("@modelcontextprotocol/sdk/client/stdio.js");
const OpSchema = opsModule?.OpSchema ?? null;
const NO_CONTRACT = OpSchema ? false : "canvas deps not installed (cd canvas && npm i): ops.ts needs zod";
const NO_MCP = OpSchema && sdkClient && sdkStdio ? false : "canvas deps not installed (cd canvas && npm i)";

const here = dirname(fileURLToPath(import.meta.url));
const canvasDir = join(here, "..");
const repoRoot = join(here, "../..");
const teardownDir = join(repoRoot, "ugc/fixtures/ignura");

// ---------------------------------------------------------------- fixture generation

/** minimal PNG encoder: pixel(x, y) -> [r, g, b] */
function encodePng(w, h, pixel) {
  const raw = Buffer.alloc((1 + 3 * w) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (1 + 3 * w);
    raw[o] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o + 1 + 3 * x] = r; raw[o + 2 + 3 * x] = g; raw[o + 3 + 3 * x] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const DIGITS = {
  1: ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  2: [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  3: [".###.", "#...#", "....#", "..##.", "....#", "#...#", ".###."],
  4: ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  5: ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
};
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const PALETTE = [["#1f6f50", "#2f9a73"], ["#5b3aa5", "#8a62d8"], ["#c8651e", "#f09a52"], ["#235b9a", "#4a8fd6"], ["#a82e4c", "#dc5d7b"]];

/** solid-colour placeholder ad: banded gradient, an inset panel and the ad number as a block digit */
function placeholderAd(n) {
  const [c0, c1] = PALETTE[(n - 1) % PALETTE.length].map(hex);
  const glyph = DIGITS[n] ?? DIGITS[1];
  const S = 70, gx = (1024 - 5 * S) / 2, gy = (1024 - 7 * S) / 2;
  return encodePng(1024, 1024, (x, y) => {
    const gcx = Math.floor((x - gx) / S), gcy = Math.floor((y - gy) / S);
    if (gcx >= 0 && gcx < 5 && gcy >= 0 && gcy < 7 && glyph[gcy][gcx] === "#") return [255, 255, 255];
    if (x > 96 && x < 928 && y > 96 && y < 928) return c1;
    const band = Math.floor(y / 64) / 15; // 16 flat bands compress to almost nothing
    return c0.map((v, i) => Math.round(v * (1 - 0.35 * band) + 20 * band + 0 * i));
  });
}

const IGNURA_BRIEF =
  "Ignura is a launch studio for consumer apps, prosumer tools and B2B. You bring the product; we do design, launch film, UGC, go-to-market and launch day. " +
  "A launch runs four weeks: teardown and plan, polish and page, film and UGC, launch day. Free teardown available. Audience: founders about to launch. CTA: Get the free teardown.";

const geminiImageResponse = (png) => Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }] } }] });

async function makeAds(dir) {
  const plan = planCreatives(IGNURA_BRIEF);
  const { runDir, manifest } = await generateCreatives({
    provider: "gemini", prompt: IGNURA_BRIEF, outputDir: dir, apiKey: "test-key",
    fetchImpl: async (_url, init) => {
      const sent = JSON.parse(init.body).contents[0].parts[0].text;
      return geminiImageResponse(placeholderAd(plan.findIndex((p) => p.prompt === sent) + 1));
    },
  });
  assert.equal(manifest.status, "complete");
  return runDir;
}

// real-looking drafts for the Ignura fixture; every claim restates what the teardown observed (four-week plan, free teardown, UGC, launch film)
function campaignContent(channel) {
  const fill = (schema) => {
    if (schema.type === "string") return "Placeholder to be edited before use";
    if (schema.type === "integer") return 1;
    if (schema.type === "array") return Array.from({ length: schema.minItems }, () => fill(schema.items));
    return Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, fill(v)]));
  };
  const c = fill(campaignSchema(channel));
  c.calendar.forEach((d, i) => { d.day = i + 1; });
  if (channel === "x") {
    Object.assign(c, { title: "Ignura on X: the four-week launch", objective: "Get founders who are about to launch to ask for the free teardown." });
    const posts = [
      ["Problem-led", "You built the thing. Now what? Most launches stall because nobody planned week one. Ignura runs a four-week launch, start to lift-off. Free teardown first: [LINK]"],
      ["Educational", "The shape of an Ignura launch: 1 Teardown + plan. 2 Polish, shots, page. 3 Film + UGC. 4 Launch day. Four weeks, one board. [LINK]"],
      ["Product", "The free teardown: we walk your app like a first-time user and tell you what a stranger would tap and where they would bounce. [LINK]"],
      ["Discussion", "Founders: what is the one thing you wish you had fixed before launch day? Reply and we will tell you how we would look at it."],
      ["Educational", "Content that does not look like ads. That is the brief we give UGC creators for app launches. [LINK]"],
      ["Product", "A launch film does not have to be long. Ours runs 52 seconds. See how we structure one: [LINK]"],
      ["Problem-led", "Launching soon? Book a free call and bring the app. We will show you what the first week should look like. [LINK]"],
    ];
    posts.forEach(([angle, copy], i) => Object.assign(c.posts[i], { id: `x-${i + 1}`, angle, title: angle, copy, cta: "Get the free teardown" }));
    c.thread = [
      "We built Ignura because launches keep dying in week one. Here is the four-week plan we run for apps. A thread.",
      "Week 1: the teardown and the plan. We use the app like a stranger would and write down what we find. It is free.",
      "Week 2: polish. App Store screenshots, the landing page, the shots we will need for the film.",
      "Week 3: the launch film and the UGC shoot. UGC that opens like a post, not an ad.",
      "Week 4: line it up, then launch. X, TikTok and Product Hunt, hour by hour.",
      "Want the teardown for your app? It is free. [LINK]",
    ];
  } else {
    Object.assign(c, { title: "Ignura on Reddit: useful first, product second", objective: "Earn trust in founder communities and answer launch questions honestly." });
    const posts = [
      ["What I check in every app teardown before a launch", "I work at Ignura, a launch studio, so take this with that in mind. Before an app launches we walk it like a first-time user: does the first screen say what it does, would a stranger tap the main button, is the pricing clear. Most of the problems are in the first 30 seconds, not in the features. Here is the checklist we use for the first-run screens, in order. I am happy to look at your onboarding if you want a second pair of eyes; no pitch, just notes."],
      ["How we structure a four-week launch for a consumer app", "Disclosure: I am on the team at Ignura. We plan launches in four weeks: week one teardown and plan, week two polish and page, week three film and UGC, week four launch day. The part founders skip is week one. Without a plan the rest turns into guessing. Curious how others here sequence theirs, and what you would move earlier or later."],
      ["UGC for apps: what to put in a creator brief", "Full disclosure: I work for a launch studio that makes UGC for apps. The brief matters more than the creator. Say what the viewer should see in the first two seconds, which screens to show, and what the one claim is. Then let the creator say it in their own words. Content that does not look like ads travels further. What has worked for you?"],
    ];
    posts.forEach(([title, copy], i) => Object.assign(c.posts[i], { id: `reddit-${i + 1}`, title, copy, angle: "Honest and useful", audience: "Founders about to launch an app" }));
  }
  c.calendar.forEach((d, i) => { d.contentId = c.posts[i % c.posts.length].id; });
  return c;
}

async function makeCampaigns(dir) {
  const { runDir, manifest } = await generateCampaigns({
    prompt: IGNURA_BRIEF, apiKey: "test-key", outputDir: dir,
    fetchImpl: async (_u, init) => {
      const channel = /organic X GTM/.test(JSON.parse(init.body).contents[0].parts[0].text) ? "x" : "reddit";
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(campaignContent(channel)) }] } }] });
    },
  });
  assert.equal(manifest.status, "complete");
  return runDir;
}

// ugc-plan.json to the ugc/schema.js contract, grounded in ugc/fixtures/ignura/report.json (evidence = its screenshots)
export function ugcPlanFixture() {
  const S = (n, name) => `screenshots/${String(n).padStart(3, "0")}-${name}.png`;
  const hero = S(1, "Homepage-hero-goto"), work = S(4, "Browse-the-work-by-type-goto"), menu = S(11, "Explore-the-service-menu-click"), plan = S(15, "How-a-launch-works-and-pricing-goto"), faq = S(22, "Read-the-FAQ-click");
  return {
    schemaVersion: 1, kind: "astrahack.ugc-plan", generatedAt: "2026-10-06T18:00:00.000Z",
    source: { report: "ugc/fixtures/ignura/report.json", target: "https://ignura.com/", runName: "Ignura first-visit walkthrough" }, model: "mock",
    product: {
      name: "Ignura", oneLiner: "A launch studio for consumer apps, prosumer tools and B2B.", category: "Launch studio", whoItsFor: "Founders about to launch an app",
      observedFeatures: [
        { id: "F1", name: "Free teardown", whatItDoes: "A free review of your app before you commit to anything.", evidence: [menu] },
        { id: "F2", name: "Four-week launch plan", whatItDoes: "Teardown + plan, polish and page, film + UGC, launch day.", evidence: [plan] },
        { id: "F3", name: "UGC that opens like a post", whatItDoes: "Creator videos briefed to not look like ads.", evidence: [work] },
      ],
      frictionFromQa: [],
    },
    audiences: [{ id: "A1", name: "Pre-launch founder", pain: "No plan for launch week", desire: "A launch that does not stall", platforms: ["tiktok", "x", "instagram-reels"] }],
    angles: [
      { id: "ANG1", name: "You built the thing", insight: "Building is done; launching is the part nobody planned.", audienceId: "A1", featureIds: ["F2"], whyItWorks: "Names the exact moment of dread." },
      { id: "ANG2", name: "Free first look", insight: "A free teardown removes the risk of asking for help.", audienceId: "A1", featureIds: ["F1"], whyItWorks: "Zero-commitment entry point." },
      { id: "ANG3", name: "Not an ad", insight: "Creator content that opens like a post gets watched.", audienceId: "A1", featureIds: ["F3"], whyItWorks: "Shows the product by being the product." },
    ],
    creators: [
      { id: "C1", archetype: "Overwhelmed solo founder", profile: "25-35, indie hacker, 5-20k followers", whyThem: "Lives the problem", audienceId: "A1" },
      { id: "C2", archetype: "Design-minded builder", profile: "22-30, shares build-in-public clips", whyThem: "Credible on screenshots and polish", audienceId: "A1" },
    ],
    hooks: [
      { id: "H1", angleId: "ANG1", text: "You built the thing. Now what?", format: "talking-head", visualOpener: "Creator at a desk, laptop open on their finished app" },
      { id: "H2", angleId: "ANG2", text: "A free teardown of your app, before launch", format: "screen-recording-voiceover", visualOpener: "Screen recording scrolling the Ignura service menu" },
      { id: "H3", angleId: "ANG3", text: "This does not look like an ad. It is one.", format: "problem-solution", visualOpener: "A phone feed; the post opens like a normal creator video" },
      { id: "H4", angleId: "ANG1", text: "Four weeks from app to launch day", format: "listicle", visualOpener: "Four-step plan on screen, one step lighting up per second" },
      { id: "H5", angleId: "ANG2", text: "Would a stranger tap your first screen?", format: "pov", visualOpener: "POV of a stranger thumb hovering over an onboarding screen" },
      { id: "H6", angleId: "ANG3", text: "Do UGC videos actually get views?", format: "reaction", visualOpener: "Creator reads the FAQ question aloud" },
    ],
    scripts: [
      {
        id: "S1", title: "You built the thing", angleId: "ANG1", hookId: "H1", creatorId: "C1", platform: "tiktok", format: "talking-head", durationSec: 30,
        beats: [
          { t: "0-3s", voiceover: "You built the thing. Now what?", onScreenText: "You built the thing.", shot: "Medium close-up, handheld", assetRef: hero },
          { t: "3-12s", voiceover: "Most launches stall in week one because nobody planned it.", onScreenText: "Week one is where launches stall", shot: "Cut to the plan on screen", assetRef: plan },
          { t: "12-25s", voiceover: "Ignura runs it in four weeks: teardown, polish, film and UGC, launch day.", onScreenText: "4 weeks, 1 board", shot: "Screen recording of the four steps", assetRef: plan },
          { t: "25-30s", voiceover: "Start with the free teardown.", onScreenText: "Free teardown. Link in bio.", shot: "Back to the creator", assetRef: null },
        ],
        cta: "Get the free teardown, link in bio", featureIds: ["F2", "F1"],
      },
      {
        id: "S2", title: "Free teardown walkthrough", angleId: "ANG2", hookId: "H2", creatorId: "C2", platform: "instagram-reels", format: "screen-recording-voiceover", durationSec: 25,
        beats: [
          { t: "0-3s", voiceover: "A free teardown of your app, before launch.", onScreenText: "Free teardown", shot: "Screen recording, service menu", assetRef: menu },
          { t: "3-18s", voiceover: "We walk your app like a first-time user and write down what we find.", onScreenText: "First-time-user walkthrough", shot: "Cursor moves through the menu", assetRef: menu },
          { t: "18-25s", voiceover: "It is free. Ask for it.", onScreenText: "Ask for the teardown", shot: "Hold on the page", assetRef: null },
        ],
        cta: "Ask for the free teardown", featureIds: ["F1"],
      },
      {
        id: "S3", title: "Not an ad", angleId: "ANG3", hookId: "H3", creatorId: "C2", platform: "tiktok", format: "problem-solution", durationSec: 28,
        beats: [
          { t: "0-3s", voiceover: "This does not look like an ad. It is one.", onScreenText: "This is an ad", shot: "Feed-style opening", assetRef: null },
          { t: "3-20s", voiceover: "UGC that opens like a post gets watched. That is how we brief creators.", onScreenText: "Opens like a post", shot: "Show the work page", assetRef: work },
          { t: "20-28s", voiceover: "See what we have made so far.", onScreenText: "See the work", shot: "Scroll the work page", assetRef: work },
        ],
        cta: "Look at the work, link in bio", featureIds: ["F3"],
      },
      {
        id: "S4", title: "Four weeks listicle", angleId: "ANG1", hookId: "H4", creatorId: "C1", platform: "youtube-shorts", format: "listicle", durationSec: 35,
        beats: [
          { t: "0-3s", voiceover: "Four weeks from app to launch day.", onScreenText: "4 weeks", shot: "Title card", assetRef: null },
          { t: "3-30s", voiceover: "One: teardown and plan. Two: polish, shots, page. Three: film and UGC. Four: launch day.", onScreenText: "1 Teardown + plan  2 Polish  3 Film + UGC  4 Launch day", shot: "Each step highlights in turn", assetRef: plan },
          { t: "30-35s", voiceover: "That is the whole shape of it.", onScreenText: "Free teardown first", shot: "Wrap", assetRef: null },
        ],
        cta: "Start with the free teardown", featureIds: ["F2"],
      },
      {
        id: "S5", title: "FAQ reaction", angleId: "ANG3", hookId: "H6", creatorId: "C1", platform: "x", format: "reaction", durationSec: 20,
        beats: [
          { t: "0-3s", voiceover: "Do UGC videos actually get views?", onScreenText: "Real question from the FAQ", shot: "Creator reads it aloud", assetRef: faq },
          { t: "3-20s", voiceover: "Here is how Ignura answers it on its own site.", onScreenText: "Read the FAQ", shot: "Screen recording of the FAQ", assetRef: faq },
        ],
        cta: "Read the FAQ", featureIds: ["F3"],
      },
    ],
    creatorBrief: { mustShow: ["The product screen being discussed"], dos: ["Say it in your own words"], donts: ["Do not promise results"], deliverables: ["One vertical video per script"], disclosure: "#ad / Paid partnership label" },
    campaign: {
      goal: "Founders ask for the free teardown",
      phases: [{ name: "Test", days: "Days 1-7", objective: "Find the hook that holds", actions: ["Post S1 to S3"] }],
      calendar: [{ day: 1, platform: "tiktok", scriptId: "S1", note: "Lead with the founder hook" }],
      kpis: [{ metric: "Teardown requests", target: "Proposed target: to be set", why: "The one action we want" }],
      budgetNote: "To be decided",
    },
    proposals: ["View-count claims are not evidenced by the teardown"],
  };
}

export async function makeKitFixtures(dir) {
  await mkdir(dir, { recursive: true });
  const adsDir = await makeAds(join(dir, "artifacts"));
  const campaignsDir = await makeCampaigns(join(dir, "artifacts"));
  const plan = ugcPlanFixture();
  assert.deepEqual(checkGrounding(plan), [], "the UGC fixture must satisfy the grounding contract");
  const ugcPath = join(dir, "ugc-plan.json");
  await writeFile(ugcPath, JSON.stringify(plan, null, 2) + "\n");
  return { adsDir, campaignsDir, ugcPath, plan };
}

async function loadKit(f) {
  const manifest = JSON.parse(await readFile(join(f.adsDir, "manifest.json"), "utf8"));
  const x = JSON.parse(await readFile(join(f.campaignsDir, "x-campaign.json"), "utf8"));
  const reddit = JSON.parse(await readFile(join(f.campaignsDir, "reddit-campaign.json"), "utf8"));
  return { ads: manifest, campaigns: { x, reddit }, ugcPlan: f.plan };
}

// ---------------------------------------------------------------- shared fixtures for the suite

let tmp, fx, kit;
test.before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "kit-test-"));
  fx = await makeKitFixtures(tmp);
  kit = await loadKit(fx);
});
test.after(async () => { if (tmp) await rm(tmp, { recursive: true, force: true }); });

const STEPS = Array.from({ length: 36 }, (_, i) => `step-${i + 1}`);
const srcMap = () => Object.fromEntries(kit.ads.creatives.map((c) => [c.filename, `/uploads/${c.filename}`]));
const validOps = (ops) => OpSchema && ops.forEach((o, i) => assert.ok(OpSchema.safeParse(o).success, `op #${i} ${JSON.stringify(o).slice(0, 120)} must satisfy ops.ts`));
const byId = (ops) => Object.fromEntries(ops.filter((o) => o.id && !o.type.startsWith("update")).map((o) => [o.id, o])); // the add_*, not its follow-up style update
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ---------------------------------------------------------------- fixtures themselves

test("fixtures: the repo generators produce a complete five-ad manifest, real 1024x1024 PNGs, and both campaigns", async () => {
  assert.equal(kit.ads.status, "complete");
  assert.equal(kit.ads.creatives.length, 5);
  const files = await readdir(fx.adsDir);
  assert.equal(files.filter((f) => f.endsWith(".png")).length, 5);
  const png = await readFile(join(fx.adsDir, kit.ads.creatives[0].filename));
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  assert.equal(kit.campaigns.x.posts.length, 7);
  assert.ok(kit.campaigns.x.thread.length >= 5);
  assert.equal(kit.campaigns.reddit.posts.length, 3);
});

// ---------------------------------------------------------------- kitToOps

test("ads lane: five add_image ops ids ad-1..5, hosted src, captioned with the manifest's art direction", () => {
  const ops = kitToOps({ ads: kit.ads }, { srcMap: srcMap() });
  validOps(ops);
  const imgs = ops.filter((o) => o.type === "add_image");
  assert.deepEqual(imgs.map((o) => o.id), ["ad-1", "ad-2", "ad-3", "ad-4", "ad-5"]);
  assert.equal(imgs[0].src, "/uploads/01-hero.png");
  assert.match(imgs[0].label, /^Ad 1 · hero$/);
  assert.ok(imgs.every((o) => o.w === 400 && o.h === 400), "square ads stay square");
  const caps = byId(ops);
  for (const c of kit.ads.creatives) {
    const dir = artDirection(c);
    assert.ok(dir.length > 40, "art direction is parsed out of the manifest prompt");
    assert.ok(!dir.includes("REQUIREMENTS"), "only the art direction, not the rest of the prompt");
    assert.ok(caps[`ad-${c.index}-direction`].text.includes(dir), `ad-${c.index} caption carries its art direction verbatim`);
  }
  assert.ok(imgs.every((o, i) => i === 0 || o.x > imgs[i - 1].x && o.y === imgs[0].y), "one row, left to right");
});

test("ads without an image (dry run / failed) keep their id as a labelled card; no picture is faked", () => {
  const dry = JSON.parse(JSON.stringify(kit.ads));
  dry.creatives[2].status = "failed"; dry.creatives[2].error = "Google quota or rate limit reached.";
  const ops = kitToOps({ ads: dry }, { srcMap: { [dry.creatives[0].filename]: "/uploads/a.png" } });
  validOps(ops);
  assert.equal(ops.filter((o) => o.type === "add_image").length, 1);
  const b = byId(ops);
  assert.equal(b["ad-1"].type, "add_image");
  assert.equal(b["ad-2"].type, "add_shape");
  assert.match(b["ad-2"].text, /not generated yet/);
  assert.match(b["ad-3"].text, /generation failed: Google quota/);
});

test("GTM lane: X posts, the thread (chained) and Reddit drafts are cards with a platform chip, copy verbatim", () => {
  const ops = kitToOps({ campaigns: kit.campaigns });
  validOps(ops);
  const b = byId(ops);
  const x = Object.keys(b).filter((id) => /^gtm-x-x-\d$/.test(id));
  assert.equal(x.length, 7);
  const t = Object.keys(b).filter((id) => /^gtm-x-thread-\d$/.test(id));
  assert.equal(t.length, kit.campaigns.x.thread.length);
  const r = Object.keys(b).filter((id) => /^gtm-reddit-reddit-\d$/.test(id));
  assert.equal(r.length, 3);
  kit.campaigns.x.posts.forEach((p, i) => {
    assert.match(b[`gtm-x-x-${i + 1}`].text, /^X {2}· {2}POST \d of 7/);
    assert.ok(b[`gtm-x-x-${i + 1}`].text.includes(p.copy), "X copy is shown whole");
  });
  kit.campaigns.x.thread.forEach((part, i) => {
    assert.match(b[`gtm-x-thread-${i + 1}`].text, new RegExp(`^X {2}· {2}THREAD ${i + 1}/${t.length}`));
    assert.ok(b[`gtm-x-thread-${i + 1}`].text.includes(part));
  });
  r.forEach((id, i) => {
    assert.match(b[id].text, /^REDDIT {2}· {2}POST \d of 3/);
    assert.ok(b[id].text.includes(kit.campaigns.reddit.posts[i].title));
  });
  const arrows = ops.filter((o) => o.type === "add_arrow");
  assert.equal(arrows.length, t.length - 1, "thread parts are chained, nothing else is");
  assert.deepEqual(arrows.map((a) => [a.from, a.to]), t.slice(1).map((id, i) => [t[i], id]));
  // the card is a rectangle with its text left/top aligned through a follow-up update, same id
  const upd = ops.find((o) => o.type === "update" && o.id === "gtm-x-x-1");
  assert.equal(upd.props.align, "start");
  assert.equal(upd.props.verticalAlign, "start");
});

test("Reddit bodies are clipped on the card (default 700 chars) and the option widens it", () => {
  const long = JSON.parse(JSON.stringify(kit.campaigns));
  long.reddit.posts[0].copy = "word ".repeat(400).trim();
  const get = (o) => byId(kitToOps({ campaigns: long }, o))["gtm-reddit-reddit-1"].text;
  assert.ok(get({}).length < 900 && get({}).endsWith("…"));
  assert.ok(get({ redditBodyChars: 5000 }).length > 1900);
});

test("UGC lane: one card per script plus any hook no script uses; platform, format, hook and every beat shown", () => {
  const ops = kitToOps({ ugcPlan: kit.ugcPlan });
  validOps(ops);
  const b = byId(ops);
  const cards = Object.keys(b).filter((id) => /^ugc-/.test(id) && b[id].kind === "rectangle" && id !== "ugc-H5");
  assert.deepEqual(cards.sort(), ["ugc-S1", "ugc-S2", "ugc-S3", "ugc-S4", "ugc-S5"]);
  const s1 = kit.ugcPlan.scripts[0];
  const text = b["ugc-S1"].text;
  assert.match(text, /^TIKTOK {2}· {2}TALKING-HEAD {2}· {2}30s/);
  assert.ok(text.includes('HOOK: "You built the thing. Now what?"'));
  for (const beat of s1.beats) { assert.ok(text.includes(beat.t)); assert.ok(text.includes(beat.voiceover)); assert.ok(text.includes(beat.shot)); }
  assert.ok(text.includes(`CTA: ${s1.cta}`));
  assert.match(b["ugc-S2"].text, /INSTAGRAM REELS/);
  assert.ok(b["ugc-H5"], "an unused hook (H5) becomes its own card");
  assert.match(b["ugc-H5"].text, /Would a stranger tap your first screen\?/);
});

test("UGC arrows go to evidence step ids only when they exist on the canvas", () => {
  const without = kitToOps({ ugcPlan: kit.ugcPlan });
  assert.equal(without.filter((o) => o.type === "add_arrow").length, 0, "no stepIds given: nothing is claimed about the canvas");
  const none = kitToOps({ ugcPlan: kit.ugcPlan }, { stepIds: ["step-99"] });
  assert.equal(none.filter((o) => o.type === "add_arrow").length, 0);

  const ops = kitToOps({ ugcPlan: kit.ugcPlan }, { stepIds: STEPS });
  validOps(ops);
  const arrows = ops.filter((o) => o.type === "add_arrow");
  assert.ok(arrows.length >= 5);
  assert.ok(arrows.every((a) => a.from.startsWith("ugc-") && STEPS.includes(a.to)));
  // S1's beats point at 001 (hero) and 015 (plan); features F2/F1 add 015 (dup) and 011
  const s1 = arrows.filter((a) => a.from === "ugc-S1");
  assert.deepEqual(s1.map((a) => a.to), ["step-1", "step-15", "step-11"]);
  assert.ok(byId(ops)["ugc-S1"].text.endsWith("Evidence on the board: step-1, step-15, step-11"), "the card names the screenshots its arrows point at");
  assert.ok(arrows.every((a) => a.label === undefined), "no floating arrow labels over other cards");
  assert.ok(arrows.filter((a) => a.from === "ugc-S1").length <= 3, "capped per card");
  // only some steps exist: only those get arrows
  const some = kitToOps({ ugcPlan: kit.ugcPlan }, { stepIds: new Set(["step-15"]) }).filter((o) => o.type === "add_arrow");
  assert.ok(some.length && some.every((a) => a.to === "step-15"));
  // arrows after their cards, so the canvas can bind both ends
  const order = ops.map((o) => o.id);
  for (const a of arrows) assert.ok(order.indexOf(a.from) < order.indexOf(a.id));
  // custom path -> id mapping (a run whose files are not numbered)
  const custom = kitToOps({ ugcPlan: kit.ugcPlan }, { stepIds: ["hero"], stepIdFor: (p) => (p.includes("001-") ? "hero" : undefined) }).filter((o) => o.type === "add_arrow");
  assert.ok(custom.length && custom.every((a) => a.to === "hero"));
  assert.equal(defaultStepIdFor("screenshots/003-Homepage-hero-goto.png"), "step-3");
  assert.equal(defaultStepIdFor("screenshots/000-initial.png"), undefined);
});

test("lanes stack below the origin without touching, and never overlap each other or the teardown", () => {
  const origin = { x: 120, y: 3000 };
  const r = kitToOpsDetailed({ ...kit }, { origin, srcMap: srcMap(), stepIds: STEPS });
  validOps(r.ops);
  // arrows to the teardown exist, so the UGC lane sits nearest it; without arrows the order is ads, gtm, ugc
  assert.deepEqual(r.lanes.map((l) => l.key), ["ugc", "ads", "gtm"]);
  assert.deepEqual(kitToOpsDetailed({ ...kit }, { srcMap: srcMap() }).lanes.map((l) => l.key), ["ads", "gtm", "ugc"]);
  assert.deepEqual(r.counts, { ads: 5, xPosts: 7, xThread: kit.campaigns.x.thread.length, redditPosts: 3, ugc: 6, evidenceArrows: r.counts.evidenceArrows });
  for (let i = 1; i < r.lanes.length; i++) assert.ok(r.lanes[i].box.y >= r.lanes[i - 1].box.y + r.lanes[i - 1].box.h + 100, "gap between lane backdrops");
  assert.ok(r.lanes.every((l) => l.box.y >= origin.y), "nothing above the origin");
  assert.ok(r.bounds.x <= origin.x && r.bounds.y >= origin.y - 1);
  // every placed element sits inside its lane's backdrop (estimated heights are generous)
  const els = stateElements(r.ops);
  for (const lane of r.lanes) {
    for (const id of lane.ids) {
      const e = els.get(id);
      if (!e || id.endsWith("-panel")) continue;
      assert.ok(e.x >= lane.box.x && e.x + e.w <= lane.box.x + lane.box.w, `${id} inside ${lane.key} lane horizontally`);
      assert.ok(e.y >= lane.box.y && e.y + e.h <= lane.box.y + lane.box.h + 1, `${id} (y ${e.y}..${e.y + e.h}) inside ${lane.key} lane (${lane.box.y}..${lane.box.y + lane.box.h})`);
    }
  }
  // cards within one lane never overlap each other
  const cards = [...els.entries()].filter(([id]) => /^(gtm|ugc)-/.test(id) && !id.endsWith("title"));
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) assert.ok(!overlaps(cards[i][1], cards[j][1]), `${cards[i][0]} overlaps ${cards[j][0]}`);
  // ids are unique and carry the kit prefixes
  assert.equal(new Set(r.ids).size, r.ids.length);
  assert.ok(r.ids.every(isKitId));
  assert.ok(r.ops.filter((o) => o.id).every((o) => o.id.length <= 64));
  // the final focus covers the kit
  const focus = r.ops.at(-1);
  assert.equal(focus.type, "focus");
  assert.ok(focus.box.y >= origin.y - 1);
});

test("lane headers are clear: banner with counts, one title per lane, backdrop created before its content", () => {
  const ops = kitToOps({ ...kit }, { srcMap: srcMap() });
  const b = byId(ops);
  assert.match(b["kit-title"].text, /^LAUNCH KIT {2}· {2}Ignura$/);
  assert.match(b["kit-summary"].text, /5 ad concepts.*7 X posts \+ \d-part thread.*3 Reddit drafts.*6 UGC concepts/);
  assert.equal(b["kit-lane-ads-title"].text, "AD CONCEPTS");
  assert.equal(b["kit-lane-gtm-title"].text, "GTM POSTS");
  assert.equal(b["kit-lane-ugc-title"].text, "UGC CONCEPTS");
  const order = ops.map((o) => o.id);
  assert.ok(order.indexOf("kit-lane-ads-panel") < order.indexOf("ad-1"), "backdrop under the content");
  assert.ok(order.indexOf("kit-lane-gtm-panel") < order.indexOf("gtm-x-x-1"));
  // a lane with no input is simply absent
  const only = byId(kitToOps({ campaigns: { reddit: kit.campaigns.reddit } }));
  assert.ok(!only["kit-lane-ads-title"] && !only["kit-lane-ugc-title"] && only["kit-lane-gtm-title"]);
  assert.ok(!Object.keys(only).some((i) => i.startsWith("gtm-x-")));
  assert.deepEqual(kitToOps({}), []);
  assert.equal(kitToOps({ ads: kit.ads }, { banner: false }).some((o) => o.id === "kit-title"), false);
});

test("say caption: only emitted when the contract has the op (feature detection)", { skip: NO_CONTRACT }, () => {
  const noSay = { safeParse: () => ({ success: false }) };
  assert.equal(detectSayOp(noSay), null);
  assert.equal(detectSayOp(null), null);
  const hasSay = { safeParse: (v) => ({ success: v.type === "say" && typeof v.text === "string" }) };
  const make = detectSayOp(hasSay);
  assert.deepEqual(make("hi"), { type: "say", text: "hi" });
  const alt = detectSayOp({ safeParse: (v) => ({ success: v.type === "say" && typeof v.message === "string" }) });
  assert.deepEqual(alt("hi"), { type: "say", message: "hi" });

  const without = kitToOps({ ...kit }, { srcMap: srcMap() });
  assert.ok(!without.some((o) => o.type === "say"));
  const withSay = kitToOps({ ...kit }, { srcMap: srcMap(), say: make });
  const say = withSay.filter((o) => o.type === "say");
  assert.equal(say.length, 1);
  assert.match(say[0].text, /5 ad concepts/);
  assert.equal(withSay.at(-1).type, "focus", "say lands before the final focus");
  // this checkout's own contract: if ops.ts grows a say op the live detection must find it
  const live = detectSayOp(OpSchema);
  if (live) assert.ok(OpSchema.safeParse(live("x")).success);
  else assert.equal(OpSchema.safeParse({ type: "say", text: "x" }).success, false);
});

test("stateBounds / originBelow: the kit starts below the lowest existing element, aligned to the content's left edge", () => {
  const ops = [
    { seq: 1, ts: 0, op: { type: "add_image", id: "step-1", src: "/a.png", x: 0, y: 0, w: 520, h: 325 } },
    { seq: 2, ts: 0, op: { type: "add_image", id: "step-2", src: "/b.png", x: 660, y: 0, w: 520, h: 325 } },
    { seq: 3, ts: 0, op: { type: "add_finding", id: "finding-1", x: 0, y: 415, title: "Short", severity: "high", verified: false } },
    { seq: 4, ts: 0, op: { type: "add_shape", id: "run-title", kind: "note", x: 0, y: -400, text: "t" } },
    { seq: 5, ts: 0, op: { type: "add_arrow", id: "arrow-2", from: "step-1", to: "step-2" } },
  ];
  const { box, ids } = stateBounds(ops);
  assert.equal(box.x, 0);
  assert.equal(box.y, -400);
  assert.ok(box.y + box.h >= 415 + 100, "the finding card counts");
  assert.deepEqual([...ids].sort(), ["finding-1", "run-title", "step-1", "step-2"]);
  const o = originBelow(box);
  assert.equal(o.x, 0);
  assert.ok(o.y >= box.y + box.h + 200);
  assert.deepEqual(originBelow(null), { x: 0, y: 0 });
  // deletes and clear are replayed
  assert.deepEqual([...stateBounds([...ops, { op: { type: "delete", id: "finding-1" } }]).ids].sort(), ["run-title", "step-1", "step-2"]);
  assert.equal(stateBounds([...ops, { op: { type: "clear" } }]).box, null);
  assert.deepEqual([...liveIds(ops)].sort(), ["arrow-2", "finding-1", "run-title", "step-1", "step-2"]);
  assert.equal(stateBounds(ops, (id) => id.startsWith("step-")).box.y, -40, "image captions sit 40px above");
});

// ---------------------------------------------------------------- push-kit against a mock canvas

/** a throwaway canvas: validates every op against the real contract, serves a base path, mimics /api/upload */
function mockCanvas({ base = "" } = {}) {
  const log = []; let seq = 0, uploads = 0; const files = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const send = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (!req.url.startsWith(base + "/api/")) return send({ error: "outside the base path" }, 404);
      const url = req.url.slice(base.length);
      if (url === "/api/state" && req.method === "GET") return send({ seq, ops: log });
      if (url === "/api/state" && req.method === "DELETE") { log.length = 0; log.push({ seq: ++seq, ts: 0, op: { type: "clear" } }); return send({ ok: true }); }
      if (url === "/api/ops" && req.method === "POST") {
        const ops = [].concat(JSON.parse(body.toString()));
        for (const op of ops) {
          const r = OpSchema ? OpSchema.safeParse(op) : { success: true };
          if (!r.success) return send({ ok: false, error: `invalid op ${JSON.stringify(op).slice(0, 100)}: ${r.error.message.slice(0, 200)}` }, 400);
        }
        const seqs = ops.map((op) => { log.push({ seq: ++seq, ts: 0, op }); return seq; });
        return send({ ok: true, seqs, ids: ops.map((o) => o.id).filter(Boolean) });
      }
      if (url === "/api/upload" && req.method === "POST") {
        assert.match(String(req.headers["content-type"]), /multipart\/form-data/);
        files.push(body.length);
        return send({ url: `${base}/uploads/up-${++uploads}.png` });
      }
      send({ error: "not found" }, 404);
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, url: `http://127.0.0.1:${srv.address().port}${base}`, log, files, close: () => srv.close() })));
}

function run(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(canvasDir, "scripts/push-kit.mjs"), ...args], { env: { ...process.env, ...env }, cwd: repoRoot });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

const kitArgs = (f) => ["--ads", f.adsDir, "--campaigns", f.campaignsDir, "--ugc", f.ugcPath];

test("push-kit --dry-run prints valid ops offline (no canvas, no upload) and uses --run for evidence arrows", async () => {
  const r = await run([...kitArgs(fx), "--run", teardownDir, "--canvas", "http://127.0.0.1:1", "--dry-run"]);
  assert.equal(r.code, 0, r.err);
  const ops = JSON.parse(r.out);
  validOps(ops);
  assert.deepEqual(ops.filter((o) => o.type === "add_image").map((o) => o.id), ["ad-1", "ad-2", "ad-3", "ad-4", "ad-5"]);
  assert.match(ops.find((o) => o.id === "ad-1").src, /^\/uploads\/01-hero\.png$/);
  const arrows = ops.filter((o) => o.type === "add_arrow" && o.from.startsWith("ugc-"));
  assert.ok(arrows.length >= 5, "arrows to the teardown's step ids, from its report.json");
  assert.match(r.err, /dry run assumes an empty board/);
  assert.match(r.err, /5 ads, 7 X posts/);
  // subsets work: one input, one lane
  const ads = await run(["--ads", fx.adsDir, "--dry-run", "--canvas", "http://127.0.0.1:1"]);
  assert.equal(ads.code, 0, ads.err);
  assert.ok(JSON.parse(ads.out).some((o) => o.id === "kit-lane-ads-title") && !JSON.parse(ads.out).some((o) => o.id === "kit-lane-gtm-title"));
  // errors are plain
  const bad = await run(["--campaigns", join(tmp, "nope")]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /not found/);
  assert.equal((await run([])).code, 2);
  assert.equal((await run(["--origin", "x", ...kitArgs(fx), "--dry-run", "--canvas", "http://127.0.0.1:1"])).code, 1);
});

test("push-kit uploads the PNGs, posts valid ops under a base path, and starts below an existing teardown", async () => {
  const c = await mockCanvas({ base: "/astrahack" });
  try {
    // a teardown is already there: two screens and a finding, bottom edge at y=425+
    c.log.push(
      { seq: 1, ts: 0, op: { type: "add_image", id: "step-1", src: "/uploads/a.png", x: 0, y: 0, w: 520, h: 325 } },
      { seq: 2, ts: 0, op: { type: "add_image", id: "step-15", src: "/uploads/b.png", x: 660, y: 0, w: 520, h: 325 } },
      { seq: 3, ts: 0, op: { type: "add_finding", id: "finding-1", x: 0, y: 415, title: "Pricing page lacks a CTA", severity: "high", verified: true, target: "step-1" } },
    );
    const before = stateBounds(c.log).box;
    const r = await run([...kitArgs(fx), "--canvas", c.url]);
    assert.equal(r.code, 0, r.err);
    assert.equal(c.files.length, 5, "five ad PNGs uploaded through /api/upload");
    const posted = c.log.slice(3).map((e) => e.op);
    validOps(posted);
    const img = posted.filter((o) => o.type === "add_image");
    assert.equal(img.length, 5);
    assert.match(img[0].src, /^\/astrahack\/uploads\/up-1\.png$/, "the returned url (with base path) is used unchanged");
    // below the teardown, same left edge
    const origin = originBelow(before);
    const title = posted.find((o) => o.id === "kit-title");
    assert.equal(title.x, origin.x);
    assert.equal(title.y, origin.y);
    const kitBox = stateBounds(posted).box;
    assert.ok(kitBox.y >= before.y + before.h + 200, "clear of the teardown");
    // arrows to step-1 / step-15 which exist on this canvas, and only to those
    const arrows = posted.filter((o) => o.type === "add_arrow" && o.from.startsWith("ugc-"));
    assert.ok(arrows.length >= 3 && arrows.every((a) => ["step-1", "step-15"].includes(a.to)));
    assert.match(r.out, /posted \d+ ops/);

    // a second push is refused until --replace
    const again = await run([...kitArgs(fx), "--canvas", c.url]);
    assert.equal(again.code, 1);
    assert.match(again.err, /already on this canvas.*--replace/);
    // --replace deletes every earlier kit id (arrows included) and places a fresh one in the same spot
    const n0 = c.log.length;
    const rep = await run([...kitArgs(fx), "--canvas", c.url, "--replace"]);
    assert.equal(rep.code, 0, rep.err);
    const newOps = c.log.slice(n0).map((e) => e.op);
    const dels = newOps.filter((o) => o.type === "delete").map((o) => o.id);
    assert.ok(dels.includes("ad-1") && dels.includes("kit-title") && dels.some((i) => i.startsWith("kit-arrow-")));
    assert.ok(dels.every(isKitId), "teardown ids are never deleted");
    assert.equal(newOps.find((o) => o.id === "kit-title" && o.type === "add_shape").y, origin.y, "same place: the old kit no longer counts as content");
    assert.equal([...liveIds(c.log)].filter((i) => i === "ad-1").length, 1);
    // explicit origin wins
    await fetch(c.url + "/api/state", { method: "DELETE" });
    const o2 = await run(["--ads", fx.adsDir, "--canvas", c.url, "--origin", "500,-200"]);
    assert.equal(o2.code, 0, o2.err);
    assert.equal(c.log.find((e) => e.op.id === "kit-lane-ads-title" && e.op.type === "add_shape").op.x, 500);
  } finally { c.close(); }
});

test("push-kit rejects an unreachable canvas with how to start it", async () => {
  const r = await run(["--ads", fx.adsDir, "--canvas", "http://127.0.0.1:1"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /canvas not reachable.*npm run dev/);
});

// ---------------------------------------------------------------- MCP tools

test("MCP: canvas_push_ad_creatives, canvas_add_campaign_post, canvas_add_ugc_concept place cards below content and validate ids", { skip: NO_MCP }, async () => {
  const c = await mockCanvas();
  const client = new sdkClient.Client({ name: "kit-test", version: "0.0.0" });
  try {
    await client.connect(new sdkStdio.StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", join(canvasDir, "mcp/server.ts")], cwd: canvasDir, env: { ...process.env, CANVAS_URL: c.url }, stderr: "ignore",
    }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["canvas_push_ad_creatives", "canvas_add_campaign_post", "canvas_add_ugc_concept", "canvas_add_screenshot", "canvas_batch"]) assert.ok(names.includes(n), `missing ${n}`);
    const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { ...r, text: r.content.map((x) => x.text).join("\n") }; };
    c.log.push({ seq: 1, ts: 0, op: { type: "add_image", id: "step-3", src: "/uploads/s.png", x: 0, y: 0, w: 520, h: 325 } });
    c.log.push({ seq: 2, ts: 0, op: { type: "add_shape", id: "teardown-note", kind: "note", x: 700, y: 0, text: "x" } });

    const ads = await call("canvas_push_ad_creatives", { run_dir: fx.adsDir });
    assert.ok(!ads.isError, ads.text);
    assert.match(ads.text, /ids ad-1, ad-2, ad-3, ad-4, ad-5/);
    assert.equal(c.files.length, 5);
    const adOps = c.log.slice(2).map((e) => e.op);
    validOps(adOps);
    assert.deepEqual(adOps.filter((o) => o.type === "add_image").map((o) => o.id), ["ad-1", "ad-2", "ad-3", "ad-4", "ad-5"]);
    assert.ok(!adOps.some((o) => o.id === "kit-title"), "a single lane has no banner");
    assert.ok(adOps.find((o) => o.id === "kit-lane-ads-title").y >= 325 + 200, "below the teardown");
    const dup = await call("canvas_push_ad_creatives", { run_dir: fx.adsDir });
    assert.ok(dup.isError && /already on the canvas/.test(dup.text));
    const noInput = await call("canvas_push_ad_creatives", {});
    assert.ok(noInput.isError);

    const p1 = await call("canvas_add_campaign_post", { platform: "x", text: "You built the thing. Now what? [LINK]", angle: "Problem-led", label: "x-1" });
    assert.ok(!p1.isError, p1.text);
    const p2 = await call("canvas_add_campaign_post", { platform: "x", text: "Second post [LINK]", label: "x-2" });
    assert.ok(!p2.isError, p2.text);
    const r1 = await call("canvas_add_campaign_post", { platform: "reddit", title: "What I check in every teardown", text: "Disclosure: I work at Ignura. ...", label: "reddit-1" });
    assert.ok(!r1.isError, r1.text);
    const t1 = await call("canvas_add_campaign_post", { platform: "x", text: "Thread one", thread_part: 1, thread_total: 2 });
    const t2 = await call("canvas_add_campaign_post", { platform: "x", text: "Thread two", thread_part: 2, thread_total: 2 });
    assert.ok(!t1.isError && !t2.isError, t1.text + t2.text);
    const bad = await call("canvas_add_campaign_post", { platform: "reddit", text: "x", thread_part: 1 });
    assert.ok(bad.isError);
    const dupPost = await call("canvas_add_campaign_post", { platform: "x", text: "again", label: "x-1" });
    assert.ok(dupPost.isError && /already exists/.test(dupPost.text), "same label twice is refused, not silently ignored");
    const state = stateElements(c.log);
    const x1 = state.get("gtm-x-x-1"), x2 = state.get("gtm-x-x-2"), rd = state.get("gtm-reddit-reddit-1");
    assert.ok(x1 && x2 && rd);
    assert.ok(x2.x >= x1.x + x1.w && x2.y === x1.y, "second X card goes to the right of the first");
    assert.ok(rd.y >= x1.y + x1.h, "Reddit starts its own row below the X cards");
    assert.ok(x1.y >= 325 + 200, "GTM area is below the teardown");
    const arrows = c.log.map((e) => e.op).filter((o) => o.type === "add_arrow");
    assert.deepEqual(arrows.map((a) => [a.from, a.to]), [["gtm-x-thread-1", "gtm-x-thread-2"]]);

    const u1 = await call("canvas_add_ugc_concept", { id: "S1", platform: "tiktok", format: "talking-head", duration_sec: 30, title: "You built the thing", hook: "You built the thing. Now what?", beats: [{ t: "0-3s", voiceover: "You built the thing.", shot: "close-up", asset_ref: "step-3" }], cta: "Get the free teardown", evidence_ids: ["step-3"] });
    assert.ok(!u1.isError, u1.text);
    const u2 = await call("canvas_add_ugc_concept", { hook: "A free teardown of your app", platform: "instagram-reels" });
    assert.ok(!u2.isError, u2.text);
    const badEv = await call("canvas_add_ugc_concept", { hook: "x", evidence_ids: ["step-404"] });
    assert.ok(badEv.isError && /Unknown evidence id/.test(badEv.text));
    const ugcOps = c.log.map((e) => e.op).filter((o) => o.type === "add_arrow" && o.from === "ugc-S1");
    assert.equal(ugcOps.length, 1, "asset_ref and evidence_ids to the same step make one arrow");
    const st = stateElements(c.log);
    const s1 = st.get("ugc-S1"), s2 = [...st.entries()].find(([id]) => id.startsWith("ugc-A-free"))?.[1];
    assert.ok(s1 && s2 && s2.x > s1.x && s2.y === s1.y, "UGC cards fill a row left to right");
    validOps(c.log.map((e) => e.op));
  } finally {
    await client.close().catch(() => {});
    c.close();
  }
});

// ---------------------------------------------------------------- optional: write the fixtures where the demo can use them

if (process.env.KIT_FIXTURES_DIR) {
  const out = process.env.KIT_FIXTURES_DIR;
  const f = await makeKitFixtures(out);
  console.log(`# kit fixtures written to ${out}\n` +
    `node canvas/scripts/push-run.mjs ugc/fixtures/ignura --canvas http://localhost:3090\n` +
    `node canvas/scripts/push-kit.mjs --ads ${f.adsDir} --campaigns ${f.campaignsDir} --ugc ${f.ugcPath} --run ugc/fixtures/ignura --canvas http://localhost:3090`);
}
