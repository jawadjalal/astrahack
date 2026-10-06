// Storyboard animatic: ugc-plan.json script -> vertical 1080x1920 MP4.
// Frames are HTML rendered to PNG by headless Chrome (video/frames.mjs); ffmpeg adds a Ken Burns layer for the
// real screenshot under each frame's transparent hole, then joins the segments with crossfades.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { W, H, beatHtml, titleHtml, endHtml, screenLayout } from './frames.mjs';

const run = promisify(execFile);
export const FPS = 30;
export const FADE = 0.35;           // crossfade seconds
export const DEFAULT_BEAT = 3;      // fallback when a beat's timing can't be parsed
export const TITLE_SEC = 2, END_SEC = 2.5;

export const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const FFMPEG = process.env.FFMPEG_PATH || (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
export const FFPROBE = FFMPEG.replace(/ffmpeg$/, 'ffprobe');

/** "0-2s", "2–8 s", "26-30sec", "3s", "0:02-0:08" -> seconds (end - start). Unparseable -> fallback. */
export function parseTiming(t, fallback = DEFAULT_BEAT) {
  const s = String(t ?? '').trim().toLowerCase().replace(/[–—]/g, '-');
  const num = (x) => {
    x = x.trim().replace(/s(ec(onds?)?)?$/, '').trim();
    if (/^\d+:\d+(\.\d+)?$/.test(x)) { const [m, sec] = x.split(':'); return +m * 60 + +sec; }
    return /^\d+(\.\d+)?$/.test(x) ? +x : NaN;
  };
  const range = s.match(/^(.+?)\s*-\s*(.+)$/);
  if (range) {
    const a = num(range[1]), b = num(range[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) return +(b - a).toFixed(3);
    return fallback;
  }
  const single = num(s);
  return Number.isFinite(single) && single > 0 ? single : fallback;
}

/** PNG width/height from the IHDR chunk (no deps). */
export function pngSize(file) {
  const b = readFileSync(file);
  if (b.length < 24 || b.toString('ascii', 12, 16) !== 'IHDR') return { w: 1280, h: 720 };
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const even = (n) => Math.round(n / 2) * 2;

/**
 * Segments for one script: title card (the hook), one per beat, end card (the CTA).
 * A first beat with no screenshot is the hook itself, so the title card takes its slot and voiceover.
 */
export function planSegments(plan, script, runDir) {
  const hook = plan.hooks?.find((h) => h.id === script.hookId);
  const beats = script.beats || [];
  const segs = [];
  let rest = beats;
  const first = beats[0];
  if (first && !first.assetRef) {
    segs.push({ kind: 'title', dur: parseTiming(first.t), voiceover: first.voiceover, hook: hook?.text || first.onScreenText, timing: first.t });
    rest = beats.slice(1);
  } else {
    segs.push({ kind: 'title', dur: TITLE_SEC, voiceover: hook?.text || '', hook: hook?.text || script.title });
  }
  for (const b of rest) {
    const shotPath = b.assetRef ? resolve(runDir, b.assetRef) : null;
    const has = shotPath && existsSync(shotPath);
    segs.push({ kind: has ? 'beat' : 'card', dur: parseTiming(b.t), timing: b.t || `${DEFAULT_BEAT}s`, caption: b.onScreenText || '', voiceover: b.voiceover || '', shot: b.shot || '', asset: has ? shotPath : null, assetRef: b.assetRef || null });
  }
  segs.push({ kind: 'end', dur: END_SEC, voiceover: '', cta: script.cta || '' });
  return segs;
}

// Strip "(link in bio)" etc. for the button label.
export const ctaButton = (cta) => String(cta || 'Learn more').replace(/\s*\(.*?\)\s*/g, ' ').replace(/[.!]+$/, '').trim();

export function chromeArgs(htmlFile, pngFile) {
  return ['--headless=new', '--hide-scrollbars', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--force-device-scale-factor=1', '--default-background-color=00000000', '--virtual-time-budget=2500',
    `--screenshot=${pngFile}`, `--window-size=${W},${H}`, pathToFileURL(htmlFile).href];
}

/** ffmpeg args for one segment. Beats: paper frame PNG (with hole) over a zoompan of the screenshot. */
export function segmentArgs(seg, i, { framePng, outFile, layout }) {
  const len = +(seg.dur + (seg.last ? 0 : FADE)).toFixed(3);
  const F = Math.max(1, Math.round(len * FPS));
  const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-t', String(len), '-an', outFile];
  if (seg.kind === 'beat') {
    const { hole } = layout;
    const zw = even(hole.w), zh = even(hole.h);
    // alternate the drift so consecutive beats don't move the same way
    const px = i % 2 ? `0.5` : `(0.15+0.7*on/${F})`;
    const py = i % 2 ? `(0.1+0.5*on/${F})` : `0.3`;
    const fc = [
      `color=c=0xfbf6ee:s=${W}x${H}:r=${FPS}:d=${len}[bg]`,
      `[1:v]scale=${zw * 3}:${zh * 3}:flags=lanczos,zoompan=z='1+0.12*on/${F}':x='(iw-iw/zoom)*${px}':y='(ih-ih/zoom)*${py}':d=${F}:s=${zw}x${zh}:fps=${FPS}[kb]`,
      `[bg][kb]overlay=${hole.x}:${hole.y}:eof_action=repeat[a]`,
      `[a][0:v]overlay=0:0:shortest=1,format=yuv420p[v]`,
    ].join(';');
    return ['-y', '-loglevel', 'error', '-loop', '1', '-framerate', String(FPS), '-t', String(len), '-i', framePng, '-i', seg.asset, '-filter_complex', fc, '-map', '[v]', ...enc];
  }
  // cards: a gentle push-in on the whole frame
  const fc = `[0:v]scale=${W * 2}:${H * 2}:flags=lanczos,zoompan=z='1+0.035*on/${F}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=${F}:s=${W}x${H}:fps=${FPS},format=yuv420p[v]`;
  return ['-y', '-loglevel', 'error', '-i', framePng, '-filter_complex', fc, '-map', '[v]', ...enc];
}

/** xfade chain. Segment k (not last) is dur_k + FADE long; fade k starts at sum(dur_0..dur_k) - FADE... see offsets. */
export function xfadeOffsets(durs) {
  const out = [];
  let acc = 0;
  for (let k = 0; k < durs.length - 1; k++) { acc += durs[k]; out.push(+(acc).toFixed(3)); }
  return out;
}

export function concatArgs(segFiles, durs, outFile, audio = null) {
  const inputs = segFiles.flatMap((f) => ['-i', f]);
  const total = +durs.reduce((a, b) => a + b, 0).toFixed(3);
  const offs = xfadeOffsets(durs);
  let fc = [], last = '[0:v]';
  if (segFiles.length === 1) fc.push(`[0:v]null[v]`);
  offs.forEach((off, k) => {
    const out = k === offs.length - 1 ? '[v]' : `[x${k}]`;
    fc.push(`${last}[${k + 1}:v]xfade=transition=fade:duration=${FADE}:offset=${off}${out}`);
    last = out;
  });
  const args = ['-y', '-loglevel', 'error', ...inputs];
  const maps = ['-map', '[v]'];
  if (audio?.clips?.length) {
    const base = segFiles.length;
    for (const c of audio.clips) args.push('-i', c.file);
    audio.clips.forEach((c, j) => {
      const tempo = c.tempo > 1.001 ? `,atempo=${c.tempo.toFixed(3)}` : '';
      fc.push(`[${base + j}:a]aresample=44100${tempo},adelay=${Math.round(c.at * 1000)}:all=1[a${j}]`);
    });
    fc.push(`${audio.clips.map((_, j) => `[a${j}]`).join('')}amix=inputs=${audio.clips.length}:normalize=0,apad[aout]`);
    maps.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '128k');
  }
  return [...args, '-filter_complex', fc.join(';'), ...maps, '-c:v', 'libx264', '-preset', 'medium', '-crf', '24',
    '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart', '-t', String(total), outFile];
}

// ---- OpenAI text-to-speech (optional) -----------------------------------------------------------------------
export const TTS_URL = 'https://api.openai.com/v1/audio/speech';
export const TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
export const TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'coral';

export function openaiKey(cwd = process.cwd()) {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  for (const f of [join(cwd, '.env')]) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, 'utf8').match(/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?/m);
    if (m) return m[1].trim();
  }
  return null;
}

export function ttsBody(text) {
  return { model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: 'mp3',
    instructions: 'Casual, upbeat UGC creator talking to camera on TikTok. Natural, quick pace, warm, not salesy.' };
}

async function tts(text, key, outFile) {
  const res = await fetch(TTS_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ttsBody(text)) });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
}

async function probeDuration(file) {
  try {
    const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    return parseFloat(stdout) || 0;
  } catch { return 0; }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/**
 * Render one script. Returns { mp4, poster, durationSec, segments }.
 * opts: { dryRun, log, voice: boolean }
 */
export async function renderScript(plan, script, runDir, opts = {}) {
  const log = opts.log || (() => {});
  const brand = plan.product?.name || 'product';
  const site = (plan.source?.target || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const outDir = join(runDir, 'video');
  const work = join(outDir, `.work-${script.id}`);
  const mp4 = join(outDir, `animatic-${script.id}.mp4`);
  const poster = join(outDir, `animatic-${script.id}.png`);
  const segs = planSegments(plan, script, runDir);
  segs[segs.length - 1].last = true;
  const total = segs.length;
  const hookMeta = [script.platform, script.durationSec ? `${script.durationSec}s` : '', script.format, plan.creators?.find((c) => c.id === script.creatorId)?.archetype]
    .filter(Boolean);
  const preview = segs.find((s) => s.asset)?.asset || null;

  const jobs = segs.map((seg, i) => {
    const html = join(work, `f${String(i).padStart(2, '0')}.html`);
    const png = join(work, `f${String(i).padStart(2, '0')}.png`);
    const out = join(work, `s${String(i).padStart(2, '0')}.mp4`);
    let doc, layout = null;
    if (seg.kind === 'title') doc = titleHtml({ brand, scriptId: script.id, hook: seg.hook, meta: hookMeta, total, preview });
    else if (seg.kind === 'end') doc = endHtml({ brand, scriptId: script.id, cta: seg.cta, button: ctaButton(seg.cta), site, total });
    else {
      const sz = seg.asset ? pngSize(seg.asset) : { w: 1280, h: 720 };
      layout = screenLayout(sz.w, sz.h);
      if (seg.kind === 'card') { seg.kind = 'title'; doc = titleHtml({ brand, scriptId: script.id, hook: seg.caption, meta: [seg.shot], total, label: `BEAT · ${seg.timing}` }); }
      else doc = beatHtml({ brand, scriptId: script.id, idx: i, total, timing: seg.timing, layout, url: `${site}${urlHint(seg.assetRef)}`, caption: seg.caption, voiceover: seg.voiceover, shot: seg.shot });
    }
    return { seg, i, html, png, out, doc, layout };
  });

  const durs = segs.map((s) => s.dur);
  if (opts.dryRun) {
    return { mp4, poster, durationSec: +durs.reduce((a, b) => a + b, 0).toFixed(2), segments: segs,
      commands: [...jobs.map((j) => [CHROME, ...chromeArgs(j.html, j.png)]), ...jobs.map((j) => [FFMPEG, ...segmentArgs(j.seg, j.i, { framePng: j.png, outFile: j.out, layout: j.layout })]),
        [FFMPEG, ...concatArgs(jobs.map((j) => j.out), durs, mp4)]] };
  }

  mkdirSync(work, { recursive: true });
  // generated output never belongs in git
  if (!existsSync(join(outDir, '.gitignore'))) writeFileSync(join(outDir, '.gitignore'), '*\n');
  for (const j of jobs) writeFileSync(j.html, j.doc);
  log(`  ${script.id}: rendering ${jobs.length} frames with Chrome`);
  await pool(jobs, 4, async (j) => {
    await run(CHROME, chromeArgs(j.html, j.png), { timeout: 60000 });
    if (!existsSync(j.png)) throw new Error(`Chrome did not write ${j.png}`);
  });
  log(`  ${script.id}: encoding ${jobs.length} segments`);
  await pool(jobs, 3, (j) => run(FFMPEG, segmentArgs(j.seg, j.i, { framePng: j.png, outFile: j.out, layout: j.layout }), { maxBuffer: 1 << 24 }));

  let audio = null;
  const key = opts.voice === false ? null : openaiKey();
  if (key) {
    log(`  ${script.id}: voiceover via OpenAI TTS (${TTS_MODEL}, ${TTS_VOICE})`);
    const clips = [];
    let at = 0;
    for (const j of jobs) {
      const text = j.seg.voiceover?.trim();
      if (text) {
        const f = join(work, `vo${String(j.i).padStart(2, '0')}.mp3`);
        try {
          await tts(text, key, f);
          const len = await probeDuration(f);
          const slot = Math.max(0.5, j.seg.dur - 0.15);
          clips.push({ file: f, at: at + 0.08, tempo: len > slot ? Math.min(len / slot, 1.5) : 1 });
        } catch (e) { log(`  ${script.id}: TTS skipped for segment ${j.i} (${e.message.split(':')[0]})`); }
      }
      at += j.seg.dur;
    }
    if (clips.length) audio = { clips };
  }

  await run(FFMPEG, concatArgs(jobs.map((j) => j.out), durs, mp4, audio), { maxBuffer: 1 << 24 });
  copyFileSync(jobs[0].png, poster);
  return { mp4, poster, durationSec: +durs.reduce((a, b) => a + b, 0).toFixed(2), segments: segs, voice: !!audio, bytes: statSync(mp4).size };
}

// "screenshots/005-Browse-the-work-by-type-assertText.png" -> "/#work"-ish hint isn't known; show the page name.
function urlHint(assetRef) {
  if (!assetRef) return '';
  const name = basename(assetRef, '.png').replace(/^\d+-/, '').replace(/-(goto|assertText|assertUrl|click|initial)$/i, '');
  return name && name !== 'initial' ? `  ·  ${name.replace(/-/g, ' ').toLowerCase()}` : '';
}

// ---- canvas -------------------------------------------------------------------------------------------------
const CREATES = new Set(['add_image', 'add_video', 'add_shape', 'add_arrow', 'annotate', 'add_finding']);

export function liveElements(envs) {
  const live = new Map();
  for (const { op } of envs) {
    if (op.type === 'clear') live.clear();
    else if (op.type === 'delete') live.delete(op.id);
    else if (CREATES.has(op.type) && op.id) live.set(op.id, { ...op });
    else if (op.type === 'move' && live.has(op.id)) Object.assign(live.get(op.id), { x: op.x, y: op.y });
  }
  return live;
}

/** The UGC card for a script on the board: an element whose id mentions "ugc" and the script id, or a ugc
 *  note whose text lists the script ("S1 · ..."). Returns the element or null. */
export function findScriptCard(live, scriptId) {
  const sid = scriptId.toLowerCase();
  const ugc = [...live.values()].filter((e) => /ugc/i.test(e.id) && !/^video-/.test(e.id) && typeof e.x === 'number');
  const byId = ugc.find((e) => new RegExp(`(^|[-_])${sid}($|[-_])`, 'i').test(e.id));
  if (byId) return byId;
  const re = new RegExp(`(^|\\n|\\s)${scriptId}\\b`);
  return ugc.find((e) => re.test(String(e.text || e.label || ''))) || null;
}

export const VIDEO_W = 270, VIDEO_H = 480;

/** Ops to place one animatic: next to its script card, else below the UGC lane (or the board). */
export function videoOps({ live, scriptId, src, slot = 0, idPrefix = 'video-animatic' }) {
  const id = `${idPrefix}-${scriptId}`.toLowerCase();
  const card = findScriptCard(live, scriptId);
  let x, y;
  if (card) {
    x = card.x + (card.w ?? 380) + 40 + slot * (VIDEO_W + 30);
    y = card.y;
  } else {
    const els = [...live.values()].filter((e) => typeof e.x === 'number' && e.x > -50000);
    const lane = els.filter((e) => /ugc/i.test(e.id) && !/^video-/.test(e.id));
    const pool = lane.length ? lane : els;
    const minX = pool.length ? Math.min(...pool.map((e) => e.x)) : 0;
    const maxY = pool.length ? Math.max(...pool.map((e) => e.y + (e.h ?? 200))) : 0;
    x = minX + slot * (VIDEO_W + 30);
    y = maxY + 80;
  }
  const ops = [];
  if (live.has(id)) ops.push({ type: 'delete', id });
  ops.push({ type: 'add_video', id, src, x: Math.round(x), y: Math.round(y), w: VIDEO_W, h: VIDEO_H, label: `Animatic ${scriptId} (proposed storyboard)`, autoplay: false });
  if (card) ops.push({ type: 'add_arrow', id: `${id}-arrow`, from: card.id, to: id, label: 'animatic', color: 'orange' });
  return { id, card, ops };
}

export async function pushToCanvas(base, results, log = () => {}) {
  base = base.replace(/\/$/, '');
  const state = await (await fetch(`${base}/api/state`)).json();
  const live = liveElements(state.ops || []);
  const perCard = new Map();
  const placed = [];
  for (const r of results) {
    const form = new FormData();
    form.append('file', new Blob([readFileSync(r.mp4)], { type: 'video/mp4' }), basename(r.mp4));
    const up = await fetch(`${base}/api/upload`, { method: 'POST', body: form });
    if (!up.ok) throw new Error(`upload ${basename(r.mp4)}: HTTP ${up.status}`);
    const { url } = await up.json();
    const card = findScriptCard(live, r.scriptId);
    const key = card?.id || '__lane__';
    const slot = perCard.get(key) || 0;
    perCard.set(key, slot + 1);
    const { id, ops } = videoOps({ live, scriptId: r.scriptId, src: url, slot });
    if (live.has(`${id}-arrow`)) ops.unshift({ type: 'delete', id: `${id}-arrow` });
    const res = await fetch(`${base}/api/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ops) });
    if (!res.ok) throw new Error(`ops for ${r.scriptId}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    log(`  ${r.scriptId}: on canvas as ${id}${card ? ` next to ${card.id}` : ' below the UGC lane'} (${url})`);
    placed.push({ scriptId: r.scriptId, id, url, card: card?.id || null });
  }
  return placed;
}
