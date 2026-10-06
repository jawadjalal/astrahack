#!/usr/bin/env node
// Push the launch kit (ad creatives + X/Reddit GTM posts + UGC concepts) onto the live canvas, as a labelled lane
// below whatever teardown is already there.
//
//   node canvas/scripts/push-kit.mjs --ads artifacts/ads-<run> --campaigns artifacts/campaigns-<run> --ugc ugc-plan.json \
//        [--run runs/<teardown>] [--run-prefix run-ab12cd34ef56] [--canvas URL] [--live] [--origin x,y] [--replace] [--dry-run]
//
// Any subset of --ads / --campaigns / --ugc works; each missing input just leaves its lane out.
// Canvas base: --canvas, else $CANVAS_URL, else http://localhost:3000. A base path is fine (https://ignura.com/astrahack).

import { readFile, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { boardApi, parseBoard } from "../src/lib/board.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// importing .ts straight from a package without "type": "module" makes Node warn once; it is harmless
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(rest[0]?.code ?? rest[1] ?? "").includes("MODULE_TYPELESS_PACKAGE_JSON") ? undefined : emit.call(process, w, ...rest));

const USAGE = `usage: node canvas/scripts/push-kit.mjs [--ads <dir|manifest.json>] [--campaigns <dir|file>]... [--ugc <ugc-plan.json>]
                                   [--run <teardown dir|report.json>] [--canvas URL] [--live] [--origin x,y] [--replace] [--dry-run]
  --ads         artifacts/ads-<run> from \`npm run generate\` (manifest.json + the five PNGs)
  --campaigns   artifacts/campaigns-<run> from \`npm run campaigns\`, or an x-/reddit-campaign.json; repeatable
  --ugc         ugc-plan.json (contract: ugc/schema.js)
  --run         the teardown run dir/report.json already on the canvas: lets UGC cards arrow to its step-N screenshots
                even offline (with a live canvas the step ids are read from GET /api/state)
  --run-prefix  id prefix of the teardown (run-<12 hex>, as push-run scopes its ids). Default: found from --run, else the
                latest teardown on the board
  --board ID    board to publish to (default $CANVAS_BOARD, else main)
  --canvas URL  canvas base URL (default $CANVAS_URL or http://localhost:3000; base paths ok)
  --origin x,y  top-left of the kit in canvas px. Default: left edge of the existing content, 240px below its lowest element
  --live        post lane by lane with a pause so the canvas animates for a watcher (--delay ms overrides)
  --replace     delete the kit already on the canvas (ids ad-*, gtm-*, ugc-*, kit-*) and place it again
  --dry-run     print the ops as JSON on stdout; nothing is uploaded or posted (reads GET /api/state when reachable)`;

function parseArgs(argv) {
  const a = { campaigns: [], live: false, dry: false, replace: false };
  const val = (i, t) => { const v = argv[i]; if (v === undefined) throw new Error(`${t} needs a value`); return v; };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const eq = t.startsWith("--") && t.includes("=") ? t.indexOf("=") : -1;
    const flag = eq > 0 ? t.slice(0, eq) : t;
    const inline = eq > 0 ? t.slice(eq + 1) : undefined;
    const next = () => inline ?? val(++i, flag);
    if (flag === "--ads") a.ads = next();
    else if (flag === "--campaigns") a.campaigns.push(next());
    else if (flag === "--ugc") a.ugc = next();
    else if (flag === "--run") a.run = next();
    else if (flag === "--run-prefix") a.runPrefix = next();
    else if (flag === "--canvas") a.canvas = next();
    else if (flag === "--board") a.board = next();
    else if (flag === "--origin") a.origin = next();
    else if (flag === "--delay") a.delay = Number(next());
    else if (flag === "--live") a.live = true;
    else if (flag === "--replace") a.replace = true;
    else if (flag === "--dry-run") a.dry = true;
    else if (flag === "-h" || flag === "--help") a.help = true;
    else throw new Error(`unknown argument ${t}`);
  }
  return a;
}

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pngSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  return null;
}

async function dirOrFile(p, names) {
  const s = await stat(p).catch(() => null);
  if (!s) throw new Error(`not found: ${p}`);
  if (!s.isDirectory()) return { file: p, dir: path.dirname(p) };
  for (const n of names) if (await exists(path.join(p, n))) return { file: path.join(p, n), dir: p };
  throw new Error(`none of ${names.join(", ")} in ${p} (found: ${(await readdir(p)).slice(0, 8).join(", ")})`);
}

async function loadAds(input) {
  const { file, dir } = await dirOrFile(path.resolve(input), ["manifest.json"]);
  const manifest = await readJson(file);
  if (!Array.isArray(manifest.creatives)) throw new Error(`${file} has no creatives[]: is it the manifest of \`npm run generate\`?`);
  return { manifest, dir };
}

async function loadCampaigns(inputs) {
  const out = {};
  const note = (channel, campaign, from) => {
    if (out[channel]) console.error(`push-kit: two ${channel} campaigns given; using ${from}`);
    out[channel] = campaign;
  };
  const detect = (c, file) => {
    const base = path.basename(file);
    if (/^x[-_.]/i.test(base)) return "x";
    if (/^reddit/i.test(base)) return "reddit";
    if (Array.isArray(c?.thread)) return "x";
    if (Array.isArray(c?.communities) || Array.isArray(c?.replies)) return "reddit";
    throw new Error(`cannot tell which channel ${file} is for: name it x-campaign.json / reddit-campaign.json`);
  };
  for (const input of inputs) {
    const p = path.resolve(input);
    const s = await stat(p).catch(() => null);
    if (!s) throw new Error(`not found: ${input}`);
    if (s.isDirectory()) {
      let found = 0;
      for (const ch of ["x", "reddit"]) {
        const f = path.join(p, `${ch}-campaign.json`);
        if (await exists(f)) { note(ch, await readJson(f), f); found++; }
      }
      if (!found) throw new Error(`no x-campaign.json or reddit-campaign.json in ${input}`);
    } else {
      const c = await readJson(p);
      note(detect(c, p), c, p);
    }
  }
  return out;
}

/** what a teardown run put on the canvas: screenshot path -> step index, and the id prefix push-run scopes it with */
async function loadRun(input) {
  const s = await stat(path.resolve(input)).catch(() => null);
  if (!s) throw new Error(`not found: ${input}`);
  let file = path.resolve(input);
  if (s.isDirectory()) {
    const hit = ["report.json", "qa-agent.json"].map((n) => path.join(file, n));
    file = (await Promise.all(hit.map(exists))).map((ok, i) => (ok ? hit[i] : null)).find(Boolean);
    if (!file) throw new Error(`no report.json or qa-agent.json in ${input}`);
  }
  const report = await readJson(file);
  const bundle = report.report ?? report;
  const byPath = {};
  const steps = [...(bundle.journeys ?? []).flatMap((j) => j.steps ?? []), ...(bundle.steps ?? [])];
  for (const st of steps) if (st?.screenshot && Number.isFinite(st.index)) byPath[st.screenshot] = st.index;
  // same formula as push-run.mjs: run-<sha256 of "<report path>:<startedAt>", 12 hex>
  const prefix = `run-${createHash("sha256").update(`${file}:${report.startedAt ?? ""}`).digest("hex").slice(0, 12)}-`;
  return { byPath, prefix };
}

/** id prefixes of the teardowns on the board ("" for bare step-N ids, "run-ab12cd34ef56-" for push-run ones), latest last */
function runPrefixesOnBoard(envelopes, live) {
  const order = [];
  for (const e of envelopes ?? []) {
    const op = e?.op ?? e;
    const m = op?.type === "add_image" && op.id && live.has(op.id) ? /^(.*?)step-\d+$/.exec(op.id) : null;
    if (m) { const i = order.indexOf(m[1]); if (i >= 0) order.splice(i, 1); order.push(m[1]); }
  }
  return order;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return; }
  if (!args.ads && !args.campaigns.length && !args.ugc) { console.error(USAGE); process.exit(2); }

  const lib = async (name) => {
    try { return await import(pathToFileURL(path.join(here, "../src/lib", name)).href); }
    catch (e) { throw new Error(`cannot load src/lib/${name} (needs Node >= 22.18, or run with --experimental-strip-types): ${e.message}`); }
  };
  const kit = await lib("kitToOps.ts");
  // the op contract (zod) only feeds the `say` feature detection: without canvas/node_modules the kit still goes out, minus the caption
  const OpSchema = await lib("ops.ts").then((m) => m.OpSchema, () => null);

  // ---- inputs
  const ads = args.ads ? await loadAds(args.ads) : null;
  const campaigns = args.campaigns.length ? await loadCampaigns(args.campaigns) : null;
  const ugcPlan = args.ugc ? await readJson(path.resolve(args.ugc)) : null;
  if (ugcPlan && !Array.isArray(ugcPlan.scripts)) throw new Error(`${args.ugc} has no scripts[]: is it a ugc-plan.json?`);
  const run = args.run ? await loadRun(args.run) : null;

  const base = (args.canvas || process.env.CANVAS_URL || "http://localhost:3000").replace(/\/+$/, "");
  const board = parseBoard(args.board || process.env.CANVAS_BOARD || undefined);
  if (!board) throw new Error("--board must match ^[a-zA-Z0-9-]{1,64}$");
  const api = boardApi(base, board);

  // ---- canvas state: where to put the kit, which step ids exist, what an earlier kit left behind
  let envelopes = null;
  try {
    const res = await fetch(api("/state"), { signal: AbortSignal.timeout(args.dry ? 2500 : 15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    envelopes = (await res.json()).ops ?? [];
  } catch (e) {
    if (!args.dry) throw new Error(`canvas not reachable at ${base} (${e.cause?.code ?? e.message}). Start it: cd canvas && npm run dev`);
    console.error(`push-kit: no canvas at ${base} (${e.cause?.code ?? e.message}); dry run assumes an empty board`);
  }
  const live = envelopes ? kit.liveIds(envelopes) : new Set();
  const earlier = [...live].filter(kit.isKitId);
  if (earlier.length && !args.replace) {
    throw new Error(`a launch kit is already on this canvas (${earlier.length} elements, e.g. ${earlier.slice(0, 3).join(", ")}). Pass --replace to delete it and place the new one, or clear the board.`);
  }
  const deletes = args.replace ? earlier.map((id) => ({ type: "delete", id })) : [];
  // the board as it will be once the earlier kit is gone
  const remaining = envelopes ? [...envelopes, ...deletes.map((op) => ({ op }))] : [];
  const { box, ids: boardIds } = kit.stateBounds(remaining);

  let origin;
  if (args.origin) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(args.origin);
    if (!m) throw new Error(`--origin wants x,y in canvas px, e.g. --origin 0,1800 (got "${args.origin}")`);
    origin = { x: Number(m[1]), y: Number(m[2]) };
  } else origin = kit.originBelow(box);

  // ---- ad images: read, size, upload
  const adFiles = [];
  const srcMap = {}, sizes = {};
  if (ads) {
    for (const c of ads.manifest.creatives) {
      if (!c?.filename || c.status === "failed") continue;
      const file = path.resolve(ads.dir, c.filename);
      if (!file.startsWith(path.resolve(ads.dir) + path.sep)) { console.error(`push-kit: skip (outside the ads dir): ${c.filename}`); continue; }
      if (!(await exists(file))) { if (c.status === "complete") console.error(`push-kit: ${c.filename} is marked complete but the file is missing`); continue; }
      const buf = await readFile(file);
      const sz = pngSize(buf);
      if (sz) sizes[c.filename] = sz;
      adFiles.push({ name: c.filename, file, buf });
    }
  }

  async function uploadOne({ name, file, buf }) {
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    if (buf.length > 4_000_000) {
      try {
        const { upload } = await import("@vercel/blob/client");
        const blob = await upload(`kits/${Date.now()}-${name}`, new Blob([buf], { type }), { access: "public", handleUploadUrl: api("/upload/token") });
        return blob.url;
      } catch (e) {
        if (e?.code !== "ERR_MODULE_NOT_FOUND") console.error(`push-kit: direct blob upload failed for ${name} (${e.message}); trying multipart`);
      }
    }
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type }), name);
    const res = await fetch(api("/upload"), { method: "POST", body: fd });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.url) throw new Error(`upload ${name} failed: ${res.status} ${body.error ?? ""}`);
    return body.url; // app-relative url incl. base path, exactly as returned
  }

  if (args.dry) for (const f of adFiles) srcMap[f.name] = `/uploads/${f.name}`;
  else {
    if (adFiles.length) console.error(`uploading ${adFiles.length} image(s) to ${base} ...`);
    for (const [i, f] of adFiles.entries()) { srcMap[f.name] = await uploadOne(f); process.stderr.write(`\r  ${i + 1}/${adFiles.length}`); }
    if (adFiles.length) process.stderr.write("\n");
  }

  // ---- build. Which teardown's screenshots the UGC cards point at: --run-prefix, else the one --run produced, else the latest on the board
  const prefixes = runPrefixesOnBoard(envelopes, live);
  const stepPrefix = args.runPrefix
    ? `${args.runPrefix.replace(/-$/, "")}-`
    : run && (prefixes.includes(run.prefix) || !prefixes.length) ? run.prefix
    : prefixes.length ? prefixes[prefixes.length - 1] : "";
  if (run && prefixes.length && !prefixes.includes(run.prefix) && !args.runPrefix) console.error(`push-kit: --run's teardown is not on this board; pointing at the latest one (${stepPrefix || "step-N"}) instead`);
  const stepIds = new Set([...boardIds].filter((id) => id.startsWith(stepPrefix) && /^step-\d+$/.test(id.slice(stepPrefix.length))));
  if (!envelopes && run) for (const n of new Set(Object.values(run.byPath))) stepIds.add(`${stepPrefix}step-${n}`); // offline dry run: trust --run
  const result = kit.kitToOpsDetailed(
    { ads: ads?.manifest, campaigns, ugcPlan },
    {
      origin, srcMap, sizes, stepIds, stepPrefix,
      stepIdFor: (p) => (run && p in run.byPath ? `${stepPrefix}step-${run.byPath[p]}` : kit.defaultStepIdFor(p, stepPrefix)),
      say: kit.detectSayOp(OpSchema),
      group: kit.supportsGroup(OpSchema),
    },
  );
  if (!result.ids.length) throw new Error("nothing to place: the inputs held no ads, posts or UGC scripts");
  // ops.ts may know `say` / `group` while a deployed canvas does not: post those on their own after the cards, and shrug if refused
  const optional = (o) => o.type === "say" || o.type === "group";
  const sayOps = result.ops.filter(optional);
  const ops = [...deletes, ...result.ops.filter((o) => !optional(o))];

  const c = result.counts;
  const summary = `${c.ads} ads, ${c.xPosts} X posts, ${c.xThread} thread parts, ${c.redditPosts} Reddit drafts, ${c.ugc} UGC concepts, ${c.evidenceArrows} evidence arrows`;
  console.error(`kit origin (${origin.x}, ${origin.y})${args.origin ? "" : box ? " below the existing board" : " (empty board)"}: ${summary}`);

  if (args.dry) { console.log(JSON.stringify([...ops, ...sayOps], null, 2)); return; }

  // ---- post. Batches: deletes, banner, then one per lane, then the focus, so --live animates lane by lane.
  const batches = [];
  const startsBatch = (o) => o.type === "add_shape" && /^kit-lane-[a-z]+-panel$/.test(o.id ?? "") || o.type === "focus";
  for (const op of ops) {
    if (!batches.length || startsBatch(op)) batches.push([]);
    batches[batches.length - 1].push(op);
  }
  const delay = args.delay ?? (args.live ? 900 : 0);
  let posted = 0;
  for (const [i, group] of batches.entries()) {
    for (let k = 0; k < group.length; k += 40) {
      const part = group.slice(k, k + 40);
      const res = await fetch(api("/ops"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(part) });
      if (!res.ok) throw new Error(`POST /api/ops failed: ${res.status} ${await res.text()}`);
      posted += part.length;
    }
    if (delay && i < batches.length - 1) await sleep(delay);
  }
  if (sayOps.length) {
    // groups first, then the caption: one request each so an older canvas refusing one op does not drop the others
    for (const op of [...sayOps.filter((o) => o.type === "group"), ...sayOps.filter((o) => o.type === "say")]) {
      const res = await fetch(api("/ops"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(op) }).catch(() => null);
      if (res?.ok) posted++;
      else console.error(`push-kit: this canvas did not accept the ${op.type} op (${res ? res.status : "unreachable"}); skipped`);
    }
  }
  console.log(`posted ${posted} ops (${summary}) -> ${base}`);
}

main().catch((e) => { console.error(`push-kit: ${e.message}`); process.exit(1); });
