/* eslint-disable @typescript-eslint/no-explicit-any -- leads.json is untyped JSON read defensively */
// Pure converter: a leads.json document (leads/ module at the repo root) -> canvas Op[] for a "Leads" lane.
// Existing ops only: add_shape (rectangle), add_text, add_arrow (ICP -> segments), update (card link), say, focus.
// Layout is computed here (no editor): ICP card + segments, source cards with their search URLs as text,
// the shortlist (live leads or the empty template), outreach drafts, the 7-day cadence. The lane starts at
// opts.originY, which push-leads.mjs sets below whatever is already on the board (see stateBounds).
// No I/O. Only erasable TypeScript here so Node can import this file directly.

import type { Op } from "./ops";

export interface LeadsToOpsOptions {
  /** left edge of the lane (default 0) */
  originX?: number;
  /** top edge of the lane (default 0) */
  originY?: number;
  /** shape-id prefix; push-leads uses it to find and replace an earlier lane (default "ld-") */
  idPrefix?: string;
  /** max search URLs printed under each source card (default 2) */
  urlsPerSource?: number;
}

export const LANE_PREFIX = "ld-";

const COL_W = 440;
const GAP = 36;
const COLS = 3;
const PAD = 16;
const LANE_W = COL_W * COLS + GAP * (COLS - 1);

type Color = "black" | "grey" | "red" | "orange" | "yellow" | "green" | "blue" | "violet";

const TYPE_COLOR: Record<string, Color> = {
  reddit: "orange", x: "black", hn: "orange", producthunt: "red", indiehackers: "blue",
  community: "violet", newsletter: "green", creator: "violet", intent: "blue", competitor: "red",
};
const TYPE_TITLE: Record<string, string> = {
  reddit: "Reddit", x: "X", hn: "Hacker News", producthunt: "Product Hunt", indiehackers: "Indie Hackers",
  community: "Communities", newsletter: "Newsletters", creator: "Creator archetypes", intent: "Intent phrases", competitor: "Competitor complaints",
};
const TYPE_ORDER = Object.keys(TYPE_TITLE);

const clip = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

/** Rough wrapped height for a text block: lines * lineHeight. Over-estimates on purpose so cards never overlap. */
function textHeight(text: string, width: number, charW: number, lineH: number): number {
  const per = Math.max(8, Math.floor(width / charW));
  const lines = String(text)
    .split("\n")
    .reduce((n, p) => n + Math.max(1, Math.ceil(p.length / per)), 0);
  return lines * lineH;
}

// sizes in px for the markup text sizes: s = 18px. Sans ~9.4px/char, mono ~11px/char (+margin).
const bodyH = (t: string, w: number) => textHeight(t, w, 9.8, 25);
const monoH = (t: string, w: number) => textHeight(t, w, 12.6, 25);
const titleH = (t: string, w: number) => textHeight(t, w, 14, 31);

/**
 * Live extents of a board from GET /api/state envelopes, plus every live shape id (arrows and bubbles have
 * no extent but still need deleting on --replace). Unknown sizes use conservative defaults.
 */
export function stateBounds(envelopes: Array<{ op: any }>): { minX: number; maxX: number; maxY: number; ids: string[] } | null {
  const live = new Map<string, { x: number; y: number; w: number; h: number }>();
  const extra = new Set<string>();
  for (const { op } of envelopes ?? []) {
    if (!op) continue;
    if (op.type === "clear") { live.clear(); extra.clear(); }
    else if (op.type === "delete" && op.id) { live.delete(op.id); extra.delete(op.id); }
    else if (op.type === "move" && live.has(op.id)) Object.assign(live.get(op.id)!, { x: op.x, y: op.y });
    else if (op.id && typeof op.type === "string" && op.type !== "update") {
      if (typeof op.x === "number" && typeof op.y === "number") {
        let w = op.w, h = op.h;
        if (op.type === "add_image") { w ??= 520; h ??= w * 1.7; }
        else if (op.type === "add_video") { w ??= 640; h ??= 360; }
        else if (op.type === "add_finding") { w = 360; h = 300; }
        else if (op.type === "add_shape") { w ??= op.kind === "note" ? 200 : 160; h ??= op.kind === "note" ? 200 : 100; }
        else if (op.type === "add_text") { w ??= 360; h ??= 140; }
        else if (op.type === "say") { extra.add(op.id); continue; }
        else continue;
        live.set(op.id, { x: op.x, y: op.y, w, h });
      } else if (["add_arrow", "arrow_to", "say", "draw", "highlight", "annotate", "group"].includes(op.type)) extra.add(op.id);
    }
  }
  if (!live.size && !extra.size) return null;
  let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of live.values()) {
    minX = Math.min(minX, b.x);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (!live.size) { minX = 0; maxX = 0; maxY = 0; }
  return { minX, maxX, maxY, ids: [...live.keys(), ...extra] };
}

export function leadsToSteps(doc: any, opts: LeadsToOpsOptions = {}): Op[][] {
  const ox = opts.originX ?? 0;
  const oy = opts.originY ?? 0;
  const P = opts.idPrefix ?? LANE_PREFIX;
  const urlsPerSource = opts.urlsPerSource ?? 2;
  const steps: Op[][] = [];
  const id = (name: string) => `${P}${name}`.slice(0, 64);

  /** A card: outline rectangle + title + body (+ mono url lines). Returns its id and height. One step. */
  function card(cardId: string, x: number, y: number, w: number, color: Color, title: string, body: string, urls: string[] = [], linkUrl?: string): number {
    const inner = w - PAD * 2;
    const th = titleH(title, inner);
    const bh = body ? bodyH(body, inner) + 6 : 0;
    const uh = urls.reduce((s, u) => s + monoH(u, inner) + 6, 0);
    const h = PAD + th + bh + uh + PAD + 14;
    const ops: Op[] = [{ type: "add_shape", id: cardId, kind: "rectangle", x, y, w, h, color }];
    let cy = y + PAD;
    ops.push({ type: "add_text", id: `${cardId}-t`, text: title, x: x + PAD, y: cy, w: inner, size: "m", font: "draw", color: color === "yellow" ? "black" : color });
    cy += th;
    if (body) {
      ops.push({ type: "add_text", id: `${cardId}-b`, text: body, x: x + PAD, y: cy, w: inner, size: "s", font: "sans", color: "black" });
      cy += bh;
    }
    urls.forEach((u, i) => {
      ops.push({ type: "add_text", id: `${cardId}-u${i}`, text: u, x: x + PAD, y: cy, w: inner, size: "s", font: "mono", color: "blue" });
      cy += monoH(u, inner) + 6;
    });
    // tldraw shows a clickable link badge on a shape that has a url prop; `update` passes it through
    if (linkUrl) ops.push({ type: "update", id: cardId, props: { url: linkUrl } });
    steps.push(ops);
    return h;
  }

  /** Lay cards out in rows of COLS; row height = tallest card. Returns the y after the block. */
  function grid(y: number, items: Array<{ id: string; color: Color; title: string; body: string; urls?: string[]; link?: string }>): { y: number; ids: string[] } {
    const ids: string[] = [];
    for (let i = 0; i < items.length; i += COLS) {
      let rowH = 0;
      items.slice(i, i + COLS).forEach((it, c) => {
        const h = card(it.id, ox + c * (COL_W + GAP), y, COL_W, it.color, it.title, it.body, it.urls, it.link);
        rowH = Math.max(rowH, h);
        ids.push(it.id);
      });
      y += rowH + GAP;
    }
    return { y, ids };
  }

  function heading(headId: string, y: number, text: string, size: "xl" | "l" = "xl", color: Color = "black"): number {
    steps.push([{ type: "add_text", id: headId, text, x: ox, y, w: LANE_W, size, font: "draw", color }]);
    return y + (size === "xl" ? 64 : 48);
  }

  const product = doc.product ?? {};
  let y = oy;

  // ---- header
  const headerId = id("header");
  steps.push([
    { type: "add_text", id: headerId, text: `Leads: ${clip(product.name, 40)}`, x: ox, y, w: LANE_W, size: "xl", font: "draw", color: "black" },
    {
      type: "add_text", id: id("header-note"), x: ox, y: y + 60, w: LANE_W, size: "s", font: "sans", color: "grey",
      text: `${doc.mode === "mock" ? "Mock plan (no model ran). " : ""}Sources are recipes to verify, not leads. Only shortlist entries marked search-result came from a real search. Nothing posts or messages anyone; a human reviews and sends.`,
    },
  ]);
  y += 130;

  // ---- ICP
  const icp = doc.icp ?? { summary: "", segments: [], buyingTriggers: [] };
  const icpBody = `${clip(icp.summary, 420)}\n\nBuying triggers: ${(icp.buyingTriggers ?? []).map((t: string) => clip(t, 90)).join("; ")}`;
  const icpId = id("icp");
  y += card(icpId, ox, y, LANE_W, "green", "Ideal customer profile", icpBody) + 56;
  const segs = (icp.segments ?? []).map((s: any) => ({
    id: id(`seg-${s.id}`), color: "green" as Color, title: `${s.id} ${clip(s.name, 48)}`,
    body: `${clip(s.who, 140)}\nPain: ${clip(s.pain, 180)}\nTrigger: ${clip(s.trigger, 120)}\nFeatures: ${(s.featureIds ?? []).join(", ")}`,
  }));
  const segBlock = grid(y, segs);
  y = segBlock.y;
  const arrows: Op[] = segBlock.ids.map((to) => ({ type: "add_arrow", id: `${to}-a`, from: icpId, to, color: "green" }));
  steps.push(arrows);

  // ---- sources
  const sourcesHead = id("h-sources");
  y = heading(sourcesHead, y + 20, "Where to look (recipes, unverified)");
  for (const type of TYPE_ORDER) {
    const group = (doc.sources ?? []).filter((s: any) => s.type === type);
    if (!group.length) continue;
    y = heading(id(`h-${type}`), y, TYPE_TITLE[type], "l", TYPE_COLOR[type]);
    const items = group.map((s: any) => {
      const qs: any[] = s.queries ?? [];
      const body = [clip(s.why, 150), ...qs.slice(0, 3).map((q) => `- ${clip(q.q, 80)}`)].filter(Boolean).join("\n");
      const urls = qs.filter((q) => q.urls?.length).slice(0, urlsPerSource).map((q) => q.urls[0].url as string);
      const first = (s.links?.[0]?.url as string | undefined) ?? urls[0];
      return { id: id(`src-${s.id}`), color: TYPE_COLOR[s.type] ?? "black", title: clip(s.name, 44), body, urls: urls.length ? urls : (s.links ?? []).slice(0, 1).map((l: any) => l.url as string), link: first };
    });
    y = grid(y, items).y;
  }

  // ---- shortlist
  const shortHead = id("h-shortlist");
  y = heading(shortHead, y + 20, "Shortlist (score fit + intent + reach, then add recency)");
  const leads: any[] = doc.shortlist?.leads ?? [];
  if (!leads.length) {
    y += card(id("shortlist-template"), ox, y, LANE_W, "grey", "No live leads yet. Fill these fields by hand from the recipes above:",
      `${(doc.shortlist?.fields ?? []).join(" | ")}\n\n${doc.shortlist?.scoring?.scale ?? ""} ${doc.shortlist?.scoring?.honesty ?? ""}`) + GAP;
  } else {
    const items = leads.slice(0, 12).map((l) => ({
      id: id(`lead-${l.id}`), color: "blue" as Color,
      title: `${l.score ? `${l.score.total}/${l.score.outOf ?? 8} ` : "unscored "}${clip(l.handle, 36)} (${l.platform})`,
      body: `${clip(l.title, 160)}\nWhy: ${clip(l.whyTheyFit, 140)}\nIntent: ${clip(l.intentSignal, 120)}\nFound via: ${clip(l.foundVia?.query, 70)}\nDraft: ${l.outreachId ?? "none"} | ${l.backing}, status: ${l.status}`,
      urls: [l.url as string], link: l.url as string,
    }));
    y = grid(y, items).y;
  }

  // ---- outreach
  const outHead = id("h-outreach");
  y = heading(outHead, y + 20, "Outreach drafts (replace {{EVIDENCE}} with what the agent observed)");
  const outItems = (doc.outreach ?? []).map((o: any) => ({
    id: id(`out-${o.id}`), color: "yellow" as Color, title: `${o.id} ${o.sourceType}`,
    body: `${o.subject && o.subject !== "(none)" ? `Subject: ${clip(o.subject, 80)}\n` : ""}${clip(o.draft, 520)}\n\nEvidence: ${clip(o.evidenceSlot, 140)}`,
  }));
  y = grid(y, outItems).y;

  // ---- cadence
  const cadHead = id("h-cadence");
  y = heading(cadHead, y + 20, "Seven-day cadence");
  grid(y, (doc.cadence ?? []).map((c: any) => ({
    id: id(`day-${c.day}`), color: "grey" as Color, title: `Day ${c.day}: ${clip(c.focus, 40)}`,
    body: `${(c.actions ?? []).map((a: string) => `- ${clip(a, 110)}`).join("\n")}\nTarget: ${clip(c.target, 80)}`,
  })));

  // ---- say + focus (agent presence, then bring the lane's top into view)
  const sources = (doc.sources ?? []).length;
  steps.push([
    {
      type: "say", id: id("say"), target: headerId,
      text: `${sources} places to look, ${doc.outreach?.length ?? 0} drafts, ${leads.length} live lead${leads.length === 1 ? "" : "s"}. Verify before you act.`,
    },
    { type: "focus", box: { x: ox - 40, y: oy - 40, w: LANE_W + 80, h: 1100 } },
  ]);

  return steps;
}

export function leadsToOps(doc: any, opts: LeadsToOpsOptions = {}): Op[] {
  return leadsToSteps(doc, opts).flat();
}
