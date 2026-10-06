// HTML for animatic frames (1080x1920), in the ignura look (ugc/design/NOTES.md): grainy paper, ink outlines,
// hard "shelf" shadows, Fraunces display with an orange italic accent word, Pixelify/Silkscreen UI labels.
// Beat frames leave a transparent "hole" where the screenshot goes; ffmpeg puts the Ken Burns layer under it.
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const W = 1080, H = 1920;
const FONTS = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'fonts')).href;

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const STOP = new Set(['the', 'and', 'you', 'your', 'that', 'this', 'with', 'from', 'what', 'have', 'just', 'into', 'then', 'they', 'were', 'does', "don't"]);

// The word that gets the orange italic treatment: the last "meaty" word.
export function accentIndex(words) {
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i].toLowerCase().replace(/[^a-z']/g, '');
    if (w.length >= 4 && !STOP.has(w)) return i;
  }
  return words.length - 1;
}

export function captionHtml(text, cls = 'cap') {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const k = accentIndex(words);
  return `<div class="${cls}">${words.map((w, i) => (i === k ? `<em>${esc(w)}</em>` : esc(w))).join(' ')}</div>`;
}

export const captionSize = (text) => {
  const n = String(text || '').length;
  return n <= 16 ? 124 : n <= 28 ? 108 : n <= 44 ? 90 : n <= 64 ? 76 : 64;
};

// Screen geometry for a screenshot of size (iw, ih). Landscape -> browser frame, portrait -> phone frame.
export function screenLayout(iw, ih) {
  const portrait = ih > iw * 1.15;
  if (portrait) {
    const w = 600, h = Math.min(1060, Math.round(w * ih / iw));
    const x = Math.round((W - w) / 2), y = 300;
    return { kind: 'phone', card: { x: x - 16, y: y - 16, w: w + 32, h: h + 32, r: 76 }, hole: { x, y, w, h, r: 60 } };
  }
  const cardX = 52, cardW = W - 104, bar = 72, b = 5;
  const w = cardW - 2 * b, h = Math.min(900, Math.round(w * ih / iw / 2) * 2);
  const cardY = 330;
  return { kind: 'browser', bar, card: { x: cardX, y: cardY, w: cardW, h: h + bar + 2 * b, r: 38 }, hole: { x: cardX + b, y: cardY + b + bar, w: w - (w % 2), h, r: 32 } };
}

const roundedBottom = ({ x, y, w, h, r }) =>
  `M${x} ${y}H${x + w}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}Z`;

function base(body, { transparent = false } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Fraunces";font-weight:500 800;src:url(${FONTS}/fraunces-soft-640-v1.woff2) format("woff2")}
@font-face{font-family:"Fraunces";font-style:italic;font-weight:500 800;src:url(${FONTS}/fraunces-soft-italic-600-v1.woff2) format("woff2")}
@font-face{font-family:"Geist";font-weight:400;src:url(${FONTS}/geist-latin-400-normal.woff2) format("woff2")}
@font-face{font-family:"Geist";font-weight:600 700;src:url(${FONTS}/geist-latin-600-normal.woff2) format("woff2")}
@font-face{font-family:"Pixelify Sans";font-weight:500;src:url(${FONTS}/pixelify-sans-latin-500-normal-v2.woff2) format("woff2")}
@font-face{font-family:"Silkscreen";font-weight:400;src:url(${FONTS}/silkscreen-latin-400-normal.woff2) format("woff2")}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:${transparent ? 'transparent' : '#fbf6ee'};color:#161616;font-family:Geist,system-ui,sans-serif}
.abs{position:absolute}
svg.bg{position:absolute;inset:0}
.top{left:64px;right:64px;top:96px;display:flex;align-items:center;justify-content:space-between}
.brand{font:500 40px/1 "Pixelify Sans",monospace;display:flex;align-items:center;gap:14px}
.brand i{width:22px;height:22px;border-radius:50%;background:#ff6a1f;border:3px solid #161616;display:inline-block}
.tag{font:400 26px/1 Silkscreen,monospace;letter-spacing:.04em;background:#fffdf9;border:3px solid #161616;border-radius:999px;padding:12px 20px;box-shadow:0 4px 0 #161616}
.prog{left:64px;right:64px;top:186px;display:flex;gap:10px}
.prog b{flex:1;height:12px;border-radius:99px;border:3px solid #161616;background:#fffdf9}
.prog b.on{background:#161616}.prog b.now{background:#ff6a1f}
.cap,.big{font-family:Fraunces,Georgia,serif;font-weight:640;font-variation-settings:"SOFT" 100,"WONK" 1,"opsz" 144;letter-spacing:-.018em;word-spacing:.14em;text-align:center;
  color:#fffdf9;-webkit-text-stroke:12px #161616;paint-order:stroke fill;text-shadow:0 9px 0 #161616;line-height:1.02}
.cap em,.big em{font-style:italic;color:#ff6a1f}
.vo{font:400 34px/1.4 Geist,sans-serif;color:#4a453f;text-align:center}
.vo b{font:400 22px/1 Silkscreen,monospace;color:#b33805;letter-spacing:.06em;display:block;margin-bottom:10px}
.shot{left:64px;right:64px;display:flex;align-items:stretch;border:4px solid #161616;border-radius:22px;background:#ffd45c;box-shadow:0 7px 0 #161616;overflow:hidden}
.shot span{font:500 30px/1 "Pixelify Sans",monospace;background:#161616;color:#ffd45c;padding:22px 22px;display:flex;align-items:center;gap:10px;white-space:nowrap}
.shot p{font:600 28px/1.32 Geist,sans-serif;padding:16px 22px;align-self:center}
.foot{left:0;right:0;bottom:70px;text-align:center;font:400 22px/1 Silkscreen,monospace;letter-spacing:.06em;color:#665e55}
.bar{display:flex;align-items:center;gap:14px;padding:0 26px}
.bar i{width:20px;height:20px;border-radius:50%;border:3px solid #161616;display:inline-block}
.url{flex:1;margin-left:14px;height:42px;border-radius:999px;background:#f4ecdf;border:3px solid #161616;font:500 24px/36px "Geist",sans-serif;padding-left:22px;color:#4a453f;overflow:hidden;white-space:nowrap}
.meta{display:flex;flex-wrap:wrap;gap:12px;justify-content:center}
.meta span{font:500 26px/1 "Pixelify Sans",monospace;background:#fffdf9;border:3px solid #161616;border-radius:999px;padding:10px 18px;box-shadow:0 3px 0 #161616}
.peek{border:5px solid #161616;border-radius:30px;box-shadow:0 12px 0 #161616;overflow:hidden;background:#fffdf9;transform:rotate(-3deg)}
.peek img{display:block;width:100%}
.btn{display:inline-flex;align-items:center;gap:22px;background:#2f3a45;color:#fffdf9;border:4px solid #161616;border-radius:18px;box-shadow:0 8px 0 #161616;padding:18px 18px 18px 40px;font:500 46px/1 "Pixelify Sans",monospace}
.btn i{font-style:normal;width:72px;height:72px;border-radius:13px;background:#ff6a1f;border:4px solid #161616;display:flex;align-items:center;justify-content:center;font:700 44px/1 Geist,sans-serif;color:#161616}
</style></head><body>${body}</body></html>`;
}

function paperSvg({ hole, card, glow = [{ x: 860, y: 420, r: 300 }, { x: 160, y: 1480, r: 260 }] } = {}) {
  const holeMask = hole
    ? `<mask id="m"><rect width="${W}" height="${H}" fill="#fff"/><path d="${roundedBottom(hole)}" fill="#000"/></mask>` : '';
  const cardShapes = card
    ? `<rect x="${card.x}" y="${card.y + 12}" width="${card.w}" height="${card.h}" rx="${card.r}" fill="#161616"/>
       <rect x="${card.x}" y="${card.y}" width="${card.w}" height="${card.h}" rx="${card.r}" fill="#fffdf9"/>` : '';
  return `<svg class="bg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>${holeMask}
<filter id="g"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 .35 0 0 0 0 .25 0 0 0 0 .15 0 0 0 .55 0"/></filter>
<radialGradient id="o"><stop offset="0" stop-color="#ff8a3d" stop-opacity=".38"/><stop offset="1" stop-color="#ff8a3d" stop-opacity="0"/></radialGradient></defs>
<g ${hole ? 'mask="url(#m)"' : ''}>
<rect width="${W}" height="${H}" fill="#fbf6ee"/>
${glow.map((g) => `<circle cx="${g.x}" cy="${g.y}" r="${g.r}" fill="url(#o)"/>`).join('')}
<rect width="${W}" height="${H}" filter="url(#g)" opacity=".5"/>
${cardShapes}
</g>
${card ? `<rect x="${card.x}" y="${card.y}" width="${card.w}" height="${card.h}" rx="${card.r}" fill="none" stroke="#161616" stroke-width="5"/>` : ''}
${hole ? `<path d="${roundedBottom(hole)}" fill="none" stroke="#161616" stroke-width="3"/>` : ''}
</svg>`;
}

const progress = (n, i) => `<div class="abs prog">${Array.from({ length: n }, (_, k) => `<b class="${k < i ? 'on' : k === i ? 'now' : ''}"></b>`).join('')}</div>`;
const header = (brand, tag) => `<div class="abs top"><div class="brand"><i></i>${esc(brand)}</div><div class="tag">${esc(tag)}</div></div>`;
const footer = (t) => `<div class="abs foot">${esc(t)}</div>`;
const trunc = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };

// A beat: transparent hole for the screenshot, caption + VO + shot chip around it.
export function beatHtml({ brand, scriptId, idx, total, timing, layout, url, caption, voiceover, shot }) {
  const { card, hole } = layout;
  const below = hole.y + hole.h + 34 + 70;
  const size = captionSize(caption);
  const chrome = layout.kind === 'browser'
    ? `<div class="abs bar" style="left:${card.x + 5}px;top:${card.y + 5}px;width:${card.w - 10}px;height:${layout.bar}px">
         <i style="background:#f2553e"></i><i style="background:#ffc83d"></i><i style="background:#8fd8ae"></i><div class="url">${esc(url)}</div></div>`
    : `<div class="abs" style="left:${W / 2 - 80}px;top:${hole.y + 14}px;width:160px;height:34px;border-radius:99px;background:#161616"></div>`;
  return base(`${paperSvg({ hole, card })}
${chrome}
${header(brand, `${scriptId} · BEAT ${idx + 1}/${total}`)}
${progress(total, idx)}
<div class="abs" style="left:56px;right:56px;top:${below}px;font-size:${size}px">${captionHtml(caption)}</div>
<div class="abs vo" style="left:90px;right:90px;top:${below + Math.round(size * 2.35) + 30}px"><b>VOICEOVER</b>“${esc(trunc(voiceover, 130))}”</div>
<div class="abs shot" style="bottom:170px"><span>▶ SHOT</span><p>${esc(trunc(shot, 110))}</p></div>
${footer(`STORYBOARD ANIMATIC · ${timing} · PROPOSED, NOT FINAL FOOTAGE`)}`, { transparent: true });
}

// Below the hook: estimate its line count at the hook's font size (Fraunces averages ~0.45em per char).
export function peekTop(hook) {
  const size = Math.min(132, captionSize(hook) + 22);
  const lines = Math.max(1, Math.ceil(String(hook || '').length * 0.45 * size / 940));
  return 450 + Math.round(lines * size * 1.05) + 70;
}

export function titleHtml({ brand, scriptId, hook, meta, total, preview, label = 'THE HOOK · FIRST 2 SECONDS' }) {
  const chips = (Array.isArray(meta) ? meta : [meta]).filter(Boolean);
  return base(`${paperSvg({ glow: [{ x: 900, y: 520, r: 420 }, { x: 140, y: 1500, r: 360 }] })}
${header(brand, `${scriptId} · HOOK`)}
${progress(total, 0)}
<div class="abs" style="left:64px;top:330px"><span class="tag" style="background:#ffd45c">${esc(label)}</span></div>
<div class="abs" style="left:60px;right:60px;top:450px;font-size:${Math.min(132, captionSize(hook) + 22)}px">${captionHtml(hook, 'big')}</div>
${preview ? `<div class="abs peek" style="left:110px;right:110px;top:${peekTop(hook)}px"><img src="${pathToFileURL(preview).href}"></div>` : ''}
<div class="abs meta" style="left:64px;right:64px;bottom:190px">${chips.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
${footer('STORYBOARD ANIMATIC · PROPOSED, NOT FINAL FOOTAGE')}`);
}

export function endHtml({ brand, scriptId, cta, button, site, total }) {
  const extra = (String(cta).match(/\(([^)]+)\)/) || [])[1] || '';
  return base(`${paperSvg({ glow: [{ x: 540, y: 960, r: 520 }] })}
${header(brand, `${scriptId} · CTA`)}
${progress(total, total - 1)}
<div class="abs" style="left:60px;right:60px;top:560px;font-size:${Math.min(140, captionSize(button) + 16)}px">${captionHtml(button, 'big')}</div>
<div class="abs" style="left:0;right:0;top:1000px;text-align:center"><span class="btn">${esc(site || trunc(button, 26))}<i>→</i></span></div>
${extra ? `<div class="abs" style="left:0;right:0;top:1190px;text-align:center"><span class="tag" style="background:#ffd45c;font-size:30px">${esc(extra.toUpperCase())}</span></div>` : ''}
${footer('STORYBOARD ANIMATIC · PROPOSED, NOT FINAL FOOTAGE')}`);
}
