// Judge scorecard ops: notes next to the UGC lane drawn by scripts/lib/kit-lane.mjs (ids `<prefix>-ugc-hook-N`),
// a `say` summary, and arrow_to from each scorecard to the original hook card when it can be found.
import { boardBounds } from '../scripts/lib/kit-lane.mjs';

const W = 380, GAP = 40;
const noteHeight = (text, w) => Math.max(120, Math.ceil(String(text).length / Math.floor(w / 9)) * 24 + 56);

/** Locate the latest UGC lane on the board: hook card ids by 1-based index, and the lane's bottom-left corner. */
export function findUgcLane(envs) {
  const dead = new Set();
  for (const { op } of envs) { if (op.type === 'clear') dead.clear(); else if (op.type === 'delete') dead.add(op.id); }
  const lanes = new Map(); // prefix -> {cards, minX, maxY}
  for (const { op } of envs) {
    const m = typeof op.id === 'string' && op.id.match(/^(.*)-ugc-(hook-(\d+)|scripts|h)$/);
    if (!m || dead.has(op.id) || typeof op.x !== 'number') continue;
    const lane = lanes.get(m[1]) || { prefix: m[1], cards: new Map(), minX: Infinity, maxY: -Infinity };
    if (m[3]) lane.cards.set(Number(m[3]), { id: op.id, text: String(op.text || '') });
    lane.minX = Math.min(lane.minX, op.x);
    lane.maxY = Math.max(lane.maxY, op.y + (op.h ?? 60));
    lanes.set(m[1], lane);
  }
  const all = [...lanes.values()];
  return all.length ? all[all.length - 1] : null;
}

/**
 * @param {{summary, items}} report  from judgePlan
 * @param {object} plan  the ORIGINAL plan (hook order = lane card order, the lane shows the first 6 hooks)
 * @param {object[]} envs  /api/state ops (may be empty)
 */
export function judgeOps(report, plan, envs = [], { tag = Date.now().toString(36).slice(-4) } = {}) {
  const lane = findUgcLane(envs);
  let x, y;
  if (lane) { x = lane.minX; y = lane.maxY + 120; }
  else { const b = boardBounds(envs); x = b.maxX + 600; y = b.minY; }
  const id = (s) => `judge-${tag}-${s}`.slice(0, 64);
  const ops = [];
  const { summary } = report;
  const hooks = report.items.filter((r) => r.kind === 'hook' && r.rewritten);
  ops.push({ type: 'add_shape', id: id('title'), kind: 'text', x, y, w: 1000, color: 'orange',
    text: `JUDGE  ·  ${summary.judge}  ·  hooks ${summary.hooks.before.toFixed(1)} → ${summary.hooks.after.toFixed(1)}  ·  scripts ${summary.scripts.before.toFixed(1)} → ${summary.scripts.after.toFixed(1)}` });
  y += 80;
  let cx = x, rowH = 0, col = 0;
  for (const r of hooks) {
    const v1 = r.versions[0], v2 = r.versions[r.versions.length - 1];
    const text = `${r.id}  ${v1.overall.toFixed(1)} → ${v2.overall.toFixed(1)}\nv1 "${v1.text}"\nv2 "${v2.text}"\nwhy: ${v1.rationale}`.slice(0, 600);
    const h = noteHeight(text, W);
    const nid = id(r.id);
    ops.push({ type: 'add_shape', id: nid, kind: 'note', x: cx, y, w: W, h, text, color: 'orange' });
    // match the lane card by its hook text (the lane may come from another plan); index is only a tiebreak
    const idx = plan.hooks.findIndex((hk) => hk.id === r.id) + 1;
    const cards = lane ? [...lane.cards.entries()] : [];
    const card = (cards.find(([n, c]) => n === idx && c.text.includes(v1.text)) || cards.find(([, c]) => c.text.includes(v1.text)))?.[1]?.id;
    if (card) ops.push({ type: 'arrow_to', id: id(`a-${r.id}`), from: nid, to: card, label: `v2 ${v2.overall.toFixed(1)}`, color: 'orange' });
    rowH = Math.max(rowH, h);
    cx += W + GAP;
    if (++col % 4 === 0) { cx = x; y += rowH + GAP; rowH = 0; }
  }
  if (col % 4) y += rowH + GAP;
  const scripts = report.items.filter((r) => r.kind === 'script');
  const sText = 'SCRIPTS (judge)\n' + scripts.map((r) => `${r.id}  ${r.before.toFixed(1)} → ${r.after.toFixed(1)}${r.rewritten ? '' : '  kept'}`).join('\n');
  ops.push({ type: 'add_shape', id: id('scripts'), kind: 'note', x, y, w: W, h: noteHeight(sText, W), text: sText, color: 'yellow' });
  const say = `Judge: ${summary.hooks.rewritten} hooks rewritten, avg ${summary.hooks.before.toFixed(1)} → ${summary.hooks.after.toFixed(1)}; ${summary.scripts.rewritten} scripts, avg ${summary.scripts.before.toFixed(1)} → ${summary.scripts.after.toFixed(1)}`;
  ops.push({ type: 'say', id: id('say'), text: say.slice(0, 600), target: id('title') });
  ops.push({ type: 'focus', ids: ops.filter((o) => o.type === 'add_shape').map((o) => o.id) });
  return { ops, lane: lane?.prefix || null, say };
}
