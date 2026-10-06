# Storyboard animatics

`bin/video.js animatic` turns each UGC script in `ugc-plan.json` into a vertical 1080×1920 MP4 storyboard, so a creator or client can watch the script before anyone films it. Sample: [docs/img/animatic-ignura-S1.mp4](img/animatic-ignura-S1.mp4) (downscaled).

```sh
node bin/video.js animatic ugc/fixtures/ignura --script S1          # one script
node bin/video.js animatic runs/demo/ugc --script all               # every script
node bin/video.js animatic ugc/fixtures/ignura --dry-run            # print segments + Chrome/ffmpeg commands
node bin/video.js animatic ugc/fixtures/ignura --canvas http://localhost:3000
```

Output: `<runDir>/video/animatic-<scriptId>.mp4` and `animatic-<scriptId>.png` (poster). That folder gets its own `.gitignore`.

**What's in it.** A title card with the hook (it takes the first beat's slot when that beat has no screenshot), one segment per beat, then a CTA end card. Each beat lasts its `t` range (`"2-8s"` → 6s; unparseable → 3s) and shows the beat's real screenshot (`assetRef`) in a browser frame (phone frame for portrait shots) with a slow Ken Burns zoom, the `onScreenText` as a big caption, the voiceover line, a "shot" chip with the camera direction, and a progress bar. Everything is labelled "proposed, not final footage".

**The look** follows `ugc/design/NOTES.md`: paper and grain, ink outlines, hard shelf shadows, Fraunces captions with an orange (#ff6a1f) italic accent word, Pixelify/Silkscreen labels. Fonts ship in `video/fonts/` (OFL), so rendering is offline.

**How.** `video/frames.mjs` writes one HTML page per segment; headless Chrome screenshots it to PNG (beat frames have a transparent hole where the screen goes). `video/animatic.mjs` runs ffmpeg per segment (zoompan on the screenshot, under the frame), then joins segments with 0.35s crossfades. Segments are padded by the fade so the total matches the script.

**Voiceover.** With `OPENAI_API_KEY` (env or `.env`; never printed) each segment's voiceover is spoken with OpenAI TTS (`POST /v1/audio/speech`, `gpt-4o-mini-tts`, voice `coral`; override with `OPENAI_TTS_MODEL` / `OPENAI_TTS_VOICE`) and mixed in at its beat; long lines are sped up to fit (max 1.5×). No key, or `--no-voice`: silent.

**Canvas.** `--canvas URL` uploads each MP4 (`POST /api/upload`), finds the script's card in `GET /api/state` (an element id with `ugc` and the script id, or a `ugc` note listing `S1 · …`, e.g. `kit-ugc-scripts`), and posts `add_video` (270×480, id `video-animatic-<sid>`) to its right plus an orange `add_arrow` from the card. No card: it goes below the UGC lane. Re-running replaces it.

**Needs** ffmpeg (`brew install ffmpeg`, or `FFMPEG_PATH`) and Chrome (`CHROME_PATH`). Speed: ~15s per 30s script on an M-series Mac.

Tests: `node --test test/video.test.mjs` (timing, segments, layout, command construction, canvas placement; the ffmpeg test skips when ffmpeg is missing).
