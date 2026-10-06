// Board ids: every run (and the shared default) gets its own op log. Plain .mjs so the Next app, the
// node scripts under canvas/scripts and the root worker code can all import the same rules.
//
//   main                  the original shared board (Blob prefix `ops/`, unchanged for old links)
//   <runId>, any id       Blob prefix `boards/<id>/ops/`, its own SSE stream, its own clear

export const DEFAULT_BOARD = "main";
export const BOARD_RE = /^[a-zA-Z0-9-]{1,64}$/;

/** @param {unknown} v */
export const isBoardId = (v) => typeof v === "string" && BOARD_RE.test(v);

/**
 * Validate a board id from a query string. Missing or empty means the default board.
 * Returns null for an invalid id (callers answer 400).
 * @param {unknown} v
 * @returns {string | null}
 */
export function parseBoard(v) {
  if (v === undefined || v === null || v === "") return DEFAULT_BOARD;
  return isBoardId(v) ? /** @type {string} */ (v) : null;
}

/**
 * The board a run publishes to: its run id. Run ids are UUIDs (valid as is); anything else is
 * squeezed into the board alphabet so the worker and the browser always derive the same id.
 * @param {string} runId
 */
export function boardForRun(runId) {
  const id = String(runId).replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return id || DEFAULT_BOARD;
}

/**
 * Append `?board=<id>` (non-default boards only) to a URL or app-relative path.
 * @param {string} url
 * @param {string | null | undefined} board
 */
export function withBoard(url, board) {
  if (!board || board === DEFAULT_BOARD) return url;
  return `${url}${url.includes("?") ? "&" : "?"}board=${encodeURIComponent(board)}`;
}

/**
 * api("/ops") => `${base}/api/ops?board=...`. `base` may carry a base path (https://ignura.com/astrahack).
 * @param {string} base
 * @param {string | null | undefined} board
 */
export function boardApi(base, board) {
  const root = String(base).replace(/\/+$/, "");
  return (/** @type {string} */ p) => withBoard(`${root}/api${p}`, board);
}

/** @param {string} url */
export function isLocalCanvas(url) {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** Visible label on any sample board, so nobody mistakes demo content for a real run. */
export const SAMPLE_LABEL = "Sample (not a real run)";

/**
 * Sample/mock data must never land on the shared production board by accident.
 * Throws unless the target is a non-`main` board, a localhost canvas, or --force-prod was passed.
 * @param {{ board?: string | null, canvasUrl: string, forceProd?: boolean, what?: string }} o
 */
export function assertSampleWriteAllowed({ board, canvasUrl, forceProd = false, what = "sample data" }) {
  const id = board || DEFAULT_BOARD;
  if (id !== DEFAULT_BOARD || isLocalCanvas(canvasUrl) || forceProd) return;
  throw new Error(
    `refusing to write ${what} to the shared board "${DEFAULT_BOARD}" on ${canvasUrl}. ` +
      `Use a separate board (--board sample-demo), a localhost canvas, or pass --force-prod if you really mean it.`,
  );
}
