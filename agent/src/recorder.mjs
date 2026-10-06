// Screen recording of the run: samples frames from the backend and pipes them to ffmpeg (WebM/VP8).
// Wall-clock timestamps are used, so `now()` (seconds since the first frame) matches positions in the video:
// findings store `timestamp = recorder.now()` so the canvas video can seek to them.

import { spawn, execFileSync } from 'node:child_process';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function findFfmpeg(explicit = process.env.ASTRAHACK_FFMPEG) {
  if (explicit) return explicit;
  for (const candidate of ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    try { execFileSync(candidate, ['-version'], { stdio: 'ignore' }); return candidate; } catch { /* next */ }
  }
  return null;
}

export class Recorder {
  constructor({ backend, ffmpeg, path, fps = 2, log = () => {} }) {
    Object.assign(this, { backend, ffmpeg, path, fps, log });
    this.active = false;
    this.t0 = null;
    this.frames = 0;
  }

  // seconds into the recording (null when not recording)
  now() { return this.active && this.t0 ? (Date.now() - this.t0) / 1000 : null; }

  async start() {
    if (!this.ffmpeg) { this.log('recorder: ffmpeg not found; no screen recording (set ASTRAHACK_FFMPEG or install ffmpeg)'); return false; }
    this.child = spawn(this.ffmpeg, [
      '-loglevel', 'error', '-y', '-use_wallclock_as_timestamps', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-i', 'pipe:0',
      '-vf', `fps=${this.fps},scale=960:-2`, '-c:v', 'libvpx', '-b:v', '700k', '-pix_fmt', 'yuv420p', '-f', 'webm', this.path
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    this.stderr = '';
    this.child.stderr.on('data', d => { this.stderr += d.toString(); });
    this.child.stdin.on('error', () => {});
    this.child.on('error', error => { this.stderr += error.message; this.active = false; });
    this.active = true;
    this.t0 = Date.now();
    this.busy = false;
    const grab = async () => {
      if (this.busy || !this.active) return;
      this.busy = true;
      try {
        const frame = await this.backend.frame();
        if (frame && this.active && !this.child.stdin.destroyed) { this.child.stdin.write(frame); this.frames++; this.lastFrame = frame; this.lastAt = Date.now(); }
      } catch { /* a missed frame is fine */ } finally { this.busy = false; }
    };
    await grab();
    this.timer = setInterval(grab, 1000 / this.fps);
    return true;
  }

  // -> path of the finished video, or null
  async stop() {
    if (!this.child) return null;
    this.active = false;
    clearInterval(this.timer);
    while (this.busy) await sleep(20);
    // hold the last frame so the video lasts until the moment we stopped
    if (this.lastFrame && Date.now() - this.lastAt > 300 && !this.child.stdin.destroyed) this.child.stdin.write(this.lastFrame);
    this.child.stdin.end();
    const code = this.child.exitCode ?? await new Promise(resolve => this.child.once('exit', resolve));
    if (code !== 0 || !this.frames) { this.log(`recorder: encoder failed (${this.stderr.trim().slice(0, 200) || `exit ${code}, ${this.frames} frames`})`); return null; }
    this.log(`recorder: ${this.frames} frames -> ${this.path}`);
    return this.path;
  }
}
