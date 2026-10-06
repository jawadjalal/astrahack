// Findings, verification and coverage bookkeeping. Pure logic, no I/O.
//
// Finding: { id, title, severity, expected, actual, stepIndex, screenshot, screenshotUrl,
//            timestamp (seconds into the recording), repro[], verified:boolean, verification }
// A finding is verified:true ONLY when the verify pass replayed it (at least one action executed
// in the replay) and the model reported seeing it again on a fresh screenshot. Anything else is
// verified:false with an explanation in `verification`.

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));

export function normalizeSeverity(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (SEVERITIES.includes(v)) return v;
  if (['blocker', 'severe', 'p0'].includes(v)) return 'critical';
  if (['major', 'p1'].includes(v)) return 'high';
  if (['moderate', 'normal', 'p2'].includes(v)) return 'medium';
  if (['minor', 'p3', 'trivial'].includes(v)) return 'low';
  return 'medium';
}

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const titleKey = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export class FindingStore {
  constructor() {
    this.items = [];
    this.nextId = 1;
  }

  // raw: model-provided args. ctx: harness-known facts (step, screenshot, timestamp, point/box).
  add(raw, ctx = {}) {
    const title = clip(raw?.title, 140);
    if (!title) throw new Error('finding needs a title');
    const expected = clip(raw?.expected, 400);
    const actual = clip(raw?.actual, 400);
    if (!expected || !actual) throw new Error('finding needs both expected and actual behaviour');
    const existing = this.items.find(f => titleKey(f.title) === titleKey(title));
    if (existing) {
      // same issue reported twice: keep the earliest, upgrade severity if the new report is worse.
      if (SEVERITY_RANK[normalizeSeverity(raw.severity)] < SEVERITY_RANK[existing.severity]) existing.severity = normalizeSeverity(raw.severity);
      existing.duplicates = (existing.duplicates || 0) + 1;
      return { finding: existing, duplicate: true };
    }
    const finding = {
      id: `F${this.nextId++}`,
      title,
      severity: normalizeSeverity(raw.severity),
      expected,
      actual,
      stepIndex: Number.isInteger(ctx.stepIndex) ? ctx.stepIndex : 0,
      screenshot: ctx.screenshot ?? null,
      screenshotUrl: ctx.screenshotUrl ?? null,
      timestamp: typeof ctx.timestamp === 'number' ? Math.max(0, Math.round(ctx.timestamp * 10) / 10) : null,
      repro: (Array.isArray(raw.repro_steps) ? raw.repro_steps : []).map(s => clip(s, 200)).filter(Boolean).slice(0, 12),
      startUrl: ctx.startUrl ?? null,
      box: normalizeBox(raw.box ?? ctx.box, ctx.size),
      point: ctx.point ?? null,
      verified: false,
      verification: { status: 'not_attempted' },
      recordedAt: ctx.recordedAt ?? new Date().toISOString()
    };
    this.items.push(finding);
    return { finding, duplicate: false };
  }

  get(id) { return this.items.find(f => f.id === id); }

  // Called from the verify pass. `replay` = what the harness itself observed during replay:
  // { actionsExecuted:number, screenshot, screenshotUrl, stepIndex, timestamp }.
  applyVerification(id, { reproduced, observation = '', inconclusive = false }, replay = {}) {
    const f = this.get(id);
    if (!f) throw new Error(`unknown finding ${id}`);
    const executed = replay.actionsExecuted ?? 0;
    if (inconclusive) {
      f.verified = false;
      f.verification = { status: 'inconclusive', observation: clip(observation, 300), actionsExecuted: executed, screenshot: replay.screenshot ?? null, stepIndex: replay.stepIndex ?? null, at: new Date().toISOString() };
      return f;
    }
    if (reproduced && executed < 1) {
      f.verified = false;
      f.verification = { status: 'rejected', reason: 'model claimed reproduction without replaying any action', observation: clip(observation, 300) };
      return f;
    }
    if (reproduced && !replay.screenshot) {
      f.verified = false;
      f.verification = { status: 'rejected', reason: 'no fresh screenshot of the reproduction', observation: clip(observation, 300) };
      return f;
    }
    f.verified = !!reproduced;
    f.verification = {
      status: reproduced ? 'reproduced' : 'not_reproduced',
      observation: clip(observation, 300),
      actionsExecuted: executed,
      screenshot: replay.screenshot ?? null,
      screenshotUrl: replay.screenshotUrl ?? null,
      stepIndex: replay.stepIndex ?? null,
      timestamp: replay.timestamp ?? null,
      at: new Date().toISOString()
    };
    return f;
  }

  markSkipped(id, reason) {
    const f = this.get(id);
    if (f && f.verification.status === 'not_attempted') f.verification = { status: 'not_attempted', reason };
  }

  // Highest severity first, then earliest step.
  sorted() {
    return [...this.items].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.stepIndex - b.stepIndex);
  }

  // Candidates for the verify pass: unverified findings, worst first, capped.
  toVerify(limit = 6) {
    return this.sorted().filter(f => !f.verified && f.verification.status === 'not_attempted').slice(0, limit);
  }

  counts() {
    const out = { total: this.items.length, verified: 0, unverified: 0 };
    for (const s of SEVERITIES) out[s] = 0;
    for (const f of this.items) { out[f.severity]++; if (f.verified) out.verified++; else out.unverified++; }
    return out;
  }

  // Shape the canvas `add_finding` op needs (position/target are added by the streamer).
  toCanvas(f) {
    return { title: f.title, severity: f.severity, expected: f.expected, actual: f.actual, verified: f.verified, ...(f.timestamp != null ? { timestamp: f.timestamp } : {}) };
  }

  toJSON() { return this.items; }
}

function normalizeBox(box, size) {
  if (!box || typeof box !== 'object') return null;
  let { x, y, w, h } = box;
  if (![x, y, w, h].every(Number.isFinite)) return null;
  // accept pixels (with image size) or fractions
  if (size && (x > 1 || y > 1 || w > 1 || h > 1)) { x /= size.width; y /= size.height; w /= size.width; h /= size.height; }
  x = Math.min(Math.max(x, 0), 1); y = Math.min(Math.max(y, 0), 1);
  w = Math.min(Math.max(w, 0.005), 1 - x); h = Math.min(Math.max(h, 0.005), 1 - y);
  return { x, y, w, h };
}

// Fractional annotate box for a pixel point on a screenshot (the click target halo).
export function boxAroundPoint(point, size, radiusPx = 36) {
  const x = Math.max(0, point.x - radiusPx);
  const y = Math.max(0, point.y - radiusPx);
  const w = Math.min(size.width, point.x + radiusPx) - x;
  const h = Math.min(size.height, point.y + radiusPx) - y;
  return { x: x / size.width, y: y / size.height, w: w / size.width, h: h / size.height };
}

// ---- coverage ----

export class Coverage {
  constructor() {
    this.visited = new Map();
    this.unreachable = new Map();
  }

  note({ screen, status, detail = '', stepIndex = null }) {
    const key = clip(screen, 120);
    if (!key) throw new Error('coverage entry needs a screen name');
    if (status === 'unreachable' || status === 'blocked') {
      this.unreachable.set(key, { screen: key, reason: clip(detail, 240), stepIndex });
      this.visited.delete(key);
    } else {
      this.visited.set(key, { screen: key, how: clip(detail, 240), stepIndex });
      this.unreachable.delete(key);
    }
  }

  // Harness-observed URLs: ground truth for "visited", independent of what the model claims.
  noteUrl(url, stepIndex) {
    if (!url || /^(about:|data:)/.test(url)) return;
    const key = url.replace(/#.*$/, '');
    if (!this.visited.has(key)) this.visited.set(key, { screen: key, how: 'observed by harness', stepIndex });
  }

  toJSON() { return { visited: [...this.visited.values()], unreachable: [...this.unreachable.values()] }; }
}
