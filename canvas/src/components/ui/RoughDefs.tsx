// Shared SVG filters that wobble strokes a little (low-frequency displacement), so borders look pen-drawn.
// Applied to border/decoration layers only (pseudo-elements, icons), never to text.
// a/b/c differ by seed so neighbouring boxes do not share the exact same wobble.
export function RoughDefs() {
  const f = (id: string, seed: number, freq: number, scale: number) => (
    <filter id={id} x="-4%" y="-4%" width="108%" height="108%" colorInterpolationFilters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency={freq} numOctaves={2} seed={seed} result="n" />
      <feDisplacementMap in="SourceGraphic" in2="n" scale={scale} xChannelSelector="R" yChannelSelector="G" />
    </filter>
  );
  return (
    <svg width="0" height="0" style={{ position: "absolute", pointerEvents: "none" }} aria-hidden focusable="false">
      <defs>
        {f("ig-rough-a", 3, 0.032, 3.4)}
        {f("ig-rough-b", 11, 0.04, 3.2)}
        {f("ig-rough-c", 23, 0.028, 3.6)}
        {f("ig-rough-sm", 5, 0.09, 1.5)}
      </defs>
    </svg>
  );
}
