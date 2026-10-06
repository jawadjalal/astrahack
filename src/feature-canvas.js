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
  const base = String(options.canvasUrl || process.env.CANVAS_URL || defaultCanvasUrl).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || fetch;
  const runId = createHash('sha256').update(`${absoluteManifest}:${manifest.createdAt || ''}`).digest('hex').slice(0, 8);
  const state = await canvasRequest(fetchImpl, base, '/api/state');
  const existing = new Set();
  for (const envelope of state.ops || []) {
    const op = envelope.op || {};
    if (op.type === 'clear') existing.clear();
    else if (op.type === 'delete') existing.delete(op.id);
    else if (op.id && (op.type?.startsWith('add_') || op.type === 'annotate')) existing.add(op.id);
  }
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
    const y = rowHeights.slice(0, row).reduce((sum, value) => sum + value + gap, 0);
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
      src: uploaded.url, x: column * (width + gap), y, w: width, h: height,
      label: String(entry.feature.name || 'Observed feature').slice(0, 120), step: position + 1
    });
  }
  if (manifest.gaps.length) {
    const y = rowHeights.reduce((sum, value) => sum + value + gap, 0);
    const preview = manifest.gaps.slice(0, 8).map(gap => `• ${gap.feature}: ${gap.reason}`).join('\n');
    const remainder = manifest.gaps.length > 8 ? `\n… and ${manifest.gaps.length - 8} more in manifest.json` : '';
    const id = `capture-${runId}-gaps`;
    ids.push(id);
    if (!existing.has(id)) ops.push({ type: 'add_shape', id, kind: 'note', x: 0, y,
      w: 1060, h: Math.min(700, 130 + Math.min(manifest.gaps.length, 8) * 62),
      text: `Screenshot coverage: observed screens only\n${manifest.gaps.length} gap(s)\n${preview}${remainder}`, color: 'orange' });
  }
  if (!ops.length) return { canvasUrl: base, imageCount: entries.length, gapCount: manifest.gaps.length, ids, postedCount: 0 };
  const posted = await canvasRequest(fetchImpl, base, '/api/ops', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ops)
  });
  if (!Array.isArray(posted.ids) || posted.ids.length !== ops.length) throw new Error('Canvas did not acknowledge every operation');
  return { canvasUrl: base, imageCount: entries.length, gapCount: manifest.gaps.length, ids, postedCount: ops.length };
}
