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
  /** Flows, cycles and hubs drawn as boxes joined by arrows. */
  diagrams?: DiagramIn[];
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
    diagrams: Array.isArray(p.diagrams) ? p.diagrams : [],
    sections: (p.sections ?? []).map((x: any) => ({ ...vis(x), title: String(x.title), body: String(x.body ?? "") })),
    drawings: (p.drawings ?? []).map((d: any) => ({ ...vis(d), title: String(d.title ?? ""), note: String(d.note ?? ""), strokes: d.strokes ?? [] })),
  };
}

export interface DiagramNode { id: string; text: string; sub?: string; color?: string; kind?: "box" | "oval" }
export interface ChartRow { label: string; value: number; /** shown after the bar, e.g. "4.0" or "~3,200" */ display?: string; /** small line under the label */ sub?: string; /** orange to highlight the row the chart is about, grey otherwise */ color?: string }
export interface GalleryImage { src: string; caption: string; /** a hand-written remark under the caption */ note?: string }
export interface DiagramIn {
  id: string;
  title: string;
  /**
   * flow: left to right, wrapping. cycle: clockwise ring, last arrow closes it. hub: the first node in the middle, the rest around it.
   * bars: a horizontal bar chart from `rows`. gallery: a row of screenshots from `images`, numbered, with captions.
   */
  layout: "flow" | "cycle" | "hub" | "bars" | "gallery";
  nodes?: DiagramNode[];
  rows?: ChartRow[];
  /** bars: the value a full-width bar stands for (default: the largest row) */
  max?: number;
  images?: GalleryImage[];
  /** default: the chain for flow, the ring for cycle, centre -> each spoke for hub */
  edges?: { from: string; to: string; label?: string }[];
  note?: string;
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

/** A card on the board shows the opening of a long note; the full text lives on the room's Notes page. */
const BOARD_BODY_MAX = 620;
function boardClip(raw: unknown): string {
  const t = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (t.length <= BOARD_BODY_MAX) return t;
  // whole paragraphs while they fit, else cut the first one at a sentence
  const paras = t.split(/\n{2,}/);
  let out = "";
  for (const p of paras) {
    const next = out ? `${out}\n\n${p}` : p;
    if (next.length > BOARD_BODY_MAX) break;
    out = next;
  }
  if (!out) {
    const cut = t.slice(0, BOARD_BODY_MAX);
    const end = cut.lastIndexOf(". ");
    out = end > BOARD_BODY_MAX * 0.5 ? cut.slice(0, end + 1) : cut.trimEnd();
  }
  return `${out}\n…more on the Notes page`;
}
const WIDE_AT = 460; // a note this long gets a card two columns wide

const visible = <T extends RoomRow>(rows: T[] | undefined): T[] =>
  (rows ?? []).filter((r) => r.clientVisible !== false && !r.placeholder).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

const short = (id: string) => String(id).replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "x";


const COLORS = new Set(["black", "grey", "red", "orange", "yellow", "green", "blue", "violet"]);
const asColor = (c: unknown, fallback: Color): Color => (typeof c === "string" && COLORS.has(c) ? (c as Color) : fallback);

const NODE_W = 270;
const NODE_GAP = 100;
const FRAME_PAD = 56;
const FLOW_PER_ROW = 5;

/**
 * One diagram -> ops, drawn inside a dashed frame at (ox, oy). Nodes go first and arrows in a later step, so an arrow's
 * endpoints always exist when it is applied. Returns the frame's size so the caller can place the next one.
 */
function drawDiagram(d: DiagramIn, ox: number, oy: number, idOf: (n: string) => string): { steps: Op[][]; w: number; h: number } {
  const nodes = (d.nodes ?? []).slice(0, 12);
  const key = short(d.id);
  const nid = (i: number) => idOf(`g-${key}-n${i}`);
  const label = (n: DiagramNode) => [clip(n.text, 60), n.sub ? clip(n.sub, 110) : ""].filter(Boolean).join("\n");
  const lines = (t: string) => t.split("\n").reduce((n, p) => n + Math.max(1, Math.ceil(p.length / 17)), 0);
  const nodeH = Math.max(120, ...nodes.map((n) => 44 + lines(label(n)) * 31));
  const place: { x: number; y: number; w: number; h: number }[] = [];
  const TOP = 96; // room for the diagram's title inside the frame

  let w = 0;
  let h = 0;
  if (d.layout === "cycle" && nodes.length > 1) {
    // nodes sit on an ellipse; (x, y) is each box's top-left, so the ring's left-most box starts at 0
    const rx = Math.max(380, nodes.length * 95);
    const ry = Math.max(230, nodes.length * 52);
    nodes.forEach((_, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / nodes.length;
      place.push({ x: rx + Math.cos(a) * rx, y: ry + Math.sin(a) * ry, w: NODE_W, h: nodeH });
    });
    w = rx * 2 + NODE_W;
    h = ry * 2 + nodeH;
  } else if (d.layout === "hub" && nodes.length > 1) {
    const spokes = nodes.length - 1;
    const rx = Math.max(430, spokes * 125);
    const ry = Math.round(rx * 0.78);
    const cx = rx + NODE_W / 2;
    const cy = ry + nodeH / 2;
    place.push({ x: cx - 120, y: cy - 70, w: 240, h: 140 });
    for (let i = 0; i < spokes; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / spokes;
      place.push({ x: rx + Math.cos(a) * rx, y: ry + Math.sin(a) * ry, w: NODE_W, h: nodeH });
    }
    w = rx * 2 + NODE_W;
    h = ry * 2 + nodeH;
  } else {
    const perRow = Math.min(FLOW_PER_ROW, Math.max(nodes.length, 1));
    nodes.forEach((_, i) => {
      const row = Math.floor(i / perRow);
      place.push({ x: (i % perRow) * (NODE_W + NODE_GAP), y: row * (nodeH + 90), w: NODE_W, h: nodeH });
    });
    const rows = Math.ceil(nodes.length / perRow) || 1;
    w = perRow * NODE_W + (perRow - 1) * NODE_GAP;
    h = rows * nodeH + (rows - 1) * 90;
  }

  const fx = ox;
  const fy = oy;
  const frameW = w + FRAME_PAD * 2;
  const frameH = h + FRAME_PAD * 2 + TOP;
  const bx = fx + FRAME_PAD;
  const by = fy + FRAME_PAD + TOP;
  const note = d.note ? clip(d.note, 240) : "";
  const noteH = note ? bodyH(note, frameW - FRAME_PAD * 2) + 24 : 0;

  const first: Op[] = [
    { type: "add_shape", id: idOf(`g-${key}-frame`), kind: "rectangle", x: fx, y: fy, w: frameW, h: frameH + noteH, color: "grey" },
    { type: "add_text", id: idOf(`g-${key}-title`), text: clip(d.title, 70), x: fx + FRAME_PAD, y: fy + 26, w: frameW - FRAME_PAD * 2, size: "l", font: "draw", color: "black" },
  ];
  if (note) first.push({ type: "add_text", id: idOf(`g-${key}-note`), text: note, x: fx + FRAME_PAD, y: fy + frameH + 4, w: frameW - FRAME_PAD * 2, size: "s", font: "draw", color: "orange" });
  const nodeOps: Op[] = nodes.map((n, i) => ({
    type: "add_shape", id: nid(i), kind: n.kind === "oval" || (d.layout === "hub" && i === 0) ? "ellipse" : "rectangle",
    x: Math.round(bx + place[i].x), y: Math.round(by + place[i].y), w: place[i].w, h: place[i].h,
    text: label(n), color: asColor(n.color, d.layout === "hub" && i === 0 ? "orange" : "black"),
  }) as Op);

  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const edges: { from: string; to: string; label?: string }[] = d.edges?.length
    ? d.edges
    : d.layout === "hub"
      ? nodes.slice(1).map((n) => ({ from: nodes[0].id, to: n.id }))
      : nodes.slice(0, d.layout === "cycle" ? nodes.length : nodes.length - 1).map((n, i) => ({ from: n.id, to: nodes[(i + 1) % nodes.length].id }));
  const arrows: Op[] = [];
  edges.forEach((e, i) => {
    if (!index.has(e.from) || !index.has(e.to) || e.from === e.to) return;
    arrows.push({ type: "add_arrow", id: idOf(`g-${key}-a${i}`), from: nid(index.get(e.from)!), to: nid(index.get(e.to)!), ...(e.label ? { label: clip(e.label, 40) } : {}), color: "grey" } as Op);
  });
  return { steps: [first, nodeOps, arrows], w: frameW, h: frameH + noteH };
}

// ---------------------------------------------------------------- charts and galleries

const BAR_W = 760;
const LABEL_W = 340;
const BAR_H = 46;
const ROW_PITCH = 88;
const VALUE_W = 260;

/** A horizontal bar chart: one measure, rows in the order given (sort them), the value written at the end of each bar. */
function drawBars(d: DiagramIn, ox: number, oy: number, idOf: (n: string) => string): { steps: Op[][]; w: number; h: number } {
  const rows = (d.rows ?? []).slice(0, 12);
  const key = short(d.id);
  const id = (n: string) => idOf(`b-${key}-${n}`);
  const TOP = 96;
  const max = d.max && d.max > 0 ? d.max : Math.max(...rows.map((r) => r.value), 1);
  const w = LABEL_W + 28 + BAR_W + VALUE_W;
  const h = Math.max(rows.length, 1) * ROW_PITCH;
  const frameW = w + FRAME_PAD * 2;
  const frameH = h + FRAME_PAD * 2 + TOP - 30;
  const bx = ox + FRAME_PAD;
  const by = oy + FRAME_PAD + TOP - 20;
  const note = d.note ? clip(d.note, 260) : "";
  const noteH = note ? bodyH(note, frameW - FRAME_PAD * 2) + 24 : 0;

  const first: Op[] = [
    { type: "add_shape", id: id("frame"), kind: "rectangle", x: ox, y: oy, w: frameW, h: frameH + noteH, color: "grey" },
    { type: "add_text", id: id("title"), text: clip(d.title, 70), x: ox + FRAME_PAD, y: oy + 26, w: frameW - FRAME_PAD * 2, size: "l", font: "draw", color: "black" },
  ];
  if (note) first.push({ type: "add_text", id: id("note"), text: note, x: ox + FRAME_PAD, y: oy + frameH + 4, w: frameW - FRAME_PAD * 2, size: "s", font: "draw", color: "orange" });
  const marks: Op[] = [];
  const fills: Op[] = [];
  rows.forEach((r, i) => {
    const y = by + i * ROW_PITCH;
    const bw = Math.max(10, Math.round((Math.max(r.value, 0) / max) * BAR_W));
    const color = asColor(r.color, "grey");
    marks.push({ type: "add_text", id: id(`l${i}`), text: clip(r.label, 44), x: bx, y: y + (r.sub ? 0 : 8), w: LABEL_W, size: "m", font: "draw", color: "black", align: "end" } as Op);
    if (r.sub) marks.push({ type: "add_text", id: id(`s${i}`), text: clip(r.sub, 48), x: bx, y: y + 34, w: LABEL_W, size: "s", font: "mono", color: "grey", align: "end" } as Op);
    marks.push({ type: "add_shape", id: id(`r${i}`), kind: "rectangle", x: bx + LABEL_W + 28, y, w: bw, h: BAR_H, color });
    marks.push({ type: "add_text", id: id(`v${i}`), text: clip(r.display ?? String(r.value), 24), x: bx + LABEL_W + 28 + bw + 18, y: y + 8, w: VALUE_W - 20, size: "m", font: "draw", color: color === "grey" ? "black" : color });
    fills.push({ type: "update", id: id(`r${i}`), props: { fill: "pattern" } });
  });
  return { steps: [first, marks, fills], w: frameW, h: frameH + noteH };
}

/** A row of screenshots with a numbered caption under each, and an optional hand-written remark. */
async function drawGallery(d: DiagramIn, ox: number, oy: number, idOf: (n: string) => string, measure?: MeasureImage): Promise<{ steps: Op[][]; w: number; h: number }> {
  const imgs = (d.images ?? []).filter((i) => i.src).slice(0, 10);
  const key = short(d.id);
  const id = (n: string) => idOf(`v-${key}-${n}`);
  const TOP = 96;
  const sizes = await Promise.all(imgs.map((i) => (measure ? measure(i.src).catch(() => null) : Promise.resolve(null))));
  const ratios = sizes.map((s) => (s && s.w > 0 ? Math.min(s.h / s.w, 2.4) : 1.6));
  const portrait = ratios.reduce((a, b) => a + b, 0) / Math.max(ratios.length, 1) > 1.15;
  const gw = portrait ? 300 : 560;
  const gap = 44;
  const heights = ratios.map((r) => Math.round(gw * r));
  const imgH = Math.max(...heights, 120);
  const capH = Math.max(...imgs.map((i, n) => titleH(`${n + 1}. ${clip(i.caption, 90)}`, gw, ) + 10), 40);
  const noteH = Math.max(...imgs.map((i) => (i.note ? bodyH(clip(i.note, 200), gw) + 14 : 0)), 0);
  const w = imgs.length * gw + Math.max(imgs.length - 1, 0) * gap;
  const frameW = w + FRAME_PAD * 2;
  const frameH = TOP + imgH + 20 + capH + noteH + FRAME_PAD;
  const bx = ox + FRAME_PAD;
  const by = oy + TOP;

  const first: Op[] = [
    { type: "add_shape", id: id("frame"), kind: "rectangle", x: ox, y: oy, w: frameW, h: frameH, color: "grey" },
    { type: "add_text", id: id("title"), text: clip(d.title, 80), x: ox + FRAME_PAD, y: oy + 26, w: frameW - FRAME_PAD * 2, size: "l", font: "draw", color: "black" },
  ];
  const pics: Op[] = [];
  imgs.forEach((im, i) => {
    const x = bx + i * (gw + gap);
    pics.push({ type: "add_image", id: id(`i${i}`), src: im.src, x, y: by, w: gw, h: heights[i] });
    pics.push({ type: "add_shape", id: id(`r${i}`), kind: "rectangle", x, y: by, w: gw, h: heights[i], color: "black" }); // an ink border over the picture
    pics.push({ type: "add_text", id: id(`c${i}`), text: `${i + 1}. ${clip(im.caption, 90)}`, x, y: by + imgH + 20, w: gw, size: "m", font: "draw", color: "black" });
    if (im.note) pics.push({ type: "add_text", id: id(`n${i}`), text: clip(im.note, 200), x, y: by + imgH + 20 + capH, w: gw, size: "s", font: "draw", color: "orange" });
  });
  return { steps: [first, pics], w: frameW, h: frameH };
}

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

  /** Lay cards into `cols` columns, always into the shortest one; long notes span two. Returns the lane's bottom edge. */
  async function masonry(
    x0: number, y0: number, cols: number, items: { id: string; color: Color; title: string; body: string; link?: string | null; image?: string | null }[],
  ): Promise<number> {
    const heights = Array.from({ length: cols }, () => y0);
    for (const it of items) {
      const wide = cols >= 2 && it.body.length > WIDE_AT;
      let c = 0;
      if (wide) {
        let best = Infinity;
        for (let i = 0; i + 1 < cols; i++) { const m = Math.max(heights[i], heights[i + 1]); if (m < best) { best = m; c = i; } }
      } else {
        c = heights.indexOf(Math.min(...heights));
      }
      const y = wide ? Math.max(heights[c], heights[c + 1]) : heights[c];
      const w = wide ? COL_W * 2 + GAP : COL_W;
      const h = await card(idOf(it.id), x0 + c * (COL_W + GAP), y, w, it.color, it.title, it.body, { link: it.link, image: it.image });
      heights[c] = y + h + GAP;
      if (wide) heights[c + 1] = y + h + GAP;
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
    const bottom = await masonry(overviewX, top, 2, sections.map((s) => ({ id: `s-${short(s.id)}`, color: "black" as Color, title: clip(s.title, 140), body: boardClip(s.body) })));
    laneBottom = Math.max(laneBottom, bottom);
  }
  if (findings.length) {
    label("findings-label", "Findings", findingsX, -8, "blue");
    const bottom = await masonry(findingsX, top, 2, findings.map((f) => ({
      id: `f-${short(f.id)}`, color: "blue" as Color, title: clip(f.title, 140), body: boardClip(f.body), link: f.href, image: f.imageUrl,
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

  // ---- diagrams: flows, cycles and hubs, two or three to a row ----
  const diagrams = (room.diagrams ?? []).filter((d) =>
    d && ((d.layout === "bars" && (d.rows?.length ?? 0) > 0) || (d.layout === "gallery" && (d.images?.length ?? 0) > 0) || (Array.isArray(d.nodes) && d.nodes.length > 1)));
  const draw = async (d: DiagramIn, x: number, y: number) =>
    d.layout === "bars" ? drawBars(d, x, y, idOf) : d.layout === "gallery" ? drawGallery(d, x, y, idOf, measure) : drawDiagram(d, x, y, idOf);
  let belowTop = laneBottom;
  if (diagrams.length) {
    const gy = laneBottom + LANE_GAP;
    label("diagrams-label", "Visuals", 0, gy - 8, "green");
    const ROW_MAX = 3500;
    let x = 0;
    let y = gy + LABEL_H;
    let rowH = 0;
    for (const d of diagrams) {
      const probe = await draw(d, 0, 0);
      if (x > 0 && x + probe.w > ROW_MAX) { x = 0; y += rowH + 130; rowH = 0; }
      const drawn = await draw(d, x, y);
      for (const step of drawn.steps) push(step);
      x += drawn.w + 130;
      rowH = Math.max(rowH, drawn.h);
    }
    belowTop = y + rowH;
  }

  // ---- opportunities: one swimlane per board column, cards left to right (wrapping), so the board stays landscape ----
  const columns = [...(room.columns ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const cards = visible(room.cards);
  const topBottom = laneBottom;
  const oppY = belowTop + LANE_GAP;
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
          const h = await card(idOf(`k-${short(c.id)}`), n * (COL_W + GAP), y, COL_W, color, clip(c.title, 140), boardClip(c.body));
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
    const sy = (oppBottom > oppY ? oppBottom : belowTop) + LANE_GAP;
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

  // open on the title and the overview at a zoom you can read on a call; the other lanes are one chip away
  const openRight = (sections.length ? overviewX + 2 * COL_W + GAP : titleW) + 40;
  push([{ type: "focus", box: { x: -40, y: -90, w: openRight + 40, h: 700 } }]);

  return steps;
}

export const roomToOps = async (room: RoomIn, measure?: MeasureImage): Promise<Op[]> => (await roomToSteps(room, measure)).flat();
