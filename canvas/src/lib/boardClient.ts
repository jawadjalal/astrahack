import { DEFAULT_BOARD, boardForRun, isBoardId, withBoard } from "./board.mjs";
import { BASE_PATH, withBase } from "./base";

// Which board this tab is looking at, and how every browser-side call addresses it.
// The board comes from the URL: `?board=<id>` wins, else `?run=<runId>` (a run publishes to the board named after
// its run id), else `main`. Old links without either keep working on `main`.

export { DEFAULT_BOARD };

/** Random id for this page load; stamped on human ops so the tab can recognise (and skip) its own echoes. */
export const CLIENT_ID = `c${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

export function boardFromSearch(search: string): string {
  const q = new URLSearchParams(search);
  const board = q.get("board");
  if (board && isBoardId(board)) return board;
  const run = q.get("run");
  if (run) return boardForRun(run);
  return DEFAULT_BOARD;
}

export const boardFromLocation = () => (typeof window === "undefined" ? DEFAULT_BOARD : boardFromSearch(window.location.search));

let active = DEFAULT_BOARD;
export const setActiveBoard = (board: string) => {
  active = board;
};
export const getActiveBoard = () => active;

/** App-relative API path with the base path and the active board applied: boardUrl("/api/ops"). */
export const boardUrl = (path: string, board: string = active) => withBoard(withBase(path), board);

/** Short human name for the status pill. */
export function boardLabel(board: string): string {
  if (board === DEFAULT_BOARD) return "main board";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(board) ? `run ${board.slice(0, 8)}` : board;
}

/** Link that opens exactly this board's canvas, for sharing. */
export function boardShareUrl(board: string): string {
  const base = `${window.location.origin}${BASE_PATH}/`;
  return board === DEFAULT_BOARD ? `${base}?view=canvas` : `${base}?view=canvas&board=${encodeURIComponent(board)}`;
}
