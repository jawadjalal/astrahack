import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishFeatureCaptures } from '../src/feature-canvas.js';

function png(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test('uploads selected PNGs and posts existing canvas ops; retry is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'astrahack-canvas-'));
  const calls = { uploads: 0, ops: 0 };
  const state = { seq: 1, ops: [{ seq: 1, op: { type: 'add_image', id: 'raw-evidence', src: '/uploads/raw.png', x: 100, y: 0, w: 700, h: 500 } }] };
  const fakeFetch = async (url, init) => {
    if (url.endsWith('/api/state')) return { ok: true, json: async () => state };
    if (url.endsWith('/api/upload')) {
      calls.uploads++;
      assert.equal(init.body instanceof FormData, true);
      assert.equal(init.body.get('file').name, 'feature_screen.png');
      return { ok: true, json: async () => ({ url: `/uploads/test-${calls.uploads}.png` }) };
    }
    if (url.endsWith('/api/ops')) {
      calls.ops++;
      const ops = JSON.parse(init.body);
      assert.equal(Array.isArray(ops), true);
      for (const op of ops) state.ops.push({ seq: ++state.seq, op });
      return { ok: true, json: async () => ({ ok: true, seqs: state.ops.map(item => item.seq), ids: ops.map(op => op.id) }) };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const shot = join(dir, 'feature screen.png');
    await writeFile(shot, png(1200, 800));
    const manifestPath = join(dir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({ createdAt: '2026-10-06T00:00:00Z',
      features: [{ id: 'F001', name: 'Search', screenshots: [{ path: 'feature screen.png' }] }],
      gaps: [{ feature: 'Export', reason: 'No screenshot evidence' }]
    }));
    const canvasUrl = 'http://localhost:3000';
    const first = await publishFeatureCaptures(manifestPath, { canvasUrl, fetchImpl: fakeFetch });
    assert.equal(first.imageCount, 1);
    assert.equal(first.gapCount, 1);
    assert.equal(first.postedCount, 2);
    assert.equal(calls.uploads, 1);
    assert.equal(calls.ops, 1);
    assert.deepEqual(state.ops.map(item => item.op.type), ['add_image', 'add_image', 'add_shape']);
    assert.equal(state.ops[1].op.src, '/uploads/test-1.png');
    assert.equal(state.ops[1].op.x, 960);
    assert.equal(state.ops[1].op.w, 480);
    assert.equal(state.ops[1].op.h, 320);
    assert.ok(state.ops[1].op.id.length <= 64);
    assert.match(state.ops[2].op.text, /observed screens only/);
    const retry = await publishFeatureCaptures(manifestPath, { canvasUrl, fetchImpl: fakeFetch });
    assert.equal(retry.postedCount, 0);
    assert.equal(calls.uploads, 1);
    assert.equal(calls.ops, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects a screenshot path outside the manifest directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'astrahack-canvas-path-'));
  try {
    const manifestPath = join(dir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({ features: [{ id: 'F001', name: 'Bad path', screenshots: [{ path: '../private.png' }] }], gaps: [] }));
    await assert.rejects(publishFeatureCaptures(manifestPath, {
      fetchImpl: async () => ({ ok: true, json: async () => ({ ops: [] }) })
    }), /leaves manifest directory/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
