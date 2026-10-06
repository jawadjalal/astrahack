// Judge scorecard ops: notes under the UGC cards that push-kit (canvas/src/lib/kitToOps.ts, ids `ugc-<S1|H2>`) or the
// older kit lane (`<prefix>-ugc-hook-N`) drew, a `say` summary, and arrow_to from each note to the card that shows the
// original hook (matched by the hook's text, so it never points at the wrong card).

const W = 380, GAP = 40;
const noteHeight = (text, w) => Math.max(120, Math.ceil(String(text).length / Math.floor(w / 9)) * 24 + 56);
const UGC_ID = /(^|-)ugc-/;

/** Live UGC cards on the board ({id, text}) and their bounding box; null if there are none. */
export function findUgcLane(envs) {
  const live = new Map();
  for (const e of envs) {
    const op = e?.op ?? e;
    if (op.type === 'clear') live.clear();
    else if (op.type === 'delete') live.delete(op.id);
    else if (op.type === 'move' && live.has(op.id)) Object.assign(live.get(op.id), { x: op.x, y: op.y });
    else if (op.type === 'add_shape' && typeof op.id === 'string' && UGC_ID.test(op.id) && typeof op.x === 'number') {
      live.set(op.id, { id: op.id, text: String(op.text || ''), x: op.x, y: op.y, w: op.w ?? 380, h: op.h ?? 200 });
    }
  }
  if (!live.size) return null;
  const cards = [...live.values()];
  const minX = Math.min(...cards.map((c) => c.x)), maxY = Math.max(...cards.map((c) => c.y + c.h));
  const m = cards[0].id.match(/^(.*?)-?ugc-/);
  return { prefix: m?.[1] || 'ugc', cards, minX, maxY };
}

/** Where the board ends (for a board with no UGC cards). */
function boardBounds(envs) {
  let maxX = 0, minY = Infinity;
  for (const e of envs) {
    const op = e?.op ?? e;
    if (!/^add_/.test(op.type) || typeof op.x !== 'number' || op.x < -50000) continue;
    maxX = Math.max(maxX, op.x + (op.w ?? 520));
    minY = Math.min(minY, op.y);
  }
  return { maxX, minY: Number.isFinite(minY) ? minY : 0 };
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
    const cards = (lane?.cards || []).filter((c) => c.text.includes(`"${v1.text}"`));
    const card = (cards.find((c) => c.id === `ugc-${r.id}`) || cards[0])?.id;
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
