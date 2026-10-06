// Draws the marketing kit (ads, campaigns, UGC plan) as a lane to the right of a teardown board, using only the
// public op contract (add_shape, add_image, add_arrow). Everything in the lane is marked PROPOSED: the observed
// evidence stays on the left, the generated ideas stay clearly separate.
//
// Kit shape:
//   { label?, ads:[{headline, body, image(url|data url|local path), angle}], campaigns:[{channel, title, objective, posts:[{title, copy}]}],
//     ugc:{ source?, hooks:[{id,text,format}], scripts:[{id,title,platform,durationSec}] } }
// If canvas/scripts/push-kit.mjs exists (the real kit renderer), teardown.mjs prefers it over this lane.

const CREATES = new Set(['add_image', 'add_video', 'add_shape', 'add_arrow', 'annotate', 'add_finding']);

// Where the existing board ends, from /api/state ops. Falls back to 0.
export function boardBounds(envs) {
  let maxX = -Infinity, minY = Infinity, any = false;
  const dead = new Set();
  for (const { op } of envs) { if (op.type === 'clear') dead.clear(); else if (op.type === 'delete') dead.add(op.id); }
  for (const { op } of envs) {
    if (!CREATES.has(op.type) || typeof op.x !== 'number' || dead.has(op.id)) continue;
    if (op.x < -50000) continue; // smoke-test or parked elements
    any = true;
    maxX = Math.max(maxX, op.x + (op.w ?? 520));
    minY = Math.min(minY, op.y);
  }
  return any ? { maxX, minY } : { maxX: 0, minY: 0 };
}

const noteHeight = (text, w) => Math.max(120, Math.ceil(String(text).length / Math.floor(w / 9)) * 24 + 56);

/**
 * @param {object} kit
 * @param {{ x:number, y:number, prefix?:string, resolveImage?:(src:string)=>Promise<string> }} opts
 * @returns {Promise<{ ops: object[], groups: object[][] }>} ops, plus the same ops grouped per element for live posting
 */
export async function kitToLaneOps(kit, { x, y, prefix = 'kit', resolveImage = async (s) => s }) {
  const groups = [];
  const add = (...ops) => { groups.push(ops); return ops; };
  let cy = y;
  const COL = 380, GAP = 40;
  const headerText = (id, text) => add({ type: 'add_shape', id: `${prefix}-${id}`, kind: 'text', x, y: cy, w: 900, text, color: 'black' });

  add({ type: 'add_shape', id: `${prefix}-title`, kind: 'text', x, y: cy, w: 1000, text: `LAUNCH KIT  (proposals, not observed facts)${kit.label ? `  ·  ${kit.label}` : ''}`, color: 'violet' });
  cy += 90;

  const ads = (kit.ads || []).slice(0, 6);
  if (ads.length) {
    headerText('ads-h', 'Ad creatives');
    cy += 70;
    let ax = x;
    for (const [i, ad] of ads.entries()) {
      const src = await resolveImage(ad.image);
      if (!src) continue;
      add({ type: 'add_image', id: `${prefix}-ad-${i + 1}`, src, x: ax, y: cy, w: COL, h: COL, label: `${ad.angle || 'ad'}: ${ad.headline || ''}`.slice(0, 80) });
      ax += COL + GAP;
    }
    cy += COL + 100;
  }

  const camps = kit.campaigns || [];
  for (const [ci, c] of camps.entries()) {
    headerText(`camp-${ci}-h`, `${c.channel === 'x' ? 'X' : c.channel === 'reddit' ? 'Reddit' : c.channel} campaign`);
    cy += 70;
    const intro = `PROPOSED · ${c.title || ''}\n${c.objective || ''}`.trim();
    add({ type: 'add_shape', id: `${prefix}-camp-${ci}-intro`, kind: 'note', x, y: cy, w: COL, h: noteHeight(intro, COL), text: intro, color: 'violet' });
    let px = x + COL + GAP;
    let rowH = noteHeight(intro, COL);
    for (const [pi, p] of (c.posts || []).slice(0, 4).entries()) {
      const text = `PROPOSED · ${p.title || `Post ${pi + 1}`}\n${p.copy || ''}`.slice(0, 700);
      const h = noteHeight(text, COL);
      add({ type: 'add_shape', id: `${prefix}-camp-${ci}-post-${pi + 1}`, kind: 'note', x: px, y: cy, w: COL, h, text, color: 'yellow' });
      px += COL + GAP;
      rowH = Math.max(rowH, h);
    }
    cy += rowH + 90;
  }

  const ugc = kit.ugc;
  if (ugc && (ugc.hooks?.length || ugc.scripts?.length)) {
    headerText('ugc-h', `UGC plan${ugc.source ? ` (${ugc.source})` : ''}`);
    cy += 70;
    let ux = x;
    let rowH = 0;
    for (const [i, h] of (ugc.hooks || []).slice(0, 6).entries()) {
      const text = `PROPOSED HOOK · ${h.format || ''}\n"${h.text}"`;
      const hh = noteHeight(text, COL);
      add({ type: 'add_shape', id: `${prefix}-ugc-hook-${i + 1}`, kind: 'note', x: ux, y: cy, w: COL, h: hh, text, color: 'green' });
      ux += COL + GAP;
      rowH = Math.max(rowH, hh);
    }
    cy += rowH + 40;
    if (ugc.scripts?.length) {
      const text = 'SCRIPTS\n' + ugc.scripts.slice(0, 6).map((s) => `${s.id} · ${s.title} (${s.platform}${s.durationSec ? `, ${s.durationSec}s` : ''})`).join('\n');
      add({ type: 'add_shape', id: `${prefix}-ugc-scripts`, kind: 'note', x, y: cy, w: COL * 2 + GAP, h: noteHeight(text, COL * 2), text, color: 'green' });
      cy += noteHeight(text, COL * 2) + 60;
    }
  }

  const ops = groups.flat();
  const ids = new Set(ops.map((o) => o.id));
  const focus = { type: 'focus', ids: [...ids].filter((id) => typeof id === 'string').slice(0, 80) };
  groups.push([focus]);
  return { ops: [...ops, focus], groups };
}
