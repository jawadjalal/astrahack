import assert from "node:assert/strict";
import test from "node:test";

process.env.IGNURA_SUPABASE_URL = "https://ignura.test";
process.env.IGNURA_SUPABASE_KEY = "anon-key";
process.env.ASTRAHACK_WORKER_TOKEN = "worker-secret-0123456789abcdef";
const { authorizeRoom, isRoomBoard } = await import("../src/server/roomAuth.ts");

const BOARD = "rm-0123456789abcdef01234567";
const req = (headers = {}, query = "") => new Request(`https://x.test/api/state?board=${BOARD}${query}`, { headers });

// the "database": which boards exist and are public, and which session tokens belong to the team
let visibility = "public";
let team = new Set(["team-token"]);
globalThis.fetch = async (url, init) => {
  const name = String(url).split("/rpc/")[1];
  const auth = init.headers.authorization || "";
  const body = JSON.parse(init.body || "{}");
  if (name === "canvas_board_visibility") return Response.json(body.p_board === BOARD ? visibility : null);
  if (name === "is_team") return Response.json(team.has(auth.replace("Bearer ", "")));
  return new Response("no", { status: 404 });
};

const status = async (r) => (r ? r.status : 200);
// each case uses its own board id: verdicts are cached per board for a few seconds
test("only rm- ids are rooms; every other board stays open", async () => {
  assert.equal(isRoomBoard(BOARD), true);
  for (const id of ["main", "rm-short", "rm-0123456789abcdef0123456Z", "run-1"]) assert.equal(isRoomBoard(id), false);
  assert.equal(await authorizeRoom(req(), "main", "write"), null);
});

test("write needs a team session or the worker token", async () => {
  assert.equal(await status(await authorizeRoom(req(), BOARD, "write")), 401);
  assert.equal(await status(await authorizeRoom(req({ authorization: "Bearer stranger" }), BOARD, "write")), 401);
  assert.equal(await authorizeRoom(req({ authorization: "Bearer team-token" }), BOARD, "write"), null);
  assert.equal(await authorizeRoom(req({ authorization: "Bearer worker-secret-0123456789abcdef" }), BOARD, "write"), null);
});

test("a public room reads for anyone; a private one only for the team (header or ?token=)", async () => {
  assert.equal(await authorizeRoom(req(), BOARD, "read"), null);
  visibility = "private";
  await new Promise((r) => setTimeout(r, 10_050)); // the visibility verdict is cached for 10s
  assert.equal(await status(await authorizeRoom(req(), BOARD, "read")), 401);
  assert.equal(await authorizeRoom(req({ authorization: "Bearer team-token" }), BOARD, "read"), null);
  assert.equal(await authorizeRoom(req({}, "&token=team-token"), BOARD, "read"), null);
  assert.equal(await status(await authorizeRoom(req({}, "&token=nope"), BOARD, "read")), 401);
});

test("an unknown room is 404 and a server without Supabase settings fails closed", async () => {
  assert.equal(await status(await authorizeRoom(new Request("https://x.test/?board=rm-ffffffffffffffffffffffff"), "rm-ffffffffffffffffffffffff", "read")), 404);
  delete process.env.IGNURA_SUPABASE_URL;
  assert.equal(await status(await authorizeRoom(req(), BOARD, "write")), 503);
});
