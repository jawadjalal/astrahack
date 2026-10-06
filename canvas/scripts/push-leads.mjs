#!/usr/bin/env node
// Push a lead-generation kit (leads.json from `npm run leads`) onto the live canvas as a "Leads" lane,
// laid out below whatever is already on the board.
//
//   node canvas/scripts/push-leads.mjs [--leads leads.json] [--canvas URL] [--live] [--replace] [--dry-run]
//
// Existing ops only: text, rectangles, arrows, update, say, focus. Nothing is uploaded.
// Canvas base: --canvas, else $CANVAS_URL, else http://localhost:3000. A base path is fine (https://ignura.com/astrahack).
// Re-running is safe: shape ids are stable, so the canvas ignores a lane that is already there.
// --replace deletes the earlier lane (ids starting "ld-") and redraws it below the other content.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// importing the .ts module straight from a package without "type": "module" makes Node warn once; it is harmless
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(rest[0]?.code ?? rest[1] ?? "").includes("MODULE_TYPELESS_PACKAGE_JSON") ? undefined : emit.call(process, w, ...rest));

function parseArgs(argv) {
  const a = { leads: "leads.json", canvas: undefined, live: false, replace: false, dry: false, delay: undefined };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--leads") a.leads = argv[++i];
    else if (t.startsWith("--leads=")) a.leads = t.slice(8);
    else if (t === "--canvas") a.canvas = argv[++i];
    else if (t.startsWith("--canvas=")) a.canvas = t.slice(9);
    else if (t === "--live") a.live = true;
    else if (t === "--replace") a.replace = true;
    else if (t === "--dry-run") a.dry = true;
    else if (t === "--delay") a.delay = Number(argv[++i]);
    else if (t === "-h" || t === "--help") a.help = true;
    else { console.error(`unknown argument: ${t}`); a.help = true; a.bad = true; }
  }
  return a;
}

const USAGE = `usage: node canvas/scripts/push-leads.mjs [--leads leads.json] [--canvas URL] [--live] [--replace] [--dry-run] [--delay ms]
  --leads PATH  leads.json from \`npm run leads\` (default ./leads.json)
  --canvas URL  canvas base URL (default $CANVAS_URL or http://localhost:3000; base paths ok)
  --live        ~400ms between cards so the lane builds in front of a watcher (--delay overrides)
  --replace     remove an earlier Leads lane first, then redraw below the remaining content
  --dry-run     print the ops, post nothing`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(args.bad ? 2 : 0); }

  let mod;
  try {
    mod = await import(pathToFileURL(path.join(here, "../src/lib/leadsToOps.ts")).href);
  } catch (e) {
    throw new Error(`cannot load src/lib/leadsToOps.ts (needs Node >= 22.18, or run with --experimental-strip-types): ${e.message}`);
  }
  const { leadsToSteps, stateBounds, LANE_PREFIX } = mod;

  const file = path.resolve(args.leads);
  let doc;
  try { doc = JSON.parse(await readFile(file, "utf8")); } catch (e) { throw new Error(`cannot read ${args.leads}: ${e.message}`); }
  if (doc.kind !== "astrahack.leads") throw new Error(`${args.leads} is not a leads.json (kind ${JSON.stringify(doc.kind)})`);

  const base = (args.canvas || process.env.CANVAS_URL || "http://localhost:3000").replace(/\/+$/, "");
  const api = (p) => `${base}/api${p}`;

  let envelopes = [];
  try {
    const res = await fetch(api("/state"));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    envelopes = (await res.json()).ops ?? [];
  } catch (e) {
    if (!args.dry) throw new Error(`canvas not reachable at ${base} (${e.cause?.code ?? e.message}). Start it: cd canvas && npm run dev`);
    console.warn(`canvas not reachable at ${base}; dry run lays the lane out at the origin`);
  }

  // an earlier lane = shapes whose id starts with the lane prefix
  const earlier = stateBounds(envelopes)?.ids.filter((i) => i.startsWith(LANE_PREFIX)) ?? [];
  if (earlier.length && !args.replace) {
    console.log(`a Leads lane is already on the board (${earlier.length} shapes). Nothing posted; pass --replace to redraw it.`);
    return;
  }
  const without = (list) => list.filter(({ op }) => !op?.id || !String(op.id).startsWith(LANE_PREFIX));
  const kept = args.replace ? without(envelopes) : envelopes;
  const b = stateBounds(kept);
  const originX = b ? Math.round(b.minX) : 0;
  const originY = b ? Math.round(b.maxY + 220) : 0;

  const steps = leadsToSteps(doc, { originX, originY });
  const ops = steps.flat();

  if (args.dry) {
    console.log(JSON.stringify(ops, null, 2));
    console.error(`dry run: ${ops.length} ops in ${steps.length} steps, lane origin (${originX}, ${originY})`);
    return;
  }

  const post = async (body) => {
    const res = await fetch(api("/ops"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`POST /api/ops failed: ${res.status} ${await res.text()}`);
  };
  if (args.replace && earlier.length) {
    for (const i of earlier) await post({ type: "delete", id: i });
    console.log(`removed ${earlier.length} shapes from the earlier lane`);
  }

  const delay = args.delay ?? (args.live ? 400 : 0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // live: one card per batch so the lane animates; otherwise merge small steps into batches of ~40 ops
  const batches = [];
  if (args.live) batches.push(...steps);
  else {
    let cur = [];
    for (const s of steps) { if (cur.length && cur.length + s.length > 40) { batches.push(cur); cur = []; } cur.push(...s); }
    if (cur.length) batches.push(cur);
  }
  let posted = 0;
  for (const [i, batch] of batches.entries()) {
    await post(batch);
    posted += batch.length;
    if (delay && i < batches.length - 1) await sleep(delay);
  }
  const leads = doc.shortlist?.leads?.length ?? 0;
  console.log(`posted ${posted} ops (${doc.sources?.length ?? 0} sources, ${doc.outreach?.length ?? 0} drafts, ${leads} live leads) -> ${base}, lane at y=${originY}`);
}

main().catch((e) => { console.error(`push-leads: ${e.message}`); process.exit(1); });
