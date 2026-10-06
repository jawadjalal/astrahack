import { parseBoard, isBoardId } from "../lib/board.mjs";
import { json } from "./cors";

export type BoardParams = { board: string; client?: string } | { error: Response };

/** `?board=<id>` (default `main`) and optional `?client=<tabId>` from a request URL, validated. */
export function boardParams(req: Request): BoardParams {
  const url = new URL(req.url);
  const board = parseBoard(url.searchParams.get("board"));
  if (!board) return { error: json({ ok: false, error: "invalid board id (use 1-64 letters, digits or hyphens)" }, 400) };
  const client = url.searchParams.get("client") ?? undefined;
  if (client !== undefined && !isBoardId(client)) return { error: json({ ok: false, error: "invalid client id" }, 400) };
  return { board, client };
}
