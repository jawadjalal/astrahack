/* eslint-disable @typescript-eslint/no-explicit-any -- generator outputs (manifest, campaigns, ugc-plan) are untyped JSON read defensively */
// Pure converter: the launch kit (ad creatives + X/Reddit GTM campaigns + UGC plan) -> canvas Op[].
//
//   kitToOps({ ads, campaigns, ugcPlan }, { origin, srcMap, stepIds })
//
//   ads        manifest.json of `generate.mjs` (creatives[]), or just that array
//   campaigns  { x?: x-campaign.json, reddit?: reddit-campaign.json }  (or [{ channel, campaign }])
//   ugcPlan    ugc-plan.json (contract: ugc/schema.js)
//
// Output is a labelled lane below/beside a teardown: a banner, then 'Ad concepts', 'GTM posts', 'UGC concepts',
// each on a dashed backdrop. No I/O: hosted image URLs come from opts.srcMap / opts.srcFor (scripts/push-kit.mjs
// uploads the PNGs first). Nothing is invented: a lane with no input is left out, a field that is missing is left off.
// Only erasable TypeScript here so Node can import this file directly (same rule as runToOps.ts).

import type { Op } from "./ops";

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };

export interface KitInput {
  ads?: any;
  campaigns?: any;
  ugcPlan?: any;
}

export interface KitOptions {
  /** top-left of the whole kit in canvas px (default 0,0). push-kit.mjs computes it from GET /api/state. */
  origin?: Point;
  /** ad filename (manifest creative.filename) -> hosted src */
  srcMap?: Record<string, string>;
  srcFor?: (filename: string) => string | undefined;
  /** natural pixel size by ad filename, for exact aspect ratios */
  sizes?: Record<string, { w: number; h: number }>;
  /** ids that exist on the canvas (e.g. step-1 ... step-N). UGC cards arrow to evidence only when its step id is in here. */
  stepIds?: Iterable<string> | ((id: string) => boolean);
  /** evidence asset path (as in ugc-plan.json) -> canvas id. Default: leading digits of the file name, 003-x.png -> step-3 */
  stepIdFor?: (assetPath: string) => string | undefined;
  /** build a `say` op from a caption; undefined/null result = op not supported (see detectSayOp) */
  say?: ((text: string) => Op | null | undefined) | null;
  /** banner with the kit title and counts (default true; the MCP tools that add one lane pass false) */
  banner?: boolean;
  /** end with focus ops (default true) */
  focus?: boolean;
  /** Reddit drafts are 200-400 words; the card shows this many characters (default 700) */
  redditBodyChars?: number;
  /** max evidence arrows per UGC card (default 3) */
  maxEvidenceArrows?: number;
}

export interface KitResult {
  ops: Op[];
  /** every canvas id this kit creates, in order */
  ids: string[];
  /** bounding box of the whole kit */
  bounds: Box;
  /** per lane: its box, ids and counts */
  lanes: { key: "ads" | "gtm" | "ugc"; title: string; box: Box; ids: string[] }[];
  counts: { ads: number; xPosts: number; xThread: number; redditPosts: number; ugc: number; evidenceArrows: number };
}

// ---------------------------------------------------------------- layout constants (canvas px)

export const AD_W = 400;
export const X_CARD_W = 340;
export const THREAD_CARD_W = 290;
export const REDDIT_CARD_W = 560;
export const UGC_CARD_W = 480;
const CARD_GAP = 50;
const THREAD_GAP = 64; // room for the arrow between thread parts
const LANE_PAD = 60; // backdrop margin around lane content
const LANE_GAP = 170; // between lane backdrops
const HEADER_H = 150; // lane title + kicker
const ROW_GAP = 70;

// geo label text: tldraw size "s", font "sans" (set through an `update` op right after the add)
const CHAR_W = 8.9;
const LINE_H = 24.3;
const LABEL_PAD = 16;

/** ids created by the kit all carry one of these prefixes, so a re-push can find and delete them */
export const KIT_ID_PREFIXES = ["kit-", "ad-", "gtm-", "ugc-"];
export const isKitId = (id: string) => KIT_ID_PREFIXES.some((p) => id.startsWith(p));

// ---------------------------------------------------------------- small helpers

const clip = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/[ \t]+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};
const one = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
const slug = (s: unknown): string => String(s ?? "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** estimated rendered height of a geo label card of width w holding text */
export function cardHeight(text: string, w: number): number {
  const cpl = Math.max(8, Math.floor((w - LABEL_PAD * 2) / CHAR_W));
  const lines = text.split("\n").reduce((n, p) => n + Math.max(1, Math.ceil(p.length / cpl)), 0);
  return Math.ceil(LABEL_PAD * 2 + lines * LINE_H + 8);
}

/** wrapped free text (kind "text" with a width) is not boxed: height only matters for spacing */
function textHeight(text: string, w: number, lineH = 24, charW = 9.6): number {
  const cpl = Math.max(8, Math.floor(w / charW));
  return text.split("\n").reduce((n, p) => n + Math.max(1, Math.ceil(p.length / cpl)), 0) * lineH;
}

type Local = { ops: Op[]; ids: string[]; w: number; h: number };

const textStyle = (id: string, size: "s" | "m" | "l" | "xl", extra: Record<string, unknown> = {}): Op => ({ type: "update", id, props: { font: "sans", size, ...extra } });

function textOps(id: string, x: number, y: number, text: string, size: "s" | "m" | "l" | "xl", w?: number, color = "black"): Op[] {
  return [
    { type: "add_shape", id, kind: "text", x, y, text, color: color as any, ...(w ? { w } : {}) },
    textStyle(id, size),
  ];
}

interface CardSpec { id: string; x: number; y: number; w: number; text: string; color: string; minH?: number }
/** A boxed text card: a rectangle with left/top aligned sans text on a tinted fill. Returns its estimated height. */
function cardOps(c: CardSpec): { ops: Op[]; h: number } {
  const h = Math.max(c.minH ?? 0, cardHeight(c.text, c.w));
  return {
    h,
    ops: [
      { type: "add_shape", id: c.id, kind: "rectangle", x: c.x, y: c.y, w: c.w, h, text: c.text, color: c.color as any },
      { type: "update", id: c.id, props: { font: "sans", size: "s", align: "start", verticalAlign: "start", fill: "solid", labelColor: "black" } },
    ],
  };
}

const translate = (ops: Op[], dx: number, dy: number): Op[] =>
  ops.map((o) => {
    if (o.type === "add_image" || o.type === "add_shape" || o.type === "add_video") return { ...o, x: o.x + dx, y: o.y + dy };
    return o;
  });

/** lay cards out in rows of at most `perRow`; returns local ops and total size */
function gridOf(cards: { id: string; text: string; color: string }[], w: number, perRow: number, gap = CARD_GAP): Local {
  const ops: Op[] = [], ids: string[] = [];
  let y = 0, width = 0;
  for (let r = 0; r < cards.length; r += perRow) {
    const row = cards.slice(r, r + perRow);
    const heights = row.map((c) => cardHeight(c.text, w));
    const rowH = Math.max(...heights);
    row.forEach((c, i) => {
      const x = i * (w + gap);
      ops.push(...cardOps({ ...c, x, y, w, minH: rowH }).ops); // same-height cards per row read as a set
      ids.push(c.id);
      width = Math.max(width, x + w);
    });
    y += rowH + gap;
  }
  return { ops, ids, w: width, h: Math.max(0, y - gap) };
}

// ---------------------------------------------------------------- say feature detection

/**
 * Feature-detect a `say` op in the local ops.ts contract. Pass the zod OpSchema from ops.ts.
 * Returns a builder (text -> op) or null when the contract has no `say` yet.
 */
export function detectSayOp(opSchema: { safeParse: (v: unknown) => { success: boolean } } | null | undefined): ((text: string) => Op) | null {
  if (!opSchema) return null;
  for (const key of ["text", "message", "caption"]) {
    if (opSchema.safeParse({ type: "say", [key]: "probe" }).success) return (text: string) => ({ type: "say", [key]: text }) as unknown as Op;
  }
  return null;
}

// ---------------------------------------------------------------- ads

const DIRECTION_RE = /ART DIRECTION FOR THIS VARIATION:\s*\n([\s\S]*?)\n\s*\n\s*REQUIREMENTS:/;

export function artDirection(creative: any): string {
  const m = typeof creative?.prompt === "string" ? DIRECTION_RE.exec(creative.prompt) : null;
  return one(m?.[1] ?? creative?.direction ?? "");
}

function creativesOf(ads: any): any[] {
  const list = Array.isArray(ads) ? ads : Array.isArray(ads?.creatives) ? ads.creatives : [];
  return list.filter((c: any) => c && typeof c === "object");
}

function adsLane(ads: any, opts: KitOptions): Local & { kicker: string } {
  const creatives = creativesOf(ads);
  const ops: Op[] = [], ids: string[] = [];
  const srcOf = (f: string) => opts.srcMap?.[f] ?? opts.srcFor?.(f);
  let rowH = 0;
  let generated = 0;
  creatives.forEach((c, i) => {
    const n = Number.isFinite(c.index) ? Number(c.index) : i + 1;
    const id = `ad-${n}`;
    const x = i * (AD_W + 80);
    const name = String(c.name ?? `ad ${n}`);
    const dir = artDirection(c);
    const src = c.status === "failed" ? undefined : c.filename ? srcOf(String(c.filename)) : undefined;
    const sz = c.filename ? opts.sizes?.[String(c.filename)] : undefined;
    const imgH = sz && sz.w > 0 ? Math.round((AD_W * sz.h) / sz.w) : AD_W;
    let capY: number;
    if (src) {
      generated++;
      ops.push({ type: "add_image", id, src, x, y: 40, w: AD_W, h: imgH, label: `Ad ${n} · ${name}` });
      capY = 40 + imgH + 18;
    } else {
      // keep the id stable and say why there is no picture; never fake one
      const why = c.status === "failed" ? `generation failed${c.error ? `: ${clip(c.error, 90)}` : ""}` : "not generated yet (dry run or no image file)";
      const card = cardOps({ id, x, y: 40, w: AD_W, text: `AD ${n} · ${name.toUpperCase()}\n\n${why}`, color: "grey", minH: AD_W });
      ops.push(...card.ops);
      capY = 40 + AD_W + 18;
    }
    ids.push(id);
    let h = capY;
    if (dir) {
      const did = `ad-${n}-direction`;
      ops.push(...textOps(did, x, capY, `Art direction: ${dir}`, "s", AD_W));
      ids.push(did);
      h = capY + textHeight(`Art direction: ${dir}`, AD_W, 22, 8.9);
    }
    rowH = Math.max(rowH, h);
  });
  const m = ads && !Array.isArray(ads) ? ads : {};
  const kicker = [m.provider, m.model, creatives.length ? `${generated} of ${creatives.length} images on the board` : ""].filter(Boolean).join(" · ");
  return { ops, ids, w: creatives.length ? creatives.length * AD_W + (creatives.length - 1) * 80 : 0, h: rowH, kicker };
}

// ---------------------------------------------------------------- GTM posts

function campaignsOf(campaigns: any): { x?: any; reddit?: any } {
  const out: { x?: any; reddit?: any } = {};
  if (Array.isArray(campaigns)) {
    for (const c of campaigns) if (c?.channel === "x" || c?.channel === "reddit") out[c.channel as "x" | "reddit"] = c.campaign ?? c;
  } else if (campaigns && typeof campaigns === "object") {
    if (campaigns.x) out.x = campaigns.x;
    if (campaigns.reddit) out.reddit = campaigns.reddit;
  }
  return out;
}

export function xPostText(p: any, i: number, n: number): string {
  return [`X  ·  POST ${i}${n ? ` of ${n}` : ""}  ·  ${p.id ?? ""}`.replace(/ +·  $/, ""), p.angle ? one(p.angle) : "", "", String(p.copy ?? "").trim()].filter((l, k) => k === 0 || k === 2 || l !== "").join("\n");
}
export function xThreadText(t: string, i: number, n: number): string {
  return `X  ·  THREAD ${i}/${n}\n\n${String(t).trim()}`;
}
export function redditPostText(p: any, i: number, n: number, maxBody = 700): string {
  const body = String(p.copy ?? "").trim();
  const cut = body.length > maxBody ? body.slice(0, maxBody).replace(/\s+\S*$/, "") + " …" : body;
  return [`REDDIT  ·  POST ${i}${n ? ` of ${n}` : ""}  ·  ${p.id ?? ""}`, p.title ? String(p.title).trim() : "", "", cut].join("\n");
}

function gtmLane(campaigns: { x?: any; reddit?: any }, opts: KitOptions): (Local & { kicker: string; xPosts: number; xThread: number; redditPosts: number }) | null {
  const ops: Op[] = [], ids: string[] = [];
  let y = 0, width = 0;
  const kickers: string[] = [];
  let xPosts = 0, xThread = 0, redditPosts = 0;
  const section = (id: string, title: string) => {
    ops.push(...textOps(id, 0, y, title, "m"));
    ids.push(id);
    y += 44;
  };
  const x = campaigns.x;
  if (x && Array.isArray(x.posts) && x.posts.length) {
    if (x.title) kickers.push(one(x.title));
    xPosts = x.posts.length;
    section("gtm-x-posts-title", `X  ·  ${plural(x.posts.length, "standalone post")}`);
    const g = gridOf(x.posts.map((p: any, i: number) => ({ id: `gtm-x-${slug(p.id ?? i + 1)}`, text: xPostText(p, i + 1, x.posts.length), color: "grey" })), X_CARD_W, 7);
    ops.push(...translate(g.ops, 0, y)); ids.push(...g.ids);
    y += g.h + ROW_GAP; width = Math.max(width, g.w);
  }
  if (x && Array.isArray(x.thread) && x.thread.length) {
    xThread = x.thread.length;
    section("gtm-x-thread-title", `X  ·  launch thread, ${plural(x.thread.length, "part")}`);
    const n = x.thread.length;
    const cards = x.thread.map((t: string, i: number) => ({ id: `gtm-x-thread-${i + 1}`, text: xThreadText(t, i + 1, n), color: "grey" }));
    const g = gridOf(cards, THREAD_CARD_W, 8, THREAD_GAP);
    ops.push(...translate(g.ops, 0, y)); ids.push(...g.ids);
    for (let i = 1; i < n; i++) {
      const aid = `kit-arrow-thread-${i}`;
      ops.push({ type: "add_arrow", id: aid, from: cards[i - 1].id, to: cards[i].id, color: "grey" });
      ids.push(aid);
    }
    y += g.h + ROW_GAP; width = Math.max(width, g.w);
  }
  const r = campaigns.reddit;
  if (r && Array.isArray(r.posts) && r.posts.length) {
    if (r.title) kickers.push(one(r.title));
    redditPosts = r.posts.length;
    section("gtm-reddit-posts-title", `Reddit  ·  ${plural(r.posts.length, "post draft")}`);
    const g = gridOf(r.posts.map((p: any, i: number) => ({ id: `gtm-reddit-${slug(p.id ?? i + 1)}`, text: redditPostText(p, i + 1, r.posts.length, opts.redditBodyChars ?? 700), color: "orange" })), REDDIT_CARD_W, 3);
    ops.push(...translate(g.ops, 0, y)); ids.push(...g.ids);
    y += g.h + ROW_GAP; width = Math.max(width, g.w);
  }
  if (!ids.length) return null;
  return { ops, ids, w: width, h: Math.max(0, y - ROW_GAP), kicker: kickers.join("   |   "), xPosts, xThread, redditPosts };
}

// ---------------------------------------------------------------- UGC concepts

const PLATFORM_LABEL: Record<string, string> = { tiktok: "TIKTOK", "instagram-reels": "INSTAGRAM REELS", "youtube-shorts": "YOUTUBE SHORTS", linkedin: "LINKEDIN", x: "X" };
const platformLabel = (p: unknown) => PLATFORM_LABEL[String(p)] ?? String(p ?? "").toUpperCase();
const formatLabel = (f: unknown) => String(f ?? "").toUpperCase();

const byId = (list: any): Map<string, any> => new Map((Array.isArray(list) ? list : []).filter((x: any) => x?.id).map((x: any) => [String(x.id), x]));

export function ugcScriptText(s: any, plan: any, evidence: string[] = []): string {
  const hook = byId(plan?.hooks).get(String(s.hookId));
  const creator = byId(plan?.creators).get(String(s.creatorId));
  const head = [platformLabel(s.platform), formatLabel(s.format), Number.isFinite(s.durationSec) ? `${s.durationSec}s` : ""].filter(Boolean).join("  ·  ");
  const lines = [head, `${s.id ?? ""}${s.title ? `  ·  ${one(s.title)}` : ""}`.replace(/^  ·  /, "")];
  if (hook?.text) lines.push(`HOOK: "${one(hook.text)}"`);
  if (hook?.visualOpener) lines.push(`Opens on: ${one(hook.visualOpener)}`);
  if (creator?.archetype) lines.push(`Creator: ${one(creator.archetype)}`);
  const beats = Array.isArray(s.beats) ? s.beats : [];
  if (beats.length) lines.push("");
  for (const b of beats) {
    lines.push(`${b.t ?? ""}  ${b.voiceover ? `"${one(b.voiceover)}"` : ""}`.trimEnd());
    if (b.onScreenText) lines.push(`      on screen: ${one(b.onScreenText)}`);
    if (b.shot) lines.push(`      shot: ${one(b.shot)}`);
  }
  if (s.cta) lines.push("", `CTA: ${one(s.cta)}`);
  if (evidence.length) lines.push(`Evidence on the board: ${evidence.join(", ")}`);
  return lines.filter((l, i) => l !== undefined && (l !== "" || lines[i - 1] !== "")).join("\n");
}

export function ugcHookText(h: any, plan: any, evidence: string[] = []): string {
  const angle = byId(plan?.angles).get(String(h.angleId));
  const lines = [`HOOK  ·  ${formatLabel(h.format)}`, h.id ?? "", `"${one(h.text)}"`];
  if (h.visualOpener) lines.push(`Opens on: ${one(h.visualOpener)}`);
  if (angle?.name) lines.push(`Angle: ${one(angle.name)}`);
  if (evidence.length) lines.push(`Evidence on the board: ${evidence.join(", ")}`);
  return lines.filter(Boolean).join("\n");
}

export const defaultStepIdFor = (assetPath: string): string | undefined => {
  const m = /^0*(\d+)-/.exec(String(assetPath).split("/").pop() ?? "");
  return m && Number(m[1]) > 0 ? `step-${Number(m[1])}` : undefined;
};

/** evidence the card can point at: beat assetRefs first (labelled with the beat time), then the claimed features' evidence */
function evidenceFor(s: any, plan: any, opts: KitOptions): { to: string; label?: string }[] {
  if (!opts.stepIds) return [];
  const have = typeof opts.stepIds === "function" ? opts.stepIds : ((set) => (id: string) => set.has(id))(new Set(opts.stepIds));
  const idFor = opts.stepIdFor ?? defaultStepIdFor;
  const out: { to: string; label?: string }[] = [];
  const seen = new Set<string>();
  const take = (path: unknown, label?: string) => {
    if (typeof path !== "string" || !path) return;
    const id = idFor(path);
    if (id && have(id) && !seen.has(id)) { seen.add(id); out.push({ to: id, label }); }
  };
  for (const b of Array.isArray(s.beats) ? s.beats : []) take(b?.assetRef, b?.t ? `beat ${b.t}` : undefined);
  const feats = byId(plan?.product?.observedFeatures);
  for (const fid of Array.isArray(s.featureIds) ? s.featureIds : []) for (const p of feats.get(String(fid))?.evidence ?? []) take(p, feats.get(String(fid))?.name ? clip(feats.get(String(fid)).name, 28) : undefined);
  return out.slice(0, opts.maxEvidenceArrows ?? 3);
}

function ugcLane(plan: any, opts: KitOptions, widthHint: number): (Local & { kicker: string; count: number; arrows: number }) | null {
  const scripts: any[] = Array.isArray(plan?.scripts) ? plan.scripts : [];
  const usedHooks = new Set(scripts.map((s) => String(s.hookId)));
  const loneHooks: any[] = (Array.isArray(plan?.hooks) ? plan.hooks : []).filter((h: any) => h?.id && h?.text && !usedHooks.has(String(h.id)));
  const anglesById = byId(plan?.angles);
  // evidence first: it goes into the card text and decides the layout
  const cards = [
    ...scripts.map((s) => ({ id: `ugc-${slug(s.id ?? s.title)}`, color: "violet", ev: evidenceFor(s, plan, opts), render: (ev: string[]) => ugcScriptText(s, plan, ev) })),
    ...loneHooks.map((h) => ({ id: `ugc-${slug(h.id)}`, color: "violet", ev: evidenceFor({ featureIds: anglesById.get(String(h.angleId))?.featureIds ?? [] }, plan, opts), render: (ev: string[]) => ugcHookText(h, plan, ev) })),
  ].map((c) => ({ id: c.id, color: c.color, ev: c.ev, text: c.render(c.ev.map((e) => e.to)) }));
  if (!cards.length) return null;
  const n = cards.length;
  const withArrows = cards.some((c) => c.ev.length);
  // Arrows run straight up to the teardown: one row keeps them from cutting through sibling cards.
  // Without arrows: 3 across for a handful of concepts (a lone card on a second row looks like a mistake), 5 for a big plan.
  const perRow = withArrows ? Math.min(n, 7) : n <= 3 ? n : n <= 6 ? 3 : n <= 8 ? 4 : 5;
  const cardW = withArrows ? UGC_CARD_W : Math.min(640, Math.max(UGC_CARD_W, Math.floor((Math.max(widthHint, 2300) - CARD_GAP * (perRow - 1)) / perRow)));
  const g = gridOf(cards, cardW, perRow);
  const ops = [...g.ops], ids = [...g.ids];
  let arrows = 0;
  for (const c of cards) {
    c.ev.forEach((e, k) => {
      const aid = `kit-arrow-${c.id}-${k + 1}`.slice(0, 64);
      ops.push({ type: "add_arrow", id: aid, from: c.id, to: e.to, color: "violet" });
      ids.push(aid);
      arrows++;
    });
  }
  const kicker = [plan?.product?.name, `${plural(scripts.length, "script")}, ${plural(Array.isArray(plan?.hooks) ? plan.hooks.length : 0, "hook")}`, plan?.campaign?.goal ? `goal: ${clip(plan.campaign.goal, 110)}` : ""].filter(Boolean).join(" · ");
  return { ops, ids, w: g.w, h: g.h, kicker, count: cards.length, arrows };
}

// ---------------------------------------------------------------- single-card builders (MCP tools reuse these)

/** One GTM post card at (x,y). platform "x" | "reddit". Returns its ops and estimated height. */
export function postCardOps(platform: "x" | "reddit", post: { id?: string; text: string; title?: string; angle?: string; index?: number; total?: number; thread?: boolean }, at: Point & { w?: number }): { id: string; ops: Op[]; h: number; w: number } {
  const index = post.index ?? 1;
  let text: string, w: number, id: string;
  if (platform === "x") {
    w = at.w ?? (post.thread ? THREAD_CARD_W : X_CARD_W);
    id = post.thread ? `gtm-x-thread-${index}` : `gtm-x-${slug(post.id ?? index)}`;
    text = post.thread ? xThreadText(post.text, index, post.total ?? index) : xPostText({ id: post.id, angle: post.angle, copy: post.text }, index, post.total ?? 0);
  } else {
    w = at.w ?? REDDIT_CARD_W;
    id = `gtm-reddit-${slug(post.id ?? index)}`;
    text = redditPostText({ id: post.id, title: post.title, copy: post.text }, index, post.total ?? 0, 100000);
  }
  const c = cardOps({ id, x: at.x, y: at.y, w, text, color: platform === "x" ? "grey" : "orange" });
  return { id, ops: c.ops, h: c.h, w };
}

/** One UGC concept card at (x,y), with arrows to the given evidence ids (only ids you know exist). */
export function ugcCardOps(concept: { id?: string; platform?: string; format?: string; durationSec?: number; title?: string; hook?: string; visualOpener?: string; creator?: string; beats?: { t?: string; voiceover?: string; onScreenText?: string; shot?: string; assetRef?: string | null }[]; cta?: string; evidenceIds?: string[] }, at: Point): { id: string; ops: Op[]; h: number; w: number } {
  const id = `ugc-${slug(concept.id ?? concept.title ?? concept.hook)}`;
  const plan = {
    hooks: [{ id: "h", text: concept.hook, visualOpener: concept.visualOpener }],
    creators: [{ id: "c", archetype: concept.creator }],
  };
  const text = ugcScriptText({ id: concept.id, title: concept.title, platform: concept.platform, format: concept.format, durationSec: concept.durationSec, hookId: "h", creatorId: "c", beats: concept.beats, cta: concept.cta }, plan);
  const c = cardOps({ id, x: at.x, y: at.y, w: UGC_CARD_W, text, color: "violet" });
  const ops = [...c.ops];
  (concept.evidenceIds ?? []).slice(0, 6).forEach((to, k) => ops.push({ type: "add_arrow", id: `kit-arrow-${id}-${k + 1}`.slice(0, 64), from: id, to, color: "violet" }));
  return { id, ops, h: c.h, w: UGC_CARD_W };
}

// ---------------------------------------------------------------- canvas state

/**
 * Bounds of what is on the canvas, replayed from GET /api/state ops (envelopes or bare ops).
 * Arrows, annotations and `say` have no box. `where` limits the result (e.g. ids starting with "ugc-").
 * Sizes the op leaves out use the same defaults as the canvas.
 */
export function stateElements(ops: any[]): Map<string, Box> {
  const els = new Map<string, Box>();
  const seqOf = (e: any, i: number) => (e && typeof e.seq === "number" ? e.seq : i + 1);
  ops.forEach((e, i) => {
    const op = e?.op ?? e;
    if (!op || typeof op !== "object") return;
    const id: string | undefined = op.id ?? (String(op.type).startsWith("add_") ? `#${seqOf(e, i)}` : undefined);
    switch (op.type) {
      case "add_image": {
        const w = op.w ?? 900;
        els.set(id!, { x: op.x, y: op.y - 40, w, h: (op.h ?? Math.round(w * 0.625)) + 40 }); // caption sits 40px above
        break;
      }
      case "add_video": els.set(id!, { x: op.x, y: op.y - 40, w: op.w ?? 640, h: (op.h ?? 360) + 40 }); break;
      case "add_shape": {
        const t = op.kind === "text" || op.kind === "note";
        els.set(id!, { x: op.x, y: op.y, w: op.w ?? (t ? 200 : 160), h: op.h ?? (op.kind === "note" ? 200 : t ? 60 : 100) });
        break;
      }
      case "add_finding": els.set(id!, { x: op.x, y: op.y, w: 360, h: findingHeightFor(op) }); break;
      case "move": { const b = els.get(op.id); if (b) els.set(op.id, { ...b, x: op.x, y: op.y }); break; }
      case "update": {
        const b = els.get(op.id), p = op.props ?? {};
        if (b) els.set(op.id, { x: typeof p.x === "number" ? p.x : b.x, y: typeof p.y === "number" ? p.y : b.y, w: typeof p.w === "number" ? p.w : b.w, h: typeof p.h === "number" ? p.h : b.h });
        break;
      }
      case "delete": els.delete(op.id); break;
      case "clear": els.clear(); break;
      default: break;
    }
  });
  return els;
}

/** union box of the elements (optionally only those whose id passes `where`) */
export function stateBounds(ops: any[], where?: (id: string) => boolean): { box: Box | null; ids: Set<string> } {
  const els = stateElements(ops);
  const ids = new Set<string>();
  let box: Box | null = null;
  let x1 = 0, y1 = 0;
  for (const [id, b] of els) {
    if (where && !where(id)) continue;
    ids.add(id);
    if (!box) { box = { ...b }; x1 = b.x + b.w; y1 = b.y + b.h; continue; }
    const nx = Math.min(box.x, b.x), ny = Math.min(box.y, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    box = { x: nx, y: ny, w: x1 - nx, h: y1 - ny };
  }
  if (box) box = { ...box, w: x1 - box.x, h: y1 - box.y };
  return { box, ids };
}

/** ids of every element still live in a replayed /api/state log (arrows and annotations included) */
export function liveIds(ops: any[]): Set<string> {
  const live = new Set<string>();
  for (const e of ops) {
    const op = e?.op ?? e;
    if (!op || typeof op !== "object") continue;
    if (op.type === "clear") live.clear();
    else if (op.type === "delete") live.delete(op.id);
    else if (op.id && (String(op.type).startsWith("add_") || op.type === "annotate")) live.add(op.id);
  }
  return live;
}

// mirrors estimateFindingHeight() in components/shapes/FindingShape.tsx (as runToOps.ts does)
function findingHeightFor(f: { title?: string; expected?: string; actual?: string }): number {
  const lines = (t: string | undefined, per: number) => (t ? t.split("\n").reduce((n, p) => n + Math.max(1, Math.ceil(p.length / per)), 0) : 0);
  let h = 32 + 22 + 10;
  h += lines(f.title, 36) * 20 + 12;
  for (const body of [f.expected, f.actual]) if (body) h += 14 + 4 + lines(body, 52) * 17 + 10;
  h += 1 + 10 + 22;
  return Math.ceil(h);
}

/** where a kit should start so it does not touch an existing teardown: left edge of the content, below its lowest element */
export function originBelow(box: Box | null, gap = 240): Point {
  return box ? { x: Math.round(box.x), y: Math.round(box.y + box.h + gap) } : { x: 0, y: 0 };
}

// ---------------------------------------------------------------- the kit

export function kitToOpsDetailed(input: KitInput, opts: KitOptions = {}): KitResult {
  const origin = opts.origin ?? { x: 0, y: 0 };
  const campaigns = campaignsOf(input.campaigns);
  const ads = creativesOf(input.ads).length ? adsLane(input.ads, opts) : null;
  const gtm = gtmLane(campaigns, opts);
  const ugc = ugcLane(input.ugcPlan, opts, Math.max(ads?.w ?? 0, gtm?.w ?? 0));

  // The UGC cards arrow up to the teardown's screenshots: when they do, that lane goes first so the arrows are short
  // and do not cut through the other lanes. Otherwise the order is ads, GTM posts, UGC.
  const lanes: { key: "ads" | "gtm" | "ugc"; title: string; local: Local & { kicker: string } }[] = [];
  if (ugc && ugc.arrows > 0) lanes.push({ key: "ugc", title: "UGC CONCEPTS", local: ugc });
  if (ads) lanes.push({ key: "ads", title: "AD CONCEPTS", local: ads });
  if (gtm) lanes.push({ key: "gtm", title: "GTM POSTS", local: gtm });
  if (ugc && ugc.arrows === 0) lanes.push({ key: "ugc", title: "UGC CONCEPTS", local: ugc });

  const ops: Op[] = [], ids: string[] = [];
  const contentW = Math.max(0, ...lanes.map((l) => l.local.w));
  const laneW = contentW + LANE_PAD * 2;
  let y = origin.y;

  const counts = { ads: ads ? creativesOf(input.ads).length : 0, xPosts: gtm?.xPosts ?? 0, xThread: gtm?.xThread ?? 0, redditPosts: gtm?.redditPosts ?? 0, ugc: ugc?.count ?? 0, evidenceArrows: ugc?.arrows ?? 0 };
  const summary = [
    counts.ads ? plural(counts.ads, "ad concept") : "",
    counts.xPosts ? `${plural(counts.xPosts, "X post")}${counts.xThread ? ` + ${counts.xThread}-part thread` : ""}` : counts.xThread ? `${counts.xThread}-part X thread` : "",
    counts.redditPosts ? plural(counts.redditPosts, "Reddit draft") : "",
    counts.ugc ? plural(counts.ugc, "UGC concept") : "",
  ].filter(Boolean).join("  ·  ");

  if (opts.banner !== false && lanes.length) {
    const name = input.ugcPlan?.product?.name;
    ops.push(...textOps("kit-title", origin.x, y, `LAUNCH KIT${name ? `  ·  ${one(name)}` : ""}`, "xl"));
    ops.push(...textOps("kit-summary", origin.x, y + 90, summary, "m"));
    ids.push("kit-title", "kit-summary");
    y += 210;
  }

  const laneRes: KitResult["lanes"] = [];
  for (const l of lanes) {
    const top = y;
    const bodyTop = top + HEADER_H;
    const h = HEADER_H + l.local.h + 10;
    const lid = `kit-lane-${l.key}`;
    const laneIds = [`${lid}-panel`, `${lid}-title`];
    // backdrop first so it sits under everything else
    ops.push({ type: "add_shape", id: `${lid}-panel`, kind: "rectangle", x: origin.x - LANE_PAD, y: top - LANE_PAD, w: laneW, h: h + LANE_PAD * 2, text: "", color: "grey" });
    ops.push({ type: "update", id: `${lid}-panel`, props: { dash: "dashed", fill: "none" } });
    ops.push(...textOps(`${lid}-title`, origin.x, top, l.title, "xl"));
    if (l.local.kicker) { ops.push(...textOps(`${lid}-kicker`, origin.x, top + 80, clip(l.local.kicker, 220), "s", contentW)); laneIds.push(`${lid}-kicker`); }
    ops.push(...translate(l.local.ops, origin.x, bodyTop));
    laneIds.push(...l.local.ids);
    ids.push(...laneIds);
    laneRes.push({ key: l.key, title: l.title, box: { x: origin.x - LANE_PAD, y: top - LANE_PAD, w: laneW, h: h + LANE_PAD * 2 }, ids: laneIds });
    y = top + h + LANE_PAD + LANE_GAP;
  }

  const bounds: Box = lanes.length
    ? { x: origin.x - LANE_PAD, y: origin.y - (opts.banner !== false ? 0 : LANE_PAD), w: laneW, h: laneRes[laneRes.length - 1].box.y + laneRes[laneRes.length - 1].box.h - (origin.y - (opts.banner !== false ? 0 : LANE_PAD)) }
    : { x: origin.x, y: origin.y, w: 0, h: 0 };

  if (opts.say && lanes.length) {
    const say = opts.say(`Launch kit is on the board: ${summary}. Cards are drafts to review, not published anything.`);
    if (say) ops.push(say);
  }
  if (opts.focus !== false && lanes.length) {
    ops.push({ type: "focus", box: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h } });
  }
  return { ops, ids, bounds, lanes: laneRes, counts };
}

export function kitToOps(input: KitInput, opts: KitOptions = {}): Op[] {
  return kitToOpsDetailed(input, opts).ops;
}

export default kitToOps;
