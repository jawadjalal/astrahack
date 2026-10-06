import { DEFAULT_THEME, type TLTheme } from "tldraw";
import { withBase } from "./base";
import { FONT_URLS } from "./ignuraFonts";

// Ignura palette mapped onto tldraw's named colors. Source: site-v3/src/styles/tokens.css.
export const IG = {
  paper: "#FBF6EE",
  paper2: "#F4ECDF",
  card: "#FFFDF9",
  ink: "#161616",
  ink2: "#4A453F",
  ink3: "#665E55",
  line: "#E6DCCD",
  orange: "#FF6A1F",
  orangeDeep: "#B33805",
  butter: "#FFD45C",
  butterSoft: "#FFE9A6",
  sky: "#8FC3F2",
  skySoft: "#D6E9FA",
  mint: "#8FD8AE",
  tomato: "#F2553E",
  blush: "#FF9E86",
  cream: "#FFF6EA",
} as const;

type Light = TLTheme["colors"]["light"];
type Entry = Light["black"];

// One tldraw color entry from a few brand values. `solid` is the ink/stroke color; `soft` the tint used for
// "semi" fills and notes.
function entry(solid: string, soft: string, note: string, highlight: string, opts: Partial<Entry> = {}): Entry {
  return {
    solid,
    fill: solid,
    linedFill: soft,
    frameHeadingStroke: solid,
    frameHeadingFill: IG.card,
    frameStroke: solid,
    frameFill: IG.card,
    frameText: IG.ink,
    noteFill: note,
    noteText: IG.ink,
    semi: soft,
    pattern: solid,
    highlightSrgb: highlight,
    highlightP3: highlight,
    ...opts,
  };
}

const colors: Light = {
  ...DEFAULT_THEME.colors.light,
  text: IG.ink,
  background: IG.paper,
  negativeSpace: IG.paper2,
  solid: IG.card,
  cursor: IG.ink,
  noteBorder: IG.ink,
  snap: IG.tomato,
  selectionStroke: IG.orange,
  selectionFill: "rgba(255, 106, 31, 0.10)",
  brushFill: "rgba(255, 212, 92, 0.22)",
  brushStroke: "rgba(22, 22, 22, 0.45)",
  selectedContrast: IG.card,
  laser: IG.tomato,
  black: entry(IG.ink, "#E8E0D2", IG.butterSoft, IG.butter),
  grey: entry("#8B8277", "#ECE5D8", "#E4DACB", "#D9CCB8"),
  "light-violet": entry("#C3A8EE", "#EFE6FA", "#E1D2F7", "#D9C6F6"),
  violet: entry("#8A63D2", "#E5DBF5", "#CDB8F0", "#B79BEA"),
  blue: entry("#3F86CC", IG.skySoft, "#A9D1F6", IG.sky),
  "light-blue": entry(IG.sky, "#E6F1FB", IG.skySoft, IG.sky),
  yellow: entry("#E8B21F", "#FFF1C2", IG.butter, IG.butter),
  orange: entry(IG.orange, "#FFE3CF", "#FFB27E", "#FFA45B"),
  green: entry("#2F9E6A", "#D8F0E3", "#8FD8AE", IG.mint),
  "light-green": entry(IG.mint, "#E6F6EC", "#BFE8D0", IG.mint),
  "light-red": entry(IG.blush, "#FFE6DF", "#FFC4B6", IG.blush),
  red: entry(IG.tomato, "#FBD9D3", "#F9A99C", IG.tomato),
  white: entry(IG.card, IG.paper2, IG.card, IG.card, { frameFill: IG.card, noteFill: IG.card }),
};

const face = (family: string, file: string, weight: "normal" | "bold" = "normal", style: "normal" | "italic" = "normal") => ({
  family,
  src: { url: withBase(file), format: "woff2" },
  weight,
  style,
});

/** The Ignura tldraw theme: paper background, ink strokes, brand fonts. Light mode only. */
export function makeIguraTheme(): TLTheme {
  return {
    ...DEFAULT_THEME,
    id: "default",
    // Caveat is a small-set face; nudge the base size so the draw font reads at the same weight as the defaults.
    fontSize: 18,
    lineHeight: 1.3,
    strokeWidth: 2.4,
    fonts: {
      // draw = Caveat hand notes (tldraw's default text font), sans = Geist, serif = Fraunces, mono = Pixelify (pixel UI layer)
      draw: {
        fontFamily: "'Caveat', 'Comic Sans MS', cursive",
        faces: [face("Caveat", FONT_URLS.caveat), face("Caveat", FONT_URLS.caveat, "bold")],
      },
      sans: {
        fontFamily: "'Geist', ui-sans-serif, system-ui, sans-serif",
        faces: [
          face("Geist", FONT_URLS.geist400),
          face("Geist", FONT_URLS.geist600, "bold"),
        ],
      },
      serif: {
        fontFamily: "'Fraunces', 'Iowan Old Style', Georgia, serif",
        faces: [
          face("Fraunces", FONT_URLS.fraunces),
          face("Fraunces", FONT_URLS.fraunces, "bold"),
          face("Fraunces", FONT_URLS.frauncesItalic, "normal", "italic"),
          face("Fraunces", FONT_URLS.frauncesItalic, "bold", "italic"),
        ],
      },
      mono: {
        fontFamily: "'Pixelify Sans', ui-monospace, monospace",
        faces: [face("Pixelify Sans", FONT_URLS.pixel500), face("Pixelify Sans", FONT_URLS.pixel600, "bold")],
      },
    },
    colors: { light: colors, dark: colors },
  };
}
