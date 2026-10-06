# Ignura design notes
**What it is:** Ignura is a small "launch studio" for consumer/prosumer/B2B apps: design, launch film, UGC, go-to-market and launch day.

**The look:** warm, playful, hand-made cartoon. Grainy cream paper, thick ink outlines, hard "shelf" drop shadows, a cast of googly-eyed mascots (flame, clapperboard, phone, browser window). Feels like a sticker sheet / indie game title screen, not SaaS. Light only.

**Type pairing**
- Display: Fraunces (SOFT 100, WONK 1, weight ~640), tight tracking (-0.02 to -0.03em), italic for the accent word.
- Body: Geist 400, line-height 1.55, ink-2 (#4a453f).
- UI voice: Pixelify Sans on buttons, nav, chips and the subline under the hero. Silkscreen for tiny labels, Caveat for handwritten asides, Geist Mono for tags.

**Colour rules**
- Paper #fbf6ee background with grain everywhere. Cards are #fffdf9.
- Ink #161616 for headings, outlines and shadows. Never use soft grey shadows on interactive bits.
- Orange #ff6a1f is THE accent: the hero word, arrow tiles, play buttons. Deep orange #b33805 for handwritten notes.
- Primary CTA is slate #2f3a45 (not orange) with an orange arrow tile; the secondary button is butter #ffd45c.
- Sky/mint/tomato/butter only on illustrations and mascots, never on UI chrome.

**Signature details worth copying**
1. Hard offset shadow `0 5px 0 #161616` (no blur), which collapses to 1px on :active so buttons look pressed.
2. Orange italic headline word with an ink text-stroke and a drop shadow (`.ig-ignite`).
3. A slightly wobbly outline from an SVG feTurbulence/feDisplacementMap filter (`#k-rough`, scale 2.4) on buttons.
4. Handwritten Caveat annotations with a curved arrow pointing at the CTA ("it's free, promise").
5. 3px ink-bordered cards with big 40px radius; floating pill nav with soft warm shadow.
