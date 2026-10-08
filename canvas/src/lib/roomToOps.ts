// Pure converter: an Ignura project room (the notes behind ignura.com/canvas/<room>) -> canvas Op[] steps.
// Existing ops only: add_shape (rectangle), add_text, add_image, draw. Same family as leadsToOps.
//
// What lands on the board is what a client may see. Rows the team marked internal (clientVisible === false) and
// the empty placeholder rows a new room starts with are left out; internal notes stay on the Ignura notes page.
// Layout is computed here (no editor): a title card, then an Overview lane and a Findings lane side by side, then
// the Opportunities columns underneath and the sketch to their right. Shape ids are stable (rd-<kind>-<row id>),
// so seeding twice never duplicates anything.
// No I/O. Only erasable TypeScript here so Node can import this file directly.

import type { Op } from "./ops";

export interface RoomRow { id: string; clientVisible?: boolean; placeholder?: boolean; position?: number }
export interface RoomIn {
  name: string;
  blurb?: string;
  columns?: { id: string; title: string; position?: number }[];
  cards?: (RoomRow & { columnId: string; title: string; body?: string })[];
  findings?: (RoomRow & { title: string; body?: string; href?: string | null; imageUrl?: string | null })[];
  sections?: (RoomRow & { title: string; body?: string })[];
  drawings?: (RoomRow & { title?: string; note?: string; strokes?: { color?: string; size?: number; points: number[][] }[] })[];
  /** Extra screenshots that live on the board only (captured pages, app screens). Drawn as a Screenshots lane. */
  shots?: { id: string; title: string; body?: string; src: string; href?: string | null }[];
}

/** The Ignura database's room payload (snake_case, from canvas_room / canvas_payload) -> RoomIn. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload is untyped JSON read defensively
export function roomFromPayload(p: any): RoomIn {
  const vis = (r: any) => ({ id: String(r.id), clientVisible: r.client_visible !== false, placeholder: !!r.placeholder, position: Number(r.position) || 0 });
  return {
    name: String(p.name ?? ""),
    blurb: String(p.blurb ?? ""),
    columns: (p.columns ?? []).map((c: any) => ({ id: String(c.id), title: String(c.title), position: Number(c.position) || 0 })),
    cards: (p.cards ?? []).map((c: any) => ({ ...vis(c), columnId: String(c.column_id), title: String(c.title), body: String(c.body ?? "") })),
    findings: (p.findings ?? []).map((f: any) => ({ ...vis(f), title: String(f.title), body: String(f.body ?? ""), href: f.href ?? null, imageUrl: f.image_url ?? null })),
    sections: (p.sections ?? []).map((x: any) => ({ ...vis(x), title: String(x.title), body: String(x.body ?? "") })),
    drawings: (p.drawings ?? []).map((d: any) => ({ ...vis(d), title: String(d.title ?? ""), note: String(d.note ?? ""), strokes: d.strokes ?? [] })),
  };
}

/** Natural size of an image URL, or null if unknown. The browser measures with <img>, node scripts with a header probe. */
export type MeasureImage = (url: string) => Promise<{ w: number; h: number } | null>;

export const ROOM_PREFIX = "rd-";

const COL_W = 460;
const GAP = 36;
const PAD = 18;
const LANE_GAP = 150;
const LABEL_H = 78;

type Color = "black" | "grey" | "red" | "orange" | "yellow" | "green" | "blue" | "violet";
const COLUMN_COLORS: Color[] = ["orange", "violet", "green", "blue", "red", "grey"];

const clip = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\r\n?/g, "\n").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** Rough wrapped height: lines * lineHeight. Over-estimates on purpose so cards never overlap. */
function textHeight(text: string, width: number, charW: number, lineH: number): number {
  const per = Math.max(8, Math.floor(width / charW));
  const lines = String(text).split("\n").reduce((n, p) => n + Math.max(1, Math.ceil(p.length / per)), 0);
  return lines * lineH;
}
const bodyH = (t: string, w: number) => textHeight(t, w, 10.4, 25);
const titleH = (t: string, w: number) => textHeight(t, w, 14.5, 31);
const monoH = (t: string, w: number) => textHeight(t, w, 12.6, 25);

const visible = <T extends RoomRow>(rows: T[] | undefined): T[] =>
  (rows ?? []).filter((r) => r.clientVisible !== false && !r.placeholder).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

const short = (id: string) => String(id).replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "x";

export async function roomToSteps(room: RoomIn, measure?: MeasureImage): Promise<Op[][]> {
  const steps: Op[][] = [];
  const idOf = (name: string) => `${ROOM_PREFIX}${name}`.slice(0, 64);
  const push = (ops: Op[]) => { if (ops.length) steps.push(ops); };

  /** Outline rectangle + title + body (+ link, + image underneath). Returns the card's height. One step. */
  async function card(
    cardId: string, x: number, y: number, w: number, color: Color, title: string, body: string,
    extra: { link?: string | null; image?: string | null } = {},
  ): Promise<number> {
    const inner = w - PAD * 2;
    const th = titleH(title, inner);
    const bh = body ? bodyH(body, inner) + 8 : 0;
    const link = extra.link ? clip(extra.link, 120) : "";
    const lh = link ? monoH(link, inner) + 8 : 0;
    let imgW = 0;
    let imgH = 0;
    if (extra.image) {
      const size = measure ? await measure(extra.image).catch(() => null) : null;
      imgW = inner;
      imgH = Math.round(size && size.w > 0 ? Math.min(inner * (size.h / size.w), inner * 2.2) : inner * 0.66);
    }
    const h = PAD + th + bh + lh + (imgH ? imgH + 14 : 0) + PAD + 10;
    const ops: Op[] = [{ type: "add_shape", id: cardId, kind: "rectangle", x, y, w, h, color }];
    let cy = y + PAD;
    ops.push({ type: "add_text", id: `${cardId}-t`, text: title, x: x + PAD, y: cy, w: inner, size: "m", font: "draw", color: color === "yellow" ? "black" : color });
    cy += th;
    if (body) {
      ops.push({ type: "add_text", id: `${cardId}-b`, text: body, x: x + PAD, y: cy, w: inner, size: "s", font: "sans", color: "black" });
      cy += bh;
    }
    if (link) {
      ops.push({ type: "add_text", id: `${cardId}-l`, text: link, x: x + PAD, y: cy, w: inner, size: "s", font: "mono", color: "blue" });
      cy += lh;
    }
    if (extra.image) ops.push({ type: "add_image", id: `${cardId}-i`, src: extra.image, x: x + PAD, y: cy + 6, w: imgW, h: imgH });
    if (extra.link) ops.push({ type: "update", id: cardId, props: { url: extra.link } });
    push(ops);
    return h;
  }

  /** A lane heading: big hand-written label. */
  const label = (labelId: string, text: string, x: number, y: number, color: Color = "black") =>
    push([{ type: "add_text", id: idOf(labelId), text, x, y, w: 520, size: "xl", font: "draw", color }]);

  /** Lay cards into `cols` columns, always into the shortest one. Returns the lane's bottom edge. */
  async function masonry(
    x0: number, y0: number, cols: number, items: { id: string; color: Color; title: string; body: string; link?: string | null; image?: string | null }[],
  ): Promise<number> {
    const heights = Array.from({ length: cols }, () => y0);
    for (const it of items) {
      const c = heights.indexOf(Math.min(...heights));
      const h = await card(idOf(it.id), x0 + c * (COL_W + GAP), heights[c], COL_W, it.color, it.title, it.body, { link: it.link, image: it.image });
      heights[c] += h + GAP;
    }
    return Math.max(y0, ...heights) - GAP;
  }

  // ---- title card ----
  const name = clip(room.name, 80) || "Project";
  const blurb = clip(room.blurb, 280);
  const titleW = 520;
  const nameH = titleH(name, titleW - PAD * 2) + 24;
  const blurbH = blurb ? bodyH(blurb, titleW - PAD * 2) + 8 : 0;
  const titleCardH = PAD + 26 + nameH + blurbH + PAD + 6;
  push([
    { type: "add_shape", id: idOf("title"), kind: "rectangle", x: 0, y: 0, w: titleW, h: titleCardH, color: "orange" },
    { type: "add_text", id: idOf("title-k"), text: "project room", x: PAD, y: PAD, w: titleW - PAD * 2, size: "s", font: "mono", color: "grey" },
    { type: "add_text", id: idOf("title-n"), text: name, x: PAD, y: PAD + 30, w: titleW - PAD * 2, size: "xl", font: "draw", color: "black" },
    ...(blurb ? [{ type: "add_text", id: idOf("title-b"), text: blurb, x: PAD, y: PAD + 30 + nameH, w: titleW - PAD * 2, size: "s", font: "sans", color: "black" } as Op] : []),
  ]);

  // ---- overview lane + findings lane, side by side ----
  const sections = visible(room.sections);
  const findings = visible(room.findings);
  const overviewX = titleW + 100;
  const findingsX = overviewX + 2 * COL_W + GAP + LANE_GAP;
  const top = LABEL_H;
  let laneBottom = titleCardH;

  if (sections.length) {
    label("overview-label", "Overview", overviewX, -8, "orange");
    const bottom = await masonry(overviewX, top, 2, sections.map((s) => ({ id: `s-${short(s.id)}`, color: "black" as Color, title: clip(s.title, 140), body: clip(s.body, 4000) })));
    laneBottom = Math.max(laneBottom, bottom);
  }
  if (findings.length) {
    label("findings-label", "Findings", findingsX, -8, "blue");
    const bottom = await masonry(findingsX, top, 2, findings.map((f) => ({
      id: `f-${short(f.id)}`, color: "blue" as Color, title: clip(f.title, 140), body: clip(f.body, 4000), link: f.href, image: f.imageUrl,
    })));
    laneBottom = Math.max(laneBottom, bottom);
  }

  // ---- screenshots lane, right of the findings ----
  const shots = (room.shots ?? []).filter((x) => x.src);
  if (shots.length) {
    const shotsX = findingsX + 2 * COL_W + GAP + LANE_GAP;
    label("shots-label", "Screenshots", shotsX, -8, "violet");
    const bottom = await masonry(shotsX, top, 2, shots.map((x) => ({
      id: `p-${short(x.id)}`, color: "violet" as Color, title: clip(x.title, 140), body: clip(x.body, 600), link: x.href, image: x.src,
    })));
    laneBottom = Math.max(laneBottom, bottom);
  }

  // ---- opportunities: one swimlane per board column, cards left to right (wrapping), so the board stays landscape ----
  const columns = [...(room.columns ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const cards = visible(room.cards);
  const topBottom = laneBottom;
  const oppY = laneBottom + LANE_GAP;
  let oppBottom = oppY;
  const PER_ROW = 5;
  if (columns.length && cards.length) {
    label("opps-label", "Opportunities", 0, oppY - 8, "violet");
    let y = oppY + LABEL_H;
    let i = 0;
    for (const col of columns) {
      const mine = cards.filter((c) => c.columnId === col.id);
      const color = COLUMN_COLORS[i % COLUMN_COLORS.length];
      i++;
      if (!mine.length) continue;
      push([{ type: "add_text", id: idOf(`c-${short(col.id)}-h`), text: clip(col.title, 40), x: 0, y, w: COL_W, size: "m", font: "draw", color }]);
      y += 52;
      for (let at = 0; at < mine.length; at += PER_ROW) {
        let rowH = 0;
        for (const [n, c] of mine.slice(at, at + PER_ROW).entries()) {
          const h = await card(idOf(`k-${short(c.id)}`), n * (COL_W + GAP), y, COL_W, color, clip(c.title, 140), clip(c.body, 4000));
          rowH = Math.max(rowH, h);
        }
        y += rowH + GAP;
      }
      y += GAP;
      oppBottom = y - GAP * 2;
    }
  }

  // ---- sketch: drawn strokes, or just its note, under the swimlanes ----
  const drawing = visible(room.drawings)[0] ?? (room.drawings ?? []).find((d) => d.clientVisible !== false && (d.strokes?.length ?? 0) > 0);
  if (drawing && ((drawing.strokes?.length ?? 0) > 0 || clip(drawing.note, 800))) {
    const sx = 0;
    const sy = (oppBottom > oppY ? oppBottom : topBottom) + LANE_GAP;
    label("sketch-label", clip(drawing.title, 60) || "Sketches", sx, sy - 8, "green");
    const note = clip(drawing.note, 800);
    if (drawing.strokes?.length) {
      const W = 800;
      const sc = W / 1000; // the room's sketch surface is 1000 wide
      push([{ type: "add_shape", id: idOf("sketch"), kind: "rectangle", x: sx, y: sy + LABEL_H, w: W, h: W * 0.62, color: "green" }]);
      for (const [n, s] of drawing.strokes.entries()) {
        const pts = s.points.slice(0, 500).map(([px, py]) => ({ x: Math.round(sx + px * sc), y: Math.round(sy + LABEL_H + py * sc) }));
        if (pts.length >= 2) push([{ type: "draw", id: idOf(`sk-${n}`), points: pts, size: "m", color: "black" }]);
      }
      if (note) push([{ type: "add_text", id: idOf("sketch-n"), text: note, x: sx, y: sy + LABEL_H + W * 0.62 + 24, w: W, size: "s", font: "draw", color: "orange" }]);
    } else if (note) {
      await card(idOf("sketch"), sx, sy + LABEL_H, COL_W, "green", clip(drawing.title, 140) || "Sketches", note);
    }
  }

  // open on the top band (title, overview, findings, screenshots) at a readable zoom; the rest is a scroll away
  const topRight = (shots.length ? findingsX + 2 * COL_W + GAP + LANE_GAP : findings.length ? findingsX : overviewX) + 2 * COL_W + GAP;
  push([{ type: "focus", box: { x: -40, y: -80, w: topRight + 80, h: topBottom + 140 } }]);

  return steps;
}

export const roomToOps = async (room: RoomIn, measure?: MeasureImage): Promise<Op[]> => (await roomToSteps(room, measure)).flat();
