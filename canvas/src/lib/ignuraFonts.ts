import { withBase } from "./base";

// Ignura brand fonts, copied from the ignura site into public/ignura/fonts.
// Fraunces = the storybook serif voice, Caveat = hand notes, Pixelify Sans = the pixel UI layer,
// Geist / Geist Mono = body + code.
export const FONT_URLS = {
  fraunces: "/ignura/fonts/fraunces-soft-640-v1.woff2",
  frauncesItalic: "/ignura/fonts/fraunces-soft-italic-600-v1.woff2",
  geist400: "/ignura/fonts/geist-latin-400-normal.woff2",
  geist500: "/ignura/fonts/geist-latin-500-normal.woff2",
  geist600: "/ignura/fonts/geist-latin-600-normal.woff2",
  geistMono: "/ignura/fonts/geist-mono-latin-400-normal.woff2",
  pixel500: "/ignura/fonts/pixelify-sans-latin-500-normal-v2.woff2",
  pixel600: "/ignura/fonts/pixelify-sans-latin-600-normal-v2.woff2",
  caveat: "/ignura/fonts/caveat-latin-600-normal-v2.woff2",
} as const;

/** @font-face CSS (needs basePath, which CSS url() does not get for free). Rendered into <head> by the layout. */
export function fontFaceCss(): string {
  const f = (family: string, file: string, weight: string, style = "normal") =>
    `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};font-display:swap;src:url('${withBase(file)}') format('woff2')}`;
  return [
    f("Fraunces", FONT_URLS.fraunces, "500 800"),
    f("Fraunces", FONT_URLS.frauncesItalic, "500 800", "italic"),
    f("Geist", FONT_URLS.geist400, "400"),
    f("Geist", FONT_URLS.geist500, "500"),
    f("Geist", FONT_URLS.geist600, "600 700"),
    f("Geist Mono", FONT_URLS.geistMono, "400 500"),
    f("Pixelify Sans", FONT_URLS.pixel500, "400 500"),
    f("Pixelify Sans", FONT_URLS.pixel600, "600 700"),
    f("Caveat", FONT_URLS.caveat, "400 700"),
  ].join("");
}
