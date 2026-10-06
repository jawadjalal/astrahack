import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTiming, planSegments, segmentArgs, concatArgs, xfadeOffsets, chromeArgs, ctaButton, ttsBody,
  liveElements, findScriptCard, videoOps, FADE, FFMPEG, TTS_URL,
} from '../video/animatic.mjs';
import { screenLayout, accentIndex, beatHtml } from '../video/frames.mjs';
import { parseArgs } from '../bin/video.js';

const FIX = 'ugc/fixtures/ignura';
const plan = JSON.parse(readFileSync(join(FIX, 'ugc-plan.json'), 'utf8'));
const hasFfmpeg = (() => { try { execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('parseTiming: ranges, units, dashes, mm:ss, fallback', () => {
  assert.equal(parseTiming('0-2s'), 2);
  assert.equal(parseTiming('2-8s'), 6);
  assert.equal(parseTiming('18 – 26 s'), 8);
  assert.equal(parseTiming('26-30sec'), 4);
  assert.equal(parseTiming('1.5-3.0s'), 1.5);
  assert.equal(parseTiming('0:02-0:08'), 6);
  assert.equal(parseTiming('4s'), 4);
  assert.equal(parseTiming(''), 3);
  assert.equal(parseTiming(undefined), 3);
  assert.equal(parseTiming('later'), 3);
  assert.equal(parseTiming('8-2s'), 3, 'backwards range falls back');
  assert.equal(parseTiming('soon', 5), 5);
});

test('planSegments: hook beat becomes the title card, CTA end card appended', () => {
  const s1 = plan.scripts[0];
  const segs = planSegments(plan, s1, FIX);
  assert.equal(segs[0].kind, 'title');
  assert.equal(segs[0].dur, 2);
  assert.equal(segs.at(-1).kind, 'end');
  assert.equal(segs.length, s1.beats.length + 1);
  assert.ok(segs.slice(1, -1).every((s) => s.kind === 'beat' && existsSync(s.asset)));
  assert.equal(segs.slice(0, -1).reduce((a, s) => a + s.dur, 0), 30);
});

test('planSegments: missing timing falls back to 3s, missing asset becomes a card', () => {
  const script = { id: 'SX', hookId: 'nope', title: 'T', cta: 'Go', beats: [
    { t: '0-2s', onScreenText: 'a', assetRef: 'screenshots/000-initial.png' },
    { t: '??', onScreenText: 'b', assetRef: 'screenshots/missing.png' },
  ] };
  const segs = planSegments(plan, script, FIX);
  assert.deepEqual(segs.map((s) => s.kind), ['title', 'beat', 'card', 'end']);
  assert.equal(segs[2].dur, 3);
});

test('layout: landscape -> browser frame, portrait -> phone, even sizes', () => {
  const b = screenLayout(1280, 713);
  assert.equal(b.kind, 'browser');
  assert.equal(b.hole.h % 2, 0);
  assert.ok(b.hole.x + b.hole.w <= 1080);
  assert.equal(screenLayout(390, 844).kind, 'phone');
  assert.equal(accentIndex('Book a free call'.split(' ')), 3);
  const html = beatHtml({ brand: 'X<y>', scriptId: 'S1', idx: 1, total: 4, timing: '2-8s', layout: b, url: 'x.com', caption: 'Hi there', voiceover: 'v', shot: 's' });
  assert.match(html, /X&lt;y&gt;/);
});

test('command construction: chrome, segment, xfade concat', () => {
  const c = chromeArgs('/tmp/a b.html', '/tmp/out.png');
  assert.ok(c.includes('--headless=new') && c.includes('--hide-scrollbars') && c.includes('--window-size=1080,1920'));
  assert.ok(c.includes('--screenshot=/tmp/out.png'));
  assert.equal(c.at(-1), 'file:///tmp/a%20b.html');

  const layout = screenLayout(1280, 713);
  const beat = segmentArgs({ kind: 'beat', dur: 6, asset: '/s.png' }, 1, { framePng: '/f.png', outFile: '/o.mp4', layout });
  const fc = beat[beat.indexOf('-filter_complex') + 1];
  assert.match(fc, /zoompan=z='1\+0\.12\*on\/\d+'/);
  assert.match(fc, new RegExp(`overlay=${layout.hole.x}:${layout.hole.y}`));
  assert.equal(beat[beat.indexOf('-t') + 1], String(6 + FADE), 'non-last segments carry the fade overlap');
  const last = segmentArgs({ kind: 'end', dur: 2.5, last: true }, 5, { framePng: '/f.png', outFile: '/o.mp4' });
  assert.equal(last[last.lastIndexOf('-t') + 1], '2.5');

  assert.deepEqual(xfadeOffsets([2, 6, 10, 2.5]), [2, 8, 18]);
  const cat = concatArgs(['a.mp4', 'b.mp4', 'c.mp4'], [2, 6, 2.5], 'out.mp4');
  const cfc = cat[cat.indexOf('-filter_complex') + 1];
  assert.match(cfc, /\[0:v\]\[1:v\]xfade=transition=fade:duration=0\.35:offset=2\[x0\]/);
  assert.match(cfc, /\[x0\]\[2:v\]xfade=.*offset=8\[v\]/);
  assert.equal(cat[cat.indexOf('-t') + 1], '10.5');
  const withVo = concatArgs(['a.mp4', 'b.mp4'], [2, 3], 'o.mp4', { clips: [{ file: 'v.mp3', at: 2.08, tempo: 1.2 }] });
  const vfc = withVo[withVo.indexOf('-filter_complex') + 1];
  assert.match(vfc, /\[2:a\]aresample=44100,atempo=1\.200,adelay=2080:all=1\[a0\]/);
  assert.ok(withVo.includes('aac'));
});

test('TTS request body and CTA label', () => {
  assert.equal(TTS_URL, 'https://api.openai.com/v1/audio/speech');
  const b = ttsBody('hi');
  assert.equal(b.input, 'hi');
  assert.ok(b.model && b.voice);
  assert.equal(ctaButton('Book a free call (link in bio)'), 'Book a free call');
});

test('canvas placement: next to the UGC card, else below the lane', () => {
  const envs = [
    { op: { type: 'add_shape', id: 'kit-ugc-hook-1', kind: 'note', x: 100, y: 500, w: 380, h: 200, text: 'hook' } },
    { op: { type: 'add_shape', id: 'kit-ugc-scripts', kind: 'note', x: 100, y: 800, w: 800, h: 300, text: 'SCRIPTS\nS1 · One\nS2 · Two' } },
  ];
  const live = liveElements(envs);
  assert.equal(findScriptCard(live, 'S1').id, 'kit-ugc-scripts');
  assert.equal(findScriptCard(live, 'S9'), null);
  const { ops } = videoOps({ live, scriptId: 'S1', src: '/uploads/a.mp4' });
  assert.equal(ops[0].type, 'add_video');
  assert.equal(ops[0].x, 100 + 800 + 40);
  assert.equal(ops[0].y, 800);
  assert.equal(ops[1].type, 'add_arrow');
  const below = videoOps({ live, scriptId: 'S9', src: '/u.mp4' }).ops[0];
  assert.equal(below.y, 800 + 300 + 80);
  const byId = liveElements([{ op: { type: 'add_shape', id: 'ugc-s2', kind: 'note', x: 0, y: 0, w: 300 } }]);
  assert.equal(findScriptCard(byId, 'S2').id, 'ugc-s2');
});

test('CLI args', () => {
  assert.deepEqual(parseArgs(['animatic', 'runs/x', '--script', 'S2', '--canvas', 'http://h', '--dry-run']),
    { cmd: 'animatic', runDir: 'runs/x', script: 'S2', canvas: 'http://h', dryRun: true, voice: true });
  assert.throws(() => parseArgs(['render', 'x']));
  assert.throws(() => parseArgs(['animatic', 'x', '--bogus']));
});

test('dry run prints the plan without rendering', () => {
  const out = execFileSync(process.execPath, ['bin/video.js', 'animatic', FIX, '--script', 'S2', '--dry-run'], { encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: '' } });
  assert.match(out, /S2: 6 segments/);
  assert.match(out, /xfade/);
});

test('ffmpeg: concat with a voiceover clip produces audio + video', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'vid-'));
  try {
    const seg = (n, c) => { const f = join(dir, `${n}.mp4`); execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${c}:s=108x192:r=30:d=1.35`, '-pix_fmt', 'yuv420p', f]); return f; };
    const a = seg('a', 'red'), b = seg('b', 'blue');
    const vo = join(dir, 'vo.m4a');
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=0.5', vo]);
    const out = join(dir, 'out.mp4');
    execFileSync(FFMPEG, concatArgs([a, b], [1, 1], out, { clips: [{ file: vo, at: 0.1, tempo: 1 }] }));
    const probe = execFileSync(FFMPEG.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out], { encoding: 'utf8' });
    assert.match(probe, /video/);
    assert.match(probe, /audio/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
