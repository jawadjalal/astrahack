import { createHash, timingSafeEqual } from "node:crypto";

// Ignura project rooms (ignura.com/canvas/<room>) each own one board here, named `rm-` + 24 hex.
// The key is secret: a public room hands it to anyone holding the room link, a private room only to the team.
// Rules, enforced here so a leaked or old URL cannot get around them:
//   read   public room -> anyone; private room -> a signed-in Ignura team member
//   write  an Ignura team member, or the worker (Authorization: Bearer ASTRAHACK_WORKER_TOKEN)
// Team membership is asked of Ignura's Supabase with the caller's own session token (is_team()).
// Every other board (main, run boards) keeps its old open behaviour.

// Self-contained (no imports from ./cors) so node can load it directly in tests.
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });

const ROOM = /^rm-[0-9a-f]{24}$/;
export const isRoomBoard = (board: string) => ROOM.test(board);

const url = () => process.env.IGNURA_SUPABASE_URL || "";
const key = () => process.env.IGNURA_SUPABASE_KEY || "";

type Hit = { v: unknown; until: number };
const cache = new Map<string, Hit>();
const remember = async <T,>(k: string, ms: number, load: () => Promise<T>): Promise<T> => {
  const hit = cache.get(k);
  if (hit && hit.until > Date.now()) return hit.v as T;
  const v = await load();
  if (cache.size > 500) cache.clear();
  cache.set(k, { v, until: Date.now() + ms });
  return v;
};

async function rpc<T>(name: string, body: unknown, token?: string): Promise<T | null> {
  try {
    const res = await fetch(`${url()}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: key(), "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** The caller's session token: `Authorization: Bearer`, or `?token=` for EventSource, which cannot set headers. */
export function sessionToken(req: Request): string {
  const header = req.headers.get("authorization") || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return new URL(req.url).searchParams.get("token") || "";
}

export const isWorker = (token: string) => {
  const expected = process.env.ASTRAHACK_WORKER_TOKEN || "";
  return !!token && !!expected && timingSafeEqual(digest(token), digest(expected));
};

const isTeam = (token: string) => {
  if (!token || token.length > 4096) return Promise.resolve(false);
  return remember(`team:${digest(token).toString("hex")}`, 30_000, async () => (await rpc<boolean>("is_team", {}, token)) === true);
};

/** null = allowed. Otherwise the response to send. */
export async function authorizeRoom(req: Request, board: string, mode: "read" | "write"): Promise<Response | null> {
  if (!isRoomBoard(board)) return null;
  if (!url() || !key()) return json({ ok: false, error: "rooms are not configured on this server" }, 503);
  const token = sessionToken(req);
  if (mode === "write") {
    if (isWorker(token) || (await isTeam(token))) return null;
    return json({ ok: false, error: "sign in with an Ignura email to edit this room" }, 401);
  }
  const visibility = await remember(`vis:${board}`, 10_000, () => rpc<string | null>("canvas_board_visibility", { p_board: board }));
  if (!visibility) return json({ ok: false, error: "no such room" }, 404);
  if (visibility === "public" || isWorker(token) || (await isTeam(token))) return null;
  return json({ ok: false, error: "this room is private" }, 401);
}
