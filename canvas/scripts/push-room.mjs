#!/usr/bin/env node
// Draw an Ignura project room onto its whiteboard: title, overview, findings (with their screenshots),
// extra screenshots, opportunities and the sketch. What lands on the board is what a client may see.
//
//   node canvas/scripts/push-room.mjs --slug <room-slug> [--shots shots.json] [--canvas URL] [--replace] [--dry-run]
//   node canvas/scripts/push-room.mjs --room payload.json  ...    (a private room: the canvas_payload JSON, from the Ignura team)
//
// --slug      a PUBLIC room, read through Ignura's canvas_room() with the public anon key
// --shots     JSON array [{ id, title, body?, src, href? }] drawn as a Screenshots lane (src is any https image URL)
// --canvas    canvas base (default $CANVAS_URL, else https://ignura.com/astrahack)
// --replace   delete what an earlier push drew (ids starting rd-) and draw it again
// Needs ASTRAHACK_WORKER_TOKEN (the worker's bearer token) to write. IGNURA_SUPABASE_URL / IGNURA_SUPABASE_KEY are the
// public project URL and publishable key (defaults baked in below are those same public values).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boardApi, isBoardId } from "../src/lib/board.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(rest[0]?.code ?? rest[1] ?? "").includes("MODULE_TYPELESS_PACKAGE_JSON") ? undefined : emit.call(process, w, ...rest));

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes(`--${name}`);
if (has("help") || argv.length === 0) {
  console.log("usage: node canvas/scripts/push-room.mjs --slug <room-slug> | --room payload.json [--shots shots.json] [--canvas URL] [--replace] [--dry-run]");
  process.exit(argv.length ? 0 : 2);
}

/** Natural size of a PNG, JPEG or GIF from its first bytes. null when unknown. */
async function probe(url) {
  try {
    const res = await fetch(url, { headers: { range: "bytes=0-65535" } });
    if (!res.ok) return null;
    const b = Buffer.from(await res.arrayBuffer());
    if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.toString("ascii", 0, 3) === "GIF") return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch { /* fall through */ }
  return null;
}

async function loadRoom() {
  const file = flag("room");
  if (file) return JSON.parse(await readFile(path.resolve(file), "utf8"));
  const slug = flag("slug");
  if (!slug) throw new Error("give --slug or --room");
  const url = process.env.IGNURA_SUPABASE_URL || "https://gxpddznmoxdljeqgjvrs.supabase.co";
  const key = process.env.IGNURA_SUPABASE_KEY;
  if (!key) throw new Error("set IGNURA_SUPABASE_KEY (the project's publishable key) to read a room by slug");
  const res = await fetch(`${url}/rest/v1/rpc/canvas_room`, { method: "POST", headers: { apikey: key, "content-type": "application/json" }, body: JSON.stringify({ p_slug: slug }) });
  const payload = res.ok ? await res.json() : null;
  if (!payload) throw new Error(`no public room "${slug}" (private rooms: pass --room payload.json)`);
  return payload;
}

async function main() {
  const mod = await import(pathToFileURL(path.join(here, "../src/lib/roomToOps.ts")).href);
  const { roomToSteps, roomFromPayload, ROOM_PREFIX } = mod;

  const payload = await loadRoom();
  const board = payload.board;
  if (!isBoardId(board)) throw new Error(`payload has no valid board id (${JSON.stringify(board)}); re-read the room after the board-key migration`);
  const room = roomFromPayload(payload);
  if (flag("shots")) room.shots = JSON.parse(await readFile(path.resolve(flag("shots")), "utf8"));

  const base = (flag("canvas") || process.env.CANVAS_URL || "https://ignura.com/astrahack").replace(/\/+$/, "");
  const api = boardApi(base, board);
  const token = process.env.ASTRAHACK_WORKER_TOKEN || "";
  const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };

  const steps = await roomToSteps(room, probe);
  const ops = steps.flat();
  if (has("dry-run")) {
    console.log(JSON.stringify(ops, null, 2));
    console.error(`dry run: ${ops.length} ops for "${room.name}" -> ${board}`);
    return;
  }
  if (!token) throw new Error("set ASTRAHACK_WORKER_TOKEN to write to a room board");

  const post = async (body) => {
    const res = await fetch(api("/ops"), { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`POST /api/ops failed: ${res.status} ${await res.text()}`);
  };
  const state = await fetch(api("/state"), { headers });
  if (!state.ok) throw new Error(`cannot read the board (${state.status}): ${await state.text()}`);
  const live = new Map();
  for (const { op } of (await state.json()).ops ?? []) {
    if (op.type === "clear") live.clear();
    else if (op.type === "delete") live.delete(op.id);
    else if (op.id && String(op.id).startsWith(ROOM_PREFIX)) live.set(op.id, true);
  }
  if (live.size && !has("replace")) {
    console.log(`the board already has ${live.size} shapes from an earlier push. Nothing posted; pass --replace to redraw.`);
    return;
  }
  for (const id of live.keys()) await post({ type: "delete", id });
  if (live.size) console.log(`removed ${live.size} earlier shapes`);

  let batch = [];
  let posted = 0;
  for (const step of steps) {
    if (batch.length && batch.length + step.length > 40) { await post(batch); posted += batch.length; batch = []; }
    batch.push(...step);
  }
  if (batch.length) { await post(batch); posted += batch.length; }
  console.log(`posted ${posted} ops for "${room.name}" -> ${base} (board ${board})`);
}

main().catch((e) => { console.error(`push-room: ${e.message}`); process.exit(1); });
