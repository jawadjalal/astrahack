#!/usr/bin/env node
// Seeds a polished, believable demo teardown onto the canvas without the live agent.
// Backup for stage: the board looks like a finished agent run.
//
//   node scripts/seed-demo.mjs [--canvas URL] [--live] [--no-clear] [--dry-run]
//
// Every sample finding is FUNCTIONAL (observable broken behavior, see scripts/demo-findings.mjs); the script
// refuses to post one that the findings filter would drop.
//
//   --canvas URL   canvas base URL (default $CANVAS_URL or http://localhost:3000).
//                  Base-path aware: https://ignura.com/astrahack works (API = URL + /api/...).
//   --live         post one op at a time with ~500ms delays so the canvas builds visibly.
//   --no-clear     do not wipe the board first.
//   --dry-run      print the ops as JSON, post nothing.
//
// The mock client app ("Fernly", a plant-care app) is drawn here as SVG data URLs, so no
// uploads or network assets are needed except the sample video URL.

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (flag("help") || flag("h")) {
  console.log("usage: node scripts/seed-demo.mjs [--canvas URL] [--live] [--no-clear] [--dry-run]");
  process.exit(0);
}

import { assessFinding } from "../src/lib/findings-filter.mjs";
import { DEMO_FINDINGS } from "./demo-findings.mjs";

const CANVAS_URL = (opt("canvas") || process.env.CANVAS_URL || "http://localhost:3000").replace(/\/+$/, "");
const LIVE = flag("live");
const DELAY_MS = 500;
const VIDEO_URL = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

// ---------------------------------------------------------------------------------------
// SVG mock screens: 390 x 844, consumer-app styling
// ---------------------------------------------------------------------------------------
const W = 390;
const H = 844;
const FONT = "-apple-system, 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const C = {
  bg: "#f7f4ec",
  ink: "#1d2b24",
  mute: "#6b7a70",
  green: "#2f6b4a",
  green2: "#3f8a60",
  leaf: "#5fae7e",
  leaf2: "#86c79f",
  pale: "#e3efe5",
  line: "#e3ded1",
  white: "#ffffff",
  amber: "#f2b84b",
  red: "#d9534f",
  dark: "#16352a",
  clay: "#c8744a",
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const text = (x, y, s, { size = 16, weight = 400, fill = C.ink, anchor = "start", opacity = 1 } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" opacity="${opacity}">${esc(s)}</text>`;

const lines = (x, y, arr, lh, opts) => arr.map((s, i) => text(x, y + i * lh, s, opts)).join("");

const rect = (x, y, w, h, { r = 0, fill = "none", stroke = "none", sw = 1, opacity = 1 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"/>`;

const circle = (cx, cy, r, fill, extra = "") => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" ${extra}/>`;

const button = (x, y, w, h, label, { fill = C.green, color = C.white, r = 16, size = 17, stroke = "none" } = {}) =>
  rect(x, y, w, h, { r, fill, stroke, sw: 1.5 }) + text(x + w / 2, y + h / 2 + size * 0.35, label, { size, weight: 600, fill: color, anchor: "middle" });

const statusBar = (fill = C.ink) =>
  text(32, 34, "9:41", { size: 15, weight: 600, fill }) +
  rect(318, 24, 4, 8, { r: 1, fill }) + rect(324, 21, 4, 11, { r: 1, fill }) + rect(330, 18, 4, 14, { r: 1, fill }) +
  rect(342, 20, 24, 12, { r: 3.5, stroke: fill, sw: 1.2, opacity: 0.9 }) + rect(344.5, 22.5, 16, 7, { r: 2, fill });

const leafPath = (len) =>
  `M0 0 C ${len * 0.3} ${-len * 0.25}, ${len * 0.32} ${-len * 0.75}, 0 ${-len} C ${-len * 0.32} ${-len * 0.75}, ${-len * 0.3} ${-len * 0.25}, 0 0 Z`;
const leaf = (x, y, rot, len, fill) =>
  `<g transform="translate(${x} ${y}) rotate(${rot})"><path d="${leafPath(len)}" fill="${fill}"/><path d="M0 -4 L0 ${-len * 0.88}" stroke="#ffffff" stroke-opacity=".35" stroke-width="2" stroke-linecap="round"/></g>`;

// A potted plant. (cx, by) is the bottom-centre of the pot; s scales everything.
const plant = (cx, by, s, { leaves = true, pot = C.clay, tone = [C.leaf, C.green2, C.leaf2] } = {}) => {
  const top = by - 56 * s;
  let g = "";
  if (leaves) {
    const spec = [[-62, 80, 1], [62, 80, 1], [-34, 110, 0], [34, 110, 0], [0, 128, 2], [-82, 60, 2], [82, 60, 2]];
    for (const [rot, len, t] of spec) g += leaf(cx, top + 4 * s, rot, len * s, tone[t]);
  }
  g += `<path d="M${cx - 34 * s} ${top} L${cx + 34 * s} ${top} L${cx + 26 * s} ${by} L${cx - 26 * s} ${by} Z" fill="${pot}"/>`;
  g += rect(cx - 38 * s, top - 8 * s, 76 * s, 14 * s, { r: 5 * s, fill: pot });
  g += rect(cx - 38 * s, top - 8 * s, 76 * s, 5 * s, { r: 3 * s, fill: "#ffffff", opacity: 0.18 });
  return g;
};

const tabBar = (active, badge) => {
  const tabs = ["Home", "Garden", "Scan", "Settings"];
  const cx = (i) => 48.75 + i * 97.5;
  let g = rect(0, 764, W, 80, { fill: C.white }) + `<line x1="0" y1="764.5" x2="${W}" y2="764.5" stroke="${C.line}"/>`;
  tabs.forEach((name, i) => {
    const on = name === active;
    const col = on ? C.green : "#98a39b";
    const x = cx(i);
    if (name === "Home") g += `<path d="M${x - 11} 790 L${x} 779 L${x + 11} 790 V801 H${x - 11} Z" fill="${col}"/>`;
    if (name === "Garden") g += `<g transform="translate(${x} 802)">${`<path d="${leafPath(26)}" fill="${col}"/>`}</g>`;
    if (name === "Scan") g += rect(x - 11, 780, 22, 22, { r: 6, stroke: col, sw: 2.4 }) + circle(x, 791, 4, col);
    if (name === "Settings") g += circle(x, 791, 11, "none", `stroke="${col}" stroke-width="2.6"`) + circle(x, 791, 3.5, col);
    g += text(x, 825, name, { size: 11, weight: on ? 600 : 500, fill: col, anchor: "middle" });
  });
  if (badge) g += circle(cx(0) + 17, 778, 10, C.red) + text(cx(0) + 17, 782.2, String(badge), { size: 12, weight: 700, fill: C.white, anchor: "middle" });
  g += rect(135, 833, 120, 5, { r: 2.5, fill: C.ink, opacity: 0.85 }); // home indicator
  return g;
};

const wrap = (body, bg = C.bg, defs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">` +
  `<defs>${defs}<clipPath id="r"><rect width="${W}" height="${H}" rx="38"/></clipPath></defs>` +
  `<g clip-path="url(#r)">${rect(0, 0, W, H, { fill: bg })}${body}</g>` +
  `<rect x=".75" y=".75" width="${W - 1.5}" height="${H - 1.5}" rx="38" fill="none" stroke="#1d2b24" stroke-opacity=".18" stroke-width="1.5"/></svg>`;

const dataUrl = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");

// Pixel rect on a screen -> annotate box (fractions of the image)
const frac = (x, y, w, h) => ({ x: +(x / W).toFixed(4), y: +(y / H).toFixed(4), w: +(w / W).toFixed(4), h: +(h / H).toFixed(4) });

// Rects shared between the drawing code and the annotations
const R = {
  signupCta: [24, 484, 342, 56],
  paywallClose: [326, 52, 48, 48],
  homeBanner: [24, 152, 342, 104],
  homeBadge: [52, 760, 40, 36],
  reminderTime: [24, 356, 342, 56],
  addPlant: [324, 72, 44, 44],
};

// 1. Onboarding
const screenOnboarding = () => {
  const bg = `<linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9ecde"/><stop offset="1" stop-color="${C.bg}"/></linearGradient>`;
  return wrap(
    rect(0, 0, W, 560, { fill: "url(#g1)" }) +
      circle(195, 290, 150, "#ffffff", 'opacity=".55"') +
      circle(78, 150, 26, "#ffffff", 'opacity=".5"') + circle(330, 210, 16, "#ffffff", 'opacity=".5"') +
      plant(195, 420, 1.75) +
      statusBar() +
      text(354, 84, "Skip", { size: 15, weight: 500, fill: C.mute, anchor: "end" }) +
      text(195, 510, "Keep every plant", { size: 31, weight: 700, anchor: "middle" }) +
      text(195, 548, "alive and thriving.", { size: 31, weight: 700, fill: C.green, anchor: "middle" }) +
      lines(195, 586, ["Watering reminders, light checks and", "care tips for your whole jungle."], 23, { size: 16, fill: C.mute, anchor: "middle" }) +
      rect(171, 640, 28, 8, { r: 4, fill: C.green }) + circle(213, 644, 4, "#cfd8d1") + circle(229, 644, 4, "#cfd8d1") +
      button(24, 686, 342, 58, "Get started") +
      text(195, 786, "I already have an account", { size: 15, weight: 600, fill: C.green, anchor: "middle" }),
    C.bg,
    bg,
  );
};

// 2. Sign up
const screenSignup = () => {
  const check = (y, label) => circle(36, y - 5, 8, C.green2) + `<path d="M32 ${y - 5} l3 3 l5 -6" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` + text(52, y, label, { size: 13.5, fill: C.green });
  return wrap(
    statusBar() +
      `<path d="M34 74 L24 84 L34 94" stroke="${C.ink}" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
      text(24, 152, "Create your account", { size: 29, weight: 700 }) +
      text(24, 182, "It takes less than a minute.", { size: 15.5, fill: C.mute }) +
      text(26, 232, "Email", { size: 13, weight: 600, fill: C.mute }) +
      rect(24, 242, 342, 54, { r: 14, fill: C.white, stroke: C.line, sw: 1.5 }) +
      text(42, 275, "maya.ortiz@gmail.com", { size: 16.5 }) +
      text(26, 326, "Password", { size: 13, weight: 600, fill: C.mute }) +
      rect(24, 336, 342, 54, { r: 14, fill: C.white, stroke: C.green2, sw: 2 }) +
      text(42, 371, "••••••••••", { size: 20, weight: 700 }) +
      text(348, 369, "Show", { size: 13.5, weight: 600, fill: C.green, anchor: "end" }) +
      check(420, "8+ characters") + check(444, "At least 1 number") +
      // a normal, enabled CTA: the bug is behavioural (the first tap is ignored), not how it looks
      button(R.signupCta[0], R.signupCta[1], R.signupCta[2], R.signupCta[3], "Create account") +
      `<line x1="24" y1="568" x2="168" y2="568" stroke="${C.line}"/><line x1="222" y1="568" x2="366" y2="568" stroke="${C.line}"/>` +
      text(195, 573, "or", { size: 13.5, fill: C.mute, anchor: "middle" }) +
      button(24, 596, 342, 54, "Continue with Apple", { fill: "#111", color: "#fff", r: 14, size: 16 }) +
      button(24, 662, 342, 54, "Continue with Google", { fill: C.white, color: C.ink, r: 14, size: 16, stroke: C.line }) +
      lines(195, 770, ["By continuing you agree to our Terms", "and Privacy Policy."], 18, { size: 12, fill: C.mute, anchor: "middle" }) +
      rect(135, 833, 120, 5, { r: 2.5, fill: C.ink, opacity: 0.85 }),
  );
};

// 3. Paywall
const screenPaywall = () => {
  const bg = `<linearGradient id="g3" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e4a38"/><stop offset="1" stop-color="${C.dark}"/></linearGradient>`;
  const perk = (y, s) => circle(42, y - 5, 10, C.leaf) + `<path d="M37 ${y - 5} l3.5 3.5 l6 -7" stroke="${C.dark}" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` + text(64, y, s, { size: 15.5, fill: "#fff" });
  return wrap(
    rect(0, 0, W, H, { fill: "url(#g3)" }) +
      circle(195, 190, 110, "#ffffff", 'opacity=".06"') +
      plant(195, 262, 1.05, { tone: [C.leaf, C.leaf2, "#a9dcbb"] }) +
      statusBar("#fff") +
      // the tiny, low-contrast close button
      text(350, 80, "×", { size: 15, weight: 300, fill: "#ffffff", opacity: 0.28, anchor: "middle" }) +
      text(195, 336, "Unlock Fernly Plus", { size: 28, weight: 700, fill: "#fff", anchor: "middle" }) +
      text(195, 364, "Never lose a plant again.", { size: 15.5, fill: "#fff", opacity: 0.7, anchor: "middle" }) +
      perk(412, "Unlimited plants") + perk(446, "Plant doctor: diagnose from a photo") + perk(480, "Smart light and weather reminders") +
      // yearly (selected)
      rect(24, 512, 342, 80, { r: 18, fill: "#ffffff", opacity: 0.1, stroke: C.leaf, sw: 2 }) +
      circle(52, 552, 10, C.leaf) + circle(52, 552, 4.5, C.dark) +
      text(76, 546, "Yearly", { size: 17, weight: 700, fill: "#fff" }) +
      text(76, 568, "7-day free trial", { size: 13, fill: C.leaf2 }) +
      text(346, 556, "$5.00/mo", { size: 18, weight: 700, fill: "#fff", anchor: "end" }) +
      rect(272, 500, 88, 22, { r: 11, fill: C.amber }) + text(316, 515, "BEST VALUE", { size: 10.5, weight: 800, fill: C.dark, anchor: "middle" }) +
      // monthly
      rect(24, 604, 342, 64, { r: 18, stroke: "#ffffff", sw: 1.5, opacity: 0.25 }) +
      circle(52, 636, 10, "none", 'stroke="#ffffff" stroke-opacity=".4" stroke-width="2"') +
      text(76, 641, "Monthly", { size: 17, weight: 600, fill: "#fff", opacity: 0.85 }) +
      text(346, 641, "$9.99/mo", { size: 16, weight: 600, fill: "#fff", opacity: 0.7, anchor: "end" }) +
      button(24, 682, 342, 56, "Start free trial", { fill: C.amber, color: C.dark, r: 18, size: 18 }) +
      text(195, 756, "After the trial, $59.99 is billed yearly. Renews automatically.", { size: 9, fill: "#fff", opacity: 0.32, anchor: "middle" }) +
      text(195, 800, "Restore purchases", { size: 11.5, fill: "#fff", opacity: 0.5, anchor: "middle" }) +
      rect(135, 833, 120, 5, { r: 2.5, fill: "#fff", opacity: 0.7 }),
    C.dark,
    bg,
  );
};

// 4. Home
const screenHome = () => {
  const card = (y, name, meta, due) =>
    rect(24, y, 342, 84, { r: 20, fill: C.white, stroke: C.line, sw: 1 }) +
    rect(38, y + 14, 56, 56, { r: 16, fill: C.pale }) + plant(66, y + 66, 0.34, {}) +
    text(108, y + 38, name, { size: 16.5, weight: 650 }) +
    text(108, y + 59, meta, { size: 12.5, fill: C.mute }) +
    (due
      ? rect(278, y + 26, 74, 32, { r: 16, fill: C.green }) + text(315, y + 47, "Water", { size: 13.5, weight: 600, fill: "#fff", anchor: "middle" })
      : rect(278, y + 26, 74, 32, { r: 16, fill: C.pale }) + text(315, y + 47, "Thu", { size: 13.5, weight: 600, fill: C.green, anchor: "middle" }));
  return wrap(
    statusBar() +
      text(24, 104, "Good morning, Maya", { size: 25, weight: 700 }) +
      text(24, 128, "Tuesday, 6 October", { size: 14, fill: C.mute }) +
      circle(346, 100, 22, C.leaf) + text(346, 107, "M", { size: 19, weight: 700, fill: "#fff", anchor: "middle" }) +
      rect(24, 152, 342, 104, { r: 22, fill: C.green }) +
      circle(318, 204, 40, "#ffffff", 'opacity=".09"') +
      `<path d="M318 180 C 334 200, 336 214, 318 226 C 300 214, 302 200, 318 180 Z" fill="#fff" opacity=".9"/>` +
      text(44, 196, "3 plants need water", { size: 21, weight: 700, fill: "#fff" }) +
      text(44, 224, "Monstera, Fiddle leaf fig, Snake plant", { size: 13, fill: "#fff", opacity: 0.8 }) +
      text(24, 296, "Today", { size: 19, weight: 700 }) +
      card(312, "Monstera", "Every 7 days · Living room", true) +
      card(406, "Fiddle leaf fig", "Every 5 days · Bedroom", true) +
      card(500, "Snake plant", "Every 12 days · Hallway", true) +
      text(24, 626, "Coming up", { size: 19, weight: 700 }) +
      card(642, "Rosemary", "Every 4 days · Kitchen", false) +
      tabBar("Home", 5),
  );
};

// 5. Settings
const screenSettings = () => {
  const toggle = (x, y, on) => rect(x, y, 48, 28, { r: 14, fill: on ? C.green2 : "#cfd6d1" }) + circle(on ? x + 34 : x + 14, y + 14, 11, "#fff");
  const row = (y, label, right, { tog, last, pill, color } = {}) =>
    text(42, y + 34, label, { size: 16, fill: color || C.ink }) +
    (tog !== undefined ? toggle(318 - 18, y + 14, tog) : "") +
    (pill ? rect(280, y + 13, 66, 30, { r: 15, fill: C.amber }) + text(313, y + 33, pill, { size: 13, weight: 700, fill: C.dark, anchor: "middle" }) : "") +
    (right ? text(346, y + 34, right, { size: 15, fill: C.mute, anchor: "end" }) : "") +
    (last ? "" : `<line x1="42" y1="${y + 56}" x2="348" y2="${y + 56}" stroke="${C.line}"/>`);
  const group = (y, label, n) => text(30, y - 10, label.toUpperCase(), { size: 11.5, weight: 700, fill: C.mute }) + rect(24, y, 342, n * 56, { r: 20, fill: C.white, stroke: C.line, sw: 1 });
  return wrap(
    statusBar() +
      text(24, 104, "Settings", { size: 29, weight: 700 }) +
      group(152, "Account", 2) + row(152, "Profile", "Maya Ortiz") + row(208, "Plan", "", { last: true, pill: "Upgrade" }) +
      text(342, 242, "Free", { size: 15, fill: C.mute, anchor: "end" }).replace('x="342"', 'x="266"') +
      group(300, "Reminders", 3) + row(300, "Water reminders", "", { tog: true }) + row(356, "Reminder time", "8:00 AM") + row(412, "Weather-aware", "", { tog: true, last: true }) +
      group(504, "Support", 3) + row(504, "Help center", "›") + row(560, "Send feedback", "›") + row(616, "Log out", "", { last: true, color: C.red }) +
      text(195, 722, "Fernly 2.14.0 (381)", { size: 12.5, fill: C.mute, anchor: "middle" }) +
      tabBar("Settings"),
  );
};

// 6. Empty state
const screenEmpty = () =>
  wrap(
    statusBar() +
      text(24, 104, "My garden", { size: 29, weight: 700 }) +
      circle(346, 94, 18, "none", `stroke="${C.line}" stroke-width="1.5"`) +
      `<path d="M346 86 v16 M338 94 h16" stroke="${C.mute}" stroke-width="2" stroke-linecap="round"/>` +
      circle(195, 330, 130, C.pale, 'opacity=".6"') + circle(195, 330, 92, "#ffffff", 'opacity=".6"') +
      plant(195, 392, 1.6, { leaves: false, pot: "#d9c9b8" }) +
      `<path d="M160 280 q 35 -30 70 0" stroke="${C.leaf}" stroke-width="3" fill="none" stroke-dasharray="5 7" stroke-linecap="round"/>` +
      text(195, 510, "Nothing growing yet", { size: 23, weight: 700, anchor: "middle" }) +
      lines(195, 542, ["Plants you add will show up here", "with their care schedule."], 23, { size: 15.5, fill: C.mute, anchor: "middle" }) +
      tabBar("Garden"),
  );

// ---------------------------------------------------------------------------------------
// Layout (canvas pixels)
// ---------------------------------------------------------------------------------------
const PITCH = 690; // screen spacing (390 wide + 300 gap for labelled arrows)
const SX = (i) => i * PITCH;
const FY = 980; // findings row

const screens = [
  { id: "s1-onboarding", label: "Onboarding", svg: screenOnboarding() },
  { id: "s2-signup", label: "Sign up", svg: screenSignup() },
  { id: "s3-paywall", label: "Paywall", svg: screenPaywall() },
  { id: "s4-home", label: "Home", svg: screenHome() },
  { id: "s5-settings", label: "Settings", svg: screenSettings() },
  { id: "s6-empty", label: "Empty garden", svg: screenEmpty() },
];

const flowLabels = ["tap Get started", "tap Create account (2nd tap)", "relaunch app (x did nothing)", "tap Settings", "fresh account"];

const ops = [];
const add = (op, group) => ops.push({ op, group });

// 1. title + legend
add({ type: "add_shape", id: "title", kind: "text", x: 0, y: -640, text: "Fernly teardown: install to first plant" });
add({ type: "update", id: "title", props: { size: "xl" } });
add({ type: "add_shape", id: "subtitle", kind: "text", x: 0, y: -552, text: "iOS, test account. Observed, reproduced, explained, ranked." });
add({ type: "update", id: "subtitle", props: { size: "m", color: "grey" } });
add({ type: "add_shape", id: "legend", kind: "note", x: 0, y: -470, w: 220, h: 220, color: "yellow", text: "Verified = reproduced twice.\n\nUnverified = seen once, needs a second run.\n\nOnly functional issues: broken behavior, not taste." });

// 2. screens left-to-right, with labelled arrows
screens.forEach((s, i) => {
  add({ type: "add_image", id: s.id, src: dataUrl(s.svg), x: SX(i), y: 0, w: W, h: H, label: s.label, step: i + 1 });
  if (i > 0) add({ type: "add_arrow", id: `flow-${i}`, from: screens[i - 1].id, to: s.id, label: flowLabels[i - 1], color: "blue" });
});

// 3. run recording
add({ type: "add_video", id: "run-video", src: VIDEO_URL, x: 1100, y: -520, w: 640, h: 360, label: "Run recording: full session" });

// 4. problem spots (fractions of the screen), one per finding
add({ type: "annotate", id: "ann-paywall-close", target: "s3-paywall", box: frac(...R.paywallClose), label: "Close: no response", severity: "critical" });
add({ type: "annotate", id: "ann-signup-cta", target: "s2-signup", box: frac(...R.signupCta), label: "First tap ignored", severity: "high" });
add({ type: "annotate", id: "ann-home-banner", target: "s4-home", box: frac(...R.homeBanner), label: "Still says 3 after watering", severity: "high" });
add({ type: "annotate", id: "ann-settings-time", target: "s5-settings", box: frac(...R.reminderTime), label: "Reverts to 8:00 AM", severity: "medium" });
add({ type: "annotate", id: "ann-home-badge", target: "s4-home", box: frac(...R.homeBadge), label: "Badge says 5", severity: "medium" });
add({ type: "annotate", id: "ann-empty-plus", target: "s6-empty", box: frac(...R.addPlant), label: "+ does nothing", severity: "medium" });

// 5. findings, ranked #1..#6, each linked to its screen. Content lives in demo-findings.mjs.
// x offsets: one card under its screen; two cards under the same screen sit either side of it.
const cardX = (f) => {
  const same = DEMO_FINDINGS.filter((g) => g.screen === f.screen);
  const slot = same.indexOf(f);
  return same.length === 1 ? SX(f.screen) + 15 : SX(f.screen) + (slot === 0 ? -175 : 225);
};
for (const f of DEMO_FINDINGS) {
  // the sample board must obey its own rule: functional, with steps, expected vs actual and evidence
  const verdict = assessFinding({ ...f, category: "functional", summary: f.title, evidenceStep: f.screen + 1 });
  if (!verdict.keep) throw new Error(`demo finding ${f.id} is not a functional finding: ${verdict.reasons.join("; ")}`);
  add({
    type: "add_finding", id: f.id, x: cardX(f), y: FY, severity: f.severity, verified: f.verified, target: screens[f.screen].id, timestamp: f.timestamp,
    title: `#${f.rank} ${f.title}`, expected: f.expected, actual: f.actual,
  });
}

// 6. summary of what to fix first
add({
  type: "add_shape", id: "summary", kind: "rectangle", x: 280, y: -470, w: 700, h: 300, color: "orange",
  text: "Fix first\n1. Paywall: make the close button work\n2. Sign up: act on the first tap\n3. Home: update the reminder count after watering\n4. Settings: save the reminder time\n5. Home: fix the badge count (verify)\n6. Garden: make + open Add plant (verify)",
});

// 7. the board, framed
add({ type: "focus" });

// ---------------------------------------------------------------------------------------
// Post
// ---------------------------------------------------------------------------------------
const api = (p) => `${CANVAS_URL}${p}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body) {
  let res;
  try {
    res = await fetch(api("/api/ops"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    console.error(`Cannot reach the canvas at ${CANVAS_URL} (${e.cause?.code || e.message}).`);
    console.error("Start it with: cd canvas && PORT=3000 npm run dev   (or pass --canvas URL)");
    process.exit(1);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    console.error(`POST /api/ops failed (${res.status}):`, JSON.stringify(data).slice(0, 800));
    process.exit(1);
  }
  return data;
}

async function main() {
  if (flag("dry-run")) {
    console.log(JSON.stringify(ops.map((o) => o.op), null, 2));
    return;
  }
  console.log(`Seeding ${CANVAS_URL} (${ops.length} ops${LIVE ? ", live" : ""})`);
  if (!flag("no-clear")) await post({ type: "clear" });
  if (!LIVE) {
    await post(ops.map((o) => o.op));
  } else {
    // images + arrows give the canvas time to load; the rest is paced the same way
    for (const { op } of ops) {
      await post(op);
      await sleep(op.type === "update" ? 0 : DELAY_MS);
    }
  }
  console.log("Done. Open the canvas; Present mode is the Present button in the toolbar (Shift+P).");
}

main();
