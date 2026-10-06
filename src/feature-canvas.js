import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';

const defaultCanvasUrl = 'http://localhost:3000';

function localFile(base, path) {
  if (typeof path !== 'string' || !path.toLowerCase().endsWith('.png')) throw new Error(`Invalid screenshot path: ${path}`);
  const full = resolve(base, path);
  const rel = relative(base, full);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error(`Screenshot path leaves manifest directory: ${path}`);
  return full;
}

function pngSize(bytes) {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Screenshot is not a valid PNG');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) throw new Error('Screenshot has invalid PNG dimensions');
  return { width, height };
}

async function canvasRequest(fetchImpl, base, path, init) {
  let response;
  try { response = await fetchImpl(`${base}${path}`, init); }
  catch (error) { throw new Error(`Cannot reach canvas at ${base}: ${error.message}`); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(`Canvas ${path} returned HTTP ${response.status}: ${body.error || 'unknown error'}`);
  return body;
}

/** Upload a feature capture manifest to the existing canvas HTTP operation contract. */
export async function publishFeatureCaptures(manifestPath, options = {}) {
  const absoluteManifest = resolve(manifestPath);
  const directory = dirname(absoluteManifest);
  const manifest = JSON.parse(await readFile(absoluteManifest, 'utf8'));
  if (!Array.isArray(manifest.features) || !Array.isArray(manifest.gaps)) throw new Error('Invalid feature capture manifest');
  const unmappedCount = manifest.unmappedReportedFeatures?.length || 0;
  const reviewNotes = manifest.reviewNotes || [];
  const base = String(options.canvasUrl || process.env.CANVAS_URL || defaultCanvasUrl).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || fetch;
  const runId = createHash('sha256').update(`${absoluteManifest}:${manifest.createdAt || ''}`).digest('hex').slice(0, 8);
  const state = await canvasRequest(fetchImpl, base, '/api/state');
  const existing = new Map();
  for (const envelope of state.ops || []) {
    const op = envelope.op || {};
    if (op.type === 'clear') existing.clear();
    else if (op.type === 'delete') existing.delete(op.id);
    else if (op.type === 'move' && existing.has(op.id)) Object.assign(existing.get(op.id), { x: op.x, y: op.y });
    else if (op.type === 'update' && existing.has(op.id)) Object.assign(existing.get(op.id), op.props || {});
    else if (op.id && (op.type?.startsWith('add_') || op.type === 'annotate')) existing.set(op.id, { ...op });
  }
  const own = [...existing].filter(([id]) => id.startsWith(`capture-${runId}-`)).map(([, op]) => op);
  const bounds = [...existing.values()].filter(op => Number.isFinite(op.x)).map(op => ({
    x: op.x,
    w: Number.isFinite(op.w) ? op.w : op.type === 'add_image' ? 900 : op.type === 'add_video' ? 640 : op.type === 'add_finding' ? 360 : 200
  }));
  const originX = own.length ? Math.min(...own.filter(op => Number.isFinite(op.x)).map(op => op.x)) :
    bounds.length ? Math.max(...bounds.map(op => op.x + op.w)) + 160 : 0;
  const originY = own.length ? Math.min(...own.filter(op => Number.isFinite(op.y)).map(op => op.y)) : 0;
  const entries = manifest.features.flatMap(feature => (feature.screenshots || []).map((screenshot, index) => ({ feature, screenshot, index })));
  const ops = [];
  const ids = [];
  const columns = 3;
  const width = 480;
  const gap = 100;
  const rowHeights = [];
  for (const [position, entry] of entries.entries()) {
    const path = localFile(directory, entry.screenshot.path);
    const bytes = await readFile(path);
    const size = pngSize(bytes);
    const height = Math.max(100, Math.round(width * size.height / size.width));
    const row = Math.floor(position / columns);
    const column = position % columns;
    const y = originY + rowHeights.slice(0, row).reduce((sum, value) => sum + value + gap, 0);
    rowHeights[row] = Math.max(rowHeights[row] || 0, height);
    const id = `capture-${runId}-${entry.feature.id}-${entry.index + 1}`.slice(0, 64);
    ids.push(id);
    if (existing.has(id)) continue;
    const form = new FormData();
    const filename = basename(path).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60) || 'capture.png';
    form.append('file', new Blob([bytes], { type: 'image/png' }), filename);
    const uploaded = await canvasRequest(fetchImpl, base, '/api/upload', { method: 'POST', body: form });
    if (typeof uploaded.url !== 'string' || !uploaded.url) throw new Error('Canvas upload returned no URL');
    ops.push({
      type: 'add_image', id,
      src: uploaded.url, x: originX + column * (width + gap), y, w: width, h: height,
      label: String(entry.feature.name || 'Observed feature').slice(0, 120), step: position + 1
    });
  }
  if (manifest.features.length || manifest.gaps.length || reviewNotes.length || unmappedCount) {
    const y = originY + rowHeights.reduce((sum, value) => sum + value + gap, 0);
    const notes = [
      ...manifest.gaps.map(gap => `• Recorded issue — ${gap.feature}: ${gap.reason}`),
      ...reviewNotes.map(note => `• Batch review hypothesis — ${note.feature}: ${note.reason}`)
    ];
    const preview = notes.slice(0, 8).join('\n');
    const remainder = notes.length > 8 ? `\n… and ${notes.length - 8} more issues or review notes in manifest.json` : '';
    const id = `capture-${runId}-gaps`;
    const noteText = `Screenshot coverage: observed screens only\n${manifest.features.length} feature groups, ${entries.length} screenshots; groups may overlap\n${manifest.gaps.length} recorded capture/coverage issue(s); ${reviewNotes.length} batch-limited review notes (not globally verified)\n${unmappedCount} agent labels not mapped to selected screenshots (may overlap captured groups)\n${preview}${remainder}`;
    ids.push(id);
    if (existing.has(id)) {
      if (existing.get(id).text !== noteText) ops.push({ type: 'update', id, props: { text: noteText } });
    } else ops.push({ type: 'add_shape', id, kind: 'note', x: originX, y,
      w: 1060, h: Math.min(1000, 180 + Math.min(notes.length, 8) * 100),
      text: noteText, color: 'orange' });
  }
  const counts = { imageCount: entries.length, featureGroupCount: manifest.features.length, gapCount: manifest.gaps.length, reviewNoteCount: reviewNotes.length, unmappedCount };
  if (!ops.length) return { canvasUrl: base, ...counts, ids, postedCount: 0 };
  const posted = await canvasRequest(fetchImpl, base, '/api/ops', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ops)
  });
  if (!Array.isArray(posted.ids) || posted.ids.length !== ops.length) throw new Error('Canvas did not acknowledge every operation');
  return { canvasUrl: base, ...counts, ids, postedCount: ops.length };
}
