#!/usr/bin/env node
// Push a computer-use runner run onto the live canvas.
//
//   node canvas/scripts/push-run.mjs <runDir | report.json> [--canvas URL] [--live] [--clear] [--layout single] [--include-design] [--dry-run]
//
// Only functional findings (observable broken behavior with steps, expected vs actual and evidence) are drawn.
// Design opinions and incomplete findings are left out and listed on stderr; --include-design keeps design
// findings at severity info.
//
// <runDir> holds report.json (runner) or qa-agent.json (agent / fleet), optionally qa-analysis.json.
// Screenshots/videos are uploaded through POST <canvas>/api/upload and the returned url becomes the op src.
// Canvas base: --canvas, else $CANVAS_URL, else http://localhost:3000. A base path is fine (https://ignura.com/astrahack).

import { readFile, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { boardApi, parseBoard } from "../src/lib/board.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// importing the .ts module straight from a package without "type": "module" makes Node warn once; it is harmless
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(rest[0]?.code ?? rest[1] ?? "").includes("MODULE_TYPELESS_PACKAGE_JSON") ? undefined : emit.call(process, w, ...rest));

function parseArgs(argv) {
  const a = { _: [], live: false, clear: false, dry: false, includeDesign: false, layout: undefined, canvas: undefined, delay: undefined };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--live") a.live = true;
    else if (t === "--clear") a.clear = true;
    else if (t === "--dry-run") a.dry = true;
    else if (t === "--include-design") a.includeDesign = true;
    else if (t === "--canvas") a.canvas = argv[++i];
    else if (t.startsWith("--canvas=")) a.canvas = t.slice(9);
    else if (t === "--layout") a.layout = argv[++i];
    else if (t === "--delay") a.delay = Number(argv[++i]);
    else if (t === "--run-id") a.runId = argv[++i];
    else if (t === "--board") a.board = argv[++i];
    else if (t.startsWith("--board=")) a.board = t.slice(8);
    else if (t === "--x") a.x = Number(argv[++i]);
    else if (t === "--y") a.y = Number(argv[++i]);
    else if (t === "-h" || t === "--help") a.help = true;
    else a._.push(t);
  }
  return a;
}

const USAGE = `usage: node canvas/scripts/push-run.mjs <runDir|report.json> [--canvas URL] [--live] [--clear] [--layout journeys|single] [--delay ms] [--include-design] [--dry-run]
  --canvas URL  canvas base URL (default $CANVAS_URL or http://localhost:3000; base paths ok)
  --live        ~400ms between steps so the canvas animates as a watcher sees it (--delay overrides)
  --clear       wipe the board first (DELETE /api/state)
  --board ID    board to publish to (default $CANVAS_BOARD, else main). A run uses its run id: separate boards never collide
  --run-id ID   stable run identity (default report path + start time); prevents cross-run id collisions
  --x / --y N  placement origin; default appends below existing content
  --include-design  also draw usability/visual findings (always severity info). Default: functional findings only
  --dry-run     print the ops, upload and post nothing`;

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function locate(input) {
  const s = await stat(input).catch(() => null);
  if (!s) throw new Error(`not found: ${input}`);
  if (!s.isDirectory()) return { reportPath: input, dir: path.dirname(input) };
  for (const name of ["report.json", "qa-agent.json", "fleet.json", "crawl.json"]) {
    const p = path.join(input, name);
    if (await exists(p)) {
      // fleet.json lists assignments only; the combined evidence lives in qa-agent.json
      if (name === "fleet.json" && (await exists(path.join(input, "qa-agent.json")))) continue;
      return { reportPath: p, dir: input };
    }
  }
  const names = await readdir(input);
  throw new Error(`no report.json, qa-agent.json, or crawl.json in ${input} (found: ${names.slice(0, 8).join(", ")})`);
}

function pngSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  return null;
}

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".webm": "video/webm", ".mp4": "video/mp4", ".mov": "video/quicktime" };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args._[0]) { console.log(USAGE); process.exit(args.help ? 0 : 2); }

  let runToOps;
  try {
    ({ runToOps } = await import(pathToFileURL(path.join(here, "../src/lib/runToOps.ts")).href));
  } catch (e) {
    throw new Error(`cannot load src/lib/runToOps.ts (needs Node >= 22.18, or run with --experimental-strip-types): ${e.message}`);
  }

  const { reportPath, dir } = await locate(path.resolve(args._[0]));
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const crawlPath = path.join(dir, "crawl.json");
  const crawl = reportPath === crawlPath ? report : (await exists(crawlPath)) ? JSON.parse(await readFile(crawlPath, "utf8")) : null;
  const analysisPath = path.join(dir, "qa-analysis.json");
  const analysis = (await exists(analysisPath)) ? JSON.parse(await readFile(analysisPath, "utf8")) : null;

  const base = (args.canvas || process.env.CANVAS_URL || "http://localhost:3000").replace(/\/+$/, "");
  const board = parseBoard(args.board || process.env.CANVAS_BOARD || undefined);
  if (!board) throw new Error("--board must match ^[a-zA-Z0-9-]{1,64}$");
  const api = boardApi(base, board);
    
  // ---- collect local media referenced by the bundle
  const rel = new Set();
  for (const j of report.journeys ?? []) {
    if (j.video) rel.add(j.video);
    for (const s of j.steps ?? []) if (s.screenshot) rel.add(s.screenshot);
  }
  for (const s of report.steps ?? []) if (s.screenshot) rel.add(s.screenshot);
  for (const a of report.assets ?? []) if (a.type === "video" && a.path) rel.add(a.path);
  for (const page of crawl?.pages ?? []) if (page.screenshot) rel.add(page.screenshot);

  const sizes = {};
  const srcMap = {};
  const uploads = [];
  for (const p of rel) {
    const file = path.resolve(dir, p);
    if (!file.startsWith(path.resolve(dir) + path.sep)) { console.warn(`skip (outside run dir): ${p}`); continue; }
    if (!(await exists(file))) { console.warn(`skip (missing file): ${p}`); continue; }
    const buf = await readFile(file);
    const sz = pngSize(buf);
    if (sz) sizes[p] = sz;
    uploads.push({ p, file, buf });
  }

  // steps whose file is missing would 404 on the canvas: drop them from the bundle view
  const have = new Set(uploads.map((u) => u.p));
  const prune = (r) => {
    const c = structuredClone(r);
    for (const j of c.journeys ?? []) {
      j.steps = (j.steps ?? []).filter((s) => !s.screenshot || have.has(s.screenshot));
      if (j.video && !have.has(j.video)) delete j.video;
    }
    if (c.steps) c.steps = c.steps.filter((s) => !s.screenshot || have.has(s.screenshot));
    if (c.pages) c.pages = c.pages.map((p) => p.screenshot && !have.has(p.screenshot) ? { ...p, screenshot: null } : p);
    return c;
  };
  const pruned = prune(report);
  const prunedCrawl = crawl === report ? pruned : crawl ? prune(crawl) : null;

  let reported = false;
  const onExcluded = (items) => {
    if (reported) return;
    reported = true;
    console.error(`left out ${items.length} finding(s) (not functional, or missing steps / expected vs actual / evidence):`);
    for (const x of items) console.error(`  - ${x.title} [${x.category}] ${x.reasons.join("; ")}`);
  };
  for (const value of [args.x, args.y]) if (value !== undefined && !Number.isFinite(value)) throw new Error("--x and --y must be finite numbers");
  const idPrefix = `run-${createHash("sha256").update(args.runId ?? `${reportPath}:${report.startedAt ?? ""}`).digest("hex").slice(0, 12)}`;
  let origin = { x: args.x ?? 0, y: args.y ?? 0 };
  const buildOps = (map) => runToOps({ report: pruned, crawl: prunedCrawl, analysis }, { srcMap: map, sizes, layout: args.layout, idPrefix, origin, includeDesign: args.includeDesign, onExcluded });

  if (args.dry) {
    const fake = Object.fromEntries([...have].map((p) => [p, `/uploads/${path.basename(p)}`]));
    console.log(JSON.stringify(buildOps(fake), null, 2));
    return;
  }

  // ---- upload
  async function uploadOne({ p, file, buf }) {
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    const name = path.basename(file);
    if (buf.length > 4_000_000) {
      try {
        const { upload } = await import("@vercel/blob/client");
        const blob = await upload(`runs/${Date.now()}-${name}`, new Blob([buf], { type }), { access: "public", handleUploadUrl: api("/upload/token") });
        return blob.url;
      } catch (e) {
        if (e?.code !== "ERR_MODULE_NOT_FOUND") console.warn(`direct blob upload failed for ${p} (${e.message}); trying multipart`);
      }
    }
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type }), name);
    const res = await fetch(api("/upload"), { method: "POST", body: fd });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.url) throw new Error(`upload ${p} failed: ${res.status} ${body.error ?? ""}`);
    return body.url; // app-relative url incl. base path, exactly as returned
  }

  let state;
  try {
    const response = await fetch(api("/state"));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state = await response.json();
  } catch (e) {
    throw new Error(`canvas not reachable at ${base} (${e.cause?.code ?? e.message}). Start it: cd canvas && npm run dev`);
  }
  if (args.clear) {
    const response = await fetch(api("/state"), { method: "DELETE" });
    if (!response.ok) throw new Error(`clear failed: HTTP ${response.status}`);
  } else {
    const placed = new Map();
    for (const { op } of state.ops ?? []) {
      if (op.type === "clear") placed.clear();
      else if (op.type === "delete") placed.delete(op.id);
      else if (op.id && op.type.startsWith("add_") && Number.isFinite(op.x)) placed.set(op.id, { x: op.x, y: op.y, h: op.h ?? (op.type === "add_finding" ? 500 : 400) });
      else if (placed.has(op.id) && (op.type === "move" || op.type === "update")) Object.assign(placed.get(op.id), op.type === "move" ? { x: op.x, y: op.y } : op.props);
    }
    const previous = placed.get(`${idPrefix}-run-title`);
    const bottom = Math.max(0, ...[...placed.values()].map((p) => p.y + p.h));
    origin = { x: args.x ?? previous?.x ?? 0, y: args.y ?? (previous ? previous.y + 400 : placed.size ? bottom + 640 : 0) };
  }

  console.log(`uploading ${uploads.length} file(s) to ${base} ...`);
  let n = 0;
  for (const u of uploads) {
    srcMap[u.p] = await uploadOne(u);
    process.stdout.write(`\r  ${++n}/${uploads.length}`);
  }
  if (uploads.length) process.stdout.write("\n");

  // ---- post ops. A group = one step (image + arrow + annotations + findings), so --live animates step by step.
  const ops = buildOps(srcMap);
  const groups = [];
  for (const op of ops) {
    if (!groups.length || ["add_image", "add_video", "focus"].includes(op.type) || op.type === "add_shape" && op.kind === "text") groups.push([]);
    groups[groups.length - 1].push(op);
  }
  const delay = args.delay ?? (args.live ? 400 : 0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let posted = 0;
  const batches = args.live ? groups : chunk(ops, 40).map((c) => c);
  for (const [i, g] of batches.entries()) {
    const res = await fetch(api("/ops"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(g) });
    if (!res.ok) throw new Error(`POST /api/ops failed: ${res.status} ${await res.text()}`);
    posted += g.length;
    if (delay && i < batches.length - 1) await sleep(delay);
  }
  console.log(`posted ${posted} ops (${ops.filter((o) => o.type === "add_image").length} steps, ${ops.filter((o) => o.type === "add_finding").length} findings) -> ${base}`);
}

function chunk(a, n) {
  const out = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

main().catch((e) => { console.error(`push-run: ${e.message}`); process.exit(1); });
