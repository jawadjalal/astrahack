/* eslint-disable @typescript-eslint/no-explicit-any -- runner bundles are untyped JSON read defensively */
// Pure converter: computer-use runner evidence bundle (+ optional QA analysis) -> canvas Op[].
//
// Accepts, as `bundle`:
//   - a runner report.json            (journeys[].steps[], findings[], assets[], product)
//   - a qa-agent.json / fleet combined (steps[], assessment.issues[], workers[])
//   - { report, analysis }            (analysis = qa-analysis.json, whose findings win over assessment.issues)
//   - { report, crawl, analysis }     (crawl.json adds C/CF screenshot evidence)
// No I/O. Screenshot/video paths are mapped to hosted URLs through opts.srcMap / opts.srcFor
// (scripts/push-run.mjs uploads the files first). Nothing is invented: a field missing from the bundle is
// left off the op. Only erasable TypeScript here so Node can import this file directly.

import type { Op } from "./ops";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface RunToOpsOptions {
  /** qa-analysis.json (or anything with findings[]). Overrides bundle.analysis. */
  analysis?: any;
  /** local path in the bundle -> hosted src */
  srcMap?: Record<string, string>;
  srcFor?: (path: string) => string | undefined;
  /** natural pixel size of screenshots by bundle path: gives exact aspect ratios and lets pixel regions normalise */
  sizes?: Record<string, { w: number; h: number }>;
  /** "journeys" (default): one left-to-right row per journey/worker. "single": every step in one row. */
  layout?: "journeys" | "single";
  /** screenshot width on the canvas (default 520) */
  stepWidth?: number;
  /** horizontal gap between steps (default 140) */
  gap?: number;
  /** also add the 000-initial screenshot as step 0 (default false) */
  includeInitial?: boolean;
  /** title note text override */
  title?: string;
  /** append a final focus op (default true) */
  focus?: boolean;
  /** Namespace ids when several runs share a board (also rewrites every reference). */
  idPrefix?: string;
  /** Canvas offset for this run; the layout's title starts 400px above this origin. */
  origin?: { x: number; y: number };
}

interface Region { x: number; y: number; w: number; h: number; unit?: string; label?: string; severity?: string; viewport?: { width: number; height: number } }

interface StepNode {
  id: string;
  index: number;
  label: string;
  path: string;
  failed: boolean;
  regions: any[];
  w: number;
  h: number;
  x: number;
  y: number;
}

interface Group {
  name: string;
  status?: string;
  video?: string;
  startedAt?: string;
  nodes: StepNode[];
}

interface FindingDraft {
  key: string;
  title: string;
  severity: Severity;
  expected?: string;
  actual?: string;
  verified: boolean;
  timestamp?: number;
  nodeId?: string;
  regions: any[];
}

const FINDING_W = 360;

// Mirrors estimateFindingHeight() in components/shapes/FindingShape.tsx (kept inline so this file stays tldraw-free).
function findingHeight(f: { title: string; expected?: string; actual?: string }): number {
  const lines = (t: string | undefined, per: number) =>
    t ? t.split("\n").reduce((n, p) => n + Math.max(1, Math.ceil(p.length / per)), 0) : 0;
  let h = 32 + 22 + 10;
  h += lines(f.title, 36) * 20 + 12;
  for (const body of [f.expected, f.actual]) if (body) h += 14 + 4 + lines(body, 52) * 17 + 10;
  h += 1 + 10 + 22;
  return Math.ceil(h);
}

const clip = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

export function mapSeverity(raw: unknown): Severity {
  const s = String(raw ?? "").toLowerCase().trim();
  if (["critical", "blocker", "p0", "sev0", "sev1", "fatal"].includes(s)) return "critical";
  if (["high", "major", "p1", "error", "severe", "sev2"].includes(s)) return "high";
  if (["medium", "moderate", "p2", "warning", "warn", "sev3"].includes(s)) return "medium";
  if (["low", "minor", "p3", "sev4"].includes(s)) return "low";
  if (["info", "informational", "note", "trivial", "p4", "suggestion"].includes(s)) return "info";
  return "medium";
}

function describeRunnerStep(s: any): string {
  const a = s.action;
  let d: string;
  switch (a) {
    case "goto": d = `goto ${s.url ?? ""}`; break;
    case "click": d = `click ${s.selector ?? ""}`; break;
    case "fill": d = `fill ${s.selector ?? ""}`; break;
    case "waitFor": d = `waitFor ${s.selector ?? ""}`; break;
    case "assertText": d = `assertText "${s.text ?? ""}"`; break;
    case "assertUrl": d = `assertUrl contains ${s.contains ?? s.url ?? ""}`; break;
    case "press": d = `press ${s.key ?? ""}`; break;
    case "wait": d = `wait ${s.ms ?? ""}ms`; break;
    case "observe": d = "observe page"; break;
    default: d = String(a ?? "step");
  }
  d = clip(d, 52).trim();
  return s.status === "failed" ? `${d} (failed)` : d;
}

function describeAgentStep(s: any): string {
  const act = s.action && typeof s.action === "object" ? s.action : {};
  const type = s.type ?? act.type ?? "action";
  let d = String(type);
  if (Number.isFinite(act.x) && Number.isFinite(act.y)) d += ` (${act.x}, ${act.y})`;
  if (typeof act.text === "string" && act.text) d += ` "${clip(act.text, 20)}"`;
  if (Array.isArray(act.keys) && act.keys.length) d += ` ${act.keys.join("+")}`;
  if (Number.isFinite(act.scroll_y) && act.scroll_y) d += act.scroll_y > 0 ? " down" : " up";
  if (typeof act.url === "string") d += ` ${act.url}`;
  d = clip(d, 52);
  return s.status && s.status !== "passed" ? `${d} (${s.status === "blocked_or_failed" ? "blocked" : s.status})` : d;
}

function regionsOf(o: any): any[] {
  if (!o || typeof o !== "object") return [];
  const out: any[] = [];
  for (const k of ["regions", "annotations", "boxes"]) if (Array.isArray(o[k])) out.push(...o[k]);
  for (const k of ["region", "box", "bbox"]) if (o[k] && typeof o[k] === "object") out.push(o[k]);
  return out;
}

/** -> fractional box or null when it can't be normalised without inventing a size */
function toFractions(r: any, size?: { w: number; h: number }): Region | null {
  if (!r) return null;
  const x = Number(r.x ?? r.left), y = Number(r.y ?? r.top);
  const w = Number(r.w ?? r.width), h = Number(r.h ?? r.height);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const fractional = r.unit === "fraction" || r.normalized === true || (r.unit !== "pixels" && x <= 1 && y <= 1 && w <= 1 && h <= 1);
  let box: { x: number; y: number; w: number; h: number };
  if (fractional) box = { x, y, w, h };
  else {
    const W = r.viewport?.width ?? r.imageWidth ?? size?.w;
    const H = r.viewport?.height ?? r.imageHeight ?? size?.h;
    if (!W || !H) return null;
    box = { x: x / W, y: y / H, w: w / W, h: h / H };
  }
  const x0 = clamp(box.x), y0 = clamp(box.y);
  const w1 = clamp(box.x + box.w) - x0, h1 = clamp(box.y + box.h) - y0;
  if (w1 <= 0 || h1 <= 0) return null;
  const q = (n: number) => Math.round(n * 10000) / 10000;
  return { x: q(x0), y: q(y0), w: q(w1), h: q(h1), label: r.label, severity: r.severity };
}

function evidenceIndexFromRef(ref: unknown): number | null {
  const m = /^Q0*(\d+)$/.exec(String(ref));
  return m ? Number(m[1]) : null;
}

export function runToOps(bundle: any, opts: RunToOpsOptions = {}): Op[] {
  const report = bundle?.report ?? bundle ?? {};
  const analysis = opts.analysis ?? bundle?.analysis ?? null;
  const crawl = bundle?.crawl ?? (Array.isArray(report.pages) ? report : null);
  const W = opts.stepWidth ?? 520;
  const GAP = opts.gap ?? 140;
  const single = opts.layout === "single";
  const srcOf = (p: string) => opts.srcMap?.[p] ?? opts.srcFor?.(p) ?? p;
  const heightFor = (p: string) => {
    const sz = opts.sizes?.[p];
    return sz && sz.w > 0 ? Math.round((W * sz.h) / sz.w) : Math.round(W * 0.625);
  };

  // ---- 1. normalise steps into groups
  const groups: Group[] = [];
  const byIndex = new Map<number, StepNode>();
  const byPath = new Map<string, StepNode>();
  const byEvidenceRef = new Map<string, StepNode>();
  const mkNode = (index: number, label: string, path: string, failed: boolean, regions: any[], id = `step-${index}`, registerIndex = true): StepNode => {
    const n: StepNode = { id, index, label, path, failed, regions, w: W, h: heightFor(path), x: 0, y: 0 };
    if (registerIndex) byIndex.set(index, n);
    byPath.set(path, n);
    return n;
  };

  if (crawl?.pages?.length) {
    const crawled: Group = { name: "Crawled pages", status: "observed", nodes: [] };
    for (const [i, page] of crawl.pages.entries()) {
      if (!page?.screenshot) continue;
      const index = i + 1;
      const node = mkNode(index, clip(page.finalUrl ?? page.url ?? `Page ${index}`, 52), page.screenshot, false, [], `crawl-${index}`, false);
      crawled.nodes.push(node);
      byEvidenceRef.set(`C${String(index).padStart(3, "0")}`, node);
    }
    if (crawled.nodes.length) groups.push(crawled);
  }

  if (opts.includeInitial) {
    const init = (report.assets ?? []).find((a: any) => a?.type === "screenshot" && a.purpose);
    if (init?.path) groups.push({ name: "Initial view", nodes: [mkNode(0, init.purpose, init.path, false, regionsOf(init))] });
  }

  if (Array.isArray(report.journeys)) {
    for (const j of report.journeys) {
      const g: Group = { name: j.name ?? "Journey", status: j.status, video: j.video, startedAt: j.startedAt, nodes: [] };
      for (const s of j.steps ?? []) {
        if (!s?.screenshot || !Number.isFinite(s.index)) continue;
        g.nodes.push(mkNode(s.index, describeRunnerStep(s), s.screenshot, s.status === "failed", regionsOf(s)));
      }
      groups.push(g);
    }
  } else if (Array.isArray(report.steps)) {
    const workers = new Map<string, any>((report.workers ?? []).map((w: any) => [w.id, w]));
    const gmap = new Map<string, Group>();
    for (const s of report.steps) {
      if (!s?.screenshot || !Number.isFinite(s.index)) continue;
      const key = s.workerId ?? "";
      let g = gmap.get(key);
      if (!g) {
        const w = workers.get(key);
        g = { name: key ? `Agent ${key}${w?.mission ? ` · ${w.mission}` : ""}` : "Computer-use session", status: w?.status ?? report.status, nodes: [] };
        gmap.set(key, g);
        groups.push(g);
      }
      g.nodes.push(mkNode(s.index, describeAgentStep(s), s.screenshot, s.status !== "passed" && !!s.status, regionsOf(s)));
    }
    // a lone session recording at the top level
    const vid = (report.assets ?? []).find((a: any) => a?.type === "video");
    if (vid && groups.length === 1) groups[0].video = vid.path;
  }
  const liveGroups = groups.filter((g) => g.nodes.length);

  // ---- 2. normalise findings
  const drafts: FindingDraft[] = [];
  const usedKeys = new Set<string>();
  const addDraft = (f: any, kind: "runner" | "agent" | "analysis") => {
    const title = clip(f.summary ?? f.title ?? "Finding", 160);
    let node: StepNode | undefined;
    if (typeof f.evidence === "string") node = byPath.get(f.evidence);
    if (!node && Number.isFinite(f.evidenceStep)) node = byIndex.get(f.evidenceStep);
    if (!node && Array.isArray(f.evidenceRefs)) {
      for (const r of f.evidenceRefs) {
        if (byEvidenceRef.has(String(r))) { node = byEvidenceRef.get(String(r)); break; }
        const i = evidenceIndexFromRef(r);
        if (i != null && byIndex.has(i)) { node = byIndex.get(i); break; }
        const source = analysis?.evidence?.find((item: any) => item.id === r);
        if (source?.screenshot && byPath.has(source.screenshot)) { node = byPath.get(source.screenshot); break; }
      }
    }
    const verification = String(f.verification ?? "").toLowerCase();
    let verified: boolean;
    if (typeof f.verified === "boolean") verified = f.verified;
    else if (typeof f.reproduced === "boolean") verified = f.reproduced;
    else if (verification) verified = ["recorded", "verified", "reproduced"].includes(verification);
    else verified = kind === "runner" && Array.isArray(f.stepsToReproduce) && f.stepsToReproduce.length > 0 && !!node;
    let timestamp: number | undefined;
    if (Number.isFinite(f.timestamp)) timestamp = Number(f.timestamp);
    else if (kind === "runner" && f.observedAt) {
      const g = liveGroups.find((x) => x.name === f.journey);
      const t0 = g?.video && g.startedAt ? Date.parse(g.startedAt) : NaN;
      const t1 = Date.parse(f.observedAt);
      if (Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) timestamp = Math.round((t1 - t0) / 100) / 10;
    }
    let key = String(f.id ?? drafts.length + 1);
    if (usedKeys.has(key)) key = `${key}-${kind}${drafts.length + 1}`;
    usedKeys.add(key);
    const evidence = Array.isArray(f.evidenceRefs) && f.evidenceRefs.length ? `Evidence: ${f.evidenceRefs.join(", ")}` : "";
    const reproduction = Array.isArray(f.reproduction) && f.reproduction.length ? `Reproduce: ${f.reproduction.join(" → ")}` : "";
    drafts.push({
      key,
      title,
      severity: mapSeverity(f.severity),
      expected: f.expected ? clip(f.expected, 300) : undefined,
      actual: [evidence, f.actual, reproduction].filter(Boolean).length ? clip([evidence, f.actual, reproduction].filter(Boolean).join("\n"), 400) : undefined,
      verified,
      timestamp,
      nodeId: node?.id,
      regions: regionsOf(f).map((r) => ({ ...r, __path: node?.path })),
    });
  };
  // qa-analysis already includes crawler findings; do not render them twice for a crawl-only bundle.
  if (!(analysis && report === crawl)) for (const f of report.findings ?? []) addDraft(f, "runner");
  if (analysis && Array.isArray(analysis.findings)) for (const f of analysis.findings) addDraft(f, "analysis");
  else for (const f of report.assessment?.issues ?? []) addDraft(f, "agent");

  const findingsByNode = new Map<string, FindingDraft[]>();
  const unattached: FindingDraft[] = [];
  for (const d of drafts) {
    if (d.nodeId) (findingsByNode.get(d.nodeId) ?? findingsByNode.set(d.nodeId, []).get(d.nodeId)!).push(d);
    else unattached.push(d);
  }
  const stackHeight = (list: FindingDraft[] = []) => list.reduce((n, f) => n + findingHeight(f) + 24, 0);

  // ---- 3. layout + emit
  const rows: Group[][] = single ? (liveGroups.length ? [liveGroups] : []) : liveGroups.map((g) => [g]);
  const ops: Op[] = [];
  const ids: string[] = [];
  const totalSteps = liveGroups.reduce((n, g) => n + g.nodes.length, 0);
  const failedCount = drafts.length;

  const titleLines = [
    clip(opts.title ?? report.name ?? "Computer-use run", 60),
    report.target?.url || typeof report.target === "string" ? clip(report.target?.url ?? report.target, 60) : "",
    `${report.status ?? "run"} · ${totalSteps} steps · ${failedCount} finding${failedCount === 1 ? "" : "s"}`,
  ].filter(Boolean);
  ops.push({ type: "add_shape", id: "run-title", kind: "note", x: 0, y: -400, text: titleLines.join("\n"), color: "yellow" });
  ids.push("run-title");

  let y = 0;
  let videoCount = 0;
  for (const [ri, row] of rows.entries()) {
    const nodes = row.flatMap((g) => g.nodes);
    const rowH = Math.max(...nodes.map((n) => n.h));
    if (!single) {
      const g = row[0];
      const hid = `journey-${ri + 1}`;
      ops.push({ type: "add_shape", id: hid, kind: "text", x: 0, y: y - 130, text: `${g.name}${g.status ? ` · ${g.status}` : ""}`, color: g.status === "failed" ? "red" : g.status === "passed" ? "green" : "black" });
      ids.push(hid);
    }
    let prev: StepNode | undefined;
    for (const [i, n] of nodes.entries()) {
      n.x = i * (W + GAP);
      n.y = y;
      ops.push({ type: "add_image", id: n.id, src: srcOf(n.path), x: n.x, y: n.y, w: n.w, h: n.h, label: n.label, step: n.index });
      ids.push(n.id);
      if (prev) ops.push({ type: "add_arrow", id: n.id.startsWith("crawl-") ? `crawl-arrow-${n.index}` : `arrow-${n.index}`, from: prev.id, to: n.id });
      prev = n;
      let k = 0;
      for (const r of n.regions) {
        const box = toFractions(r, opts.sizes?.[n.path]);
        if (!box) continue;
        ops.push({ type: "annotate", id: `${n.id}-region-${++k}`, target: n.id, box: { x: box.x, y: box.y, w: box.w, h: box.h }, label: box.label ? clip(box.label, 60) : undefined, severity: mapSeverity(box.severity ?? (n.failed ? "high" : "info")) });
      }
      let fy = y + rowH + 90;
      for (const f of findingsByNode.get(n.id) ?? []) {
        const fid = `finding-${f.key}`.slice(0, 64);
        let j = 0;
        for (const r of f.regions) {
          const box = toFractions(r, opts.sizes?.[r.__path]);
          if (!box) continue;
          ops.push({ type: "annotate", id: `${fid}-region-${++j}`.slice(0, 64), target: n.id, box: { x: box.x, y: box.y, w: box.w, h: box.h }, label: box.label ? clip(box.label, 60) : clip(f.title, 60), severity: f.severity });
        }
        ops.push({ type: "add_finding", id: fid, x: n.x, y: fy, title: f.title, severity: f.severity, expected: f.expected, actual: f.actual, verified: f.verified, target: n.id, timestamp: f.timestamp });
        ids.push(fid);
        fy += findingHeight(f) + 24;
      }
    }
    const tallest = Math.max(0, ...nodes.map((n) => stackHeight(findingsByNode.get(n.id))));
    const videos = row.filter((g) => g.video);
    videos.forEach((g) => {
      const vid = `video-${++videoCount}`;
      ops.push({ type: "add_video", id: vid, src: srcOf(g.video!), x: nodes.length * (W + GAP), y, w: 640, h: 360, autoplay: false, label: `Recording · ${g.name}` });
      ids.push(vid);
    });
    y += rowH + (tallest ? 90 + tallest : 0) + 300;
  }

  if (unattached.length) {
    const hid = "unattached-findings";
    ops.push({ type: "add_shape", id: hid, kind: "text", x: 0, y: y - 130, text: "Findings without a screenshot", color: "black" });
    ids.push(hid);
    unattached.forEach((f, i) => {
      const fid = `finding-${f.key}`.slice(0, 64);
      ops.push({ type: "add_finding", id: fid, x: i * (FINDING_W + 40), y, title: f.title, severity: f.severity, expected: f.expected, actual: f.actual, verified: f.verified, timestamp: f.timestamp });
      ids.push(fid);
    });
  }

  if (opts.focus !== false) ops.push({ type: "focus", ids });
  if (!opts.idPrefix && !opts.origin) return ops;
  const prefix = opts.idPrefix ?? "";
  if (prefix.length > 24 || /[^a-zA-Z0-9_-]/.test(prefix)) throw new Error("idPrefix must contain at most 24 letters, digits, underscores or hyphens");
  const names = new Map<string, string>();
  const scoped = (id: string): string => {
    if (!prefix) return id;
    if (!names.has(id)) {
      let hash = 2166136261;
      for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      const full = `${prefix}-${id}`;
      names.set(id, full.length <= 64 ? full : `${full.slice(0, 55)}-${(hash >>> 0).toString(16).padStart(8, "0")}`);
    }
    return names.get(id)!;
  };
  return ops.map((op) => {
    const out = { ...op } as Op;
    if ("id" in out && out.id) out.id = scoped(out.id);
    if ("target" in out && out.target) out.target = scoped(out.target);
    if (out.type === "add_arrow") { out.from = scoped(out.from); out.to = scoped(out.to); }
    if (out.type === "focus" && out.ids) out.ids = out.ids.map(scoped);
    if ("x" in out) out.x += opts.origin?.x ?? 0;
    if ("y" in out) out.y += opts.origin?.y ?? 0;
    return out;
  });
}

export default runToOps;
