# Judge: the UGC plan grades and rewrites itself

`node bin/judge.js <runDir|ugc-plan.json> [--rounds 2] [--threshold 8] [--mock] [--out dir] [--canvas URL] [--dry-run]`

1. Scores every hook and script in `ugc-plan.json` from 0 to 10 on six lines: scroll-stop, specificity to this
   product, native to the platform (not ad-speak), clarity, grounding (claims tie to observed features with
   evidence) and compliance (no invented stats, prices or testimonials). Hooks must be at most 15 words and open
   with tension or curiosity. Overall = half the average, half the weakest line, so one bad line can't hide.
2. Rewrites anything under `--threshold`, re-scores, and repeats for up to `--rounds`. A rewrite only lands if it
   scores higher and the plan still passes `checkGrounding` and `validatePlan`. Each script's first beat follows its hook.
3. Writes `judge.json` (every version of every item, with scores and rationale) and `ugc-plan.judged.json`
   next to the plan (or in `--out`). Prints a before/after table (`H4  5.8 → 9.4`) plus averages.

Judges:
- **gpt-6-astra** when `OPENAI_API_KEY` is set (env or `.env`, never logged): structured outputs through
  `src/openai.js createResponse`, one scoring call and one rewrite call per round. The 15-word cap is enforced in code.
- **heuristic** with `--mock` or no key: deterministic. Word counts, a banned ad-speak list, a tension-opener check,
  figures checked against the observed feature text and proposals, and template rewrites built from the product's
  real feature names and the on-page text the run confirmed. Override the model with `OPENAI_JUDGE_MODEL`.

Canvas: `--canvas http://localhost:3000` reads `/api/state`, finds the UGC cards push-kit drew (`ugc-S1`, `ugc-H2`;
older `<prefix>-ugc-hook-N` too), and draws a Judge scorecard under them: one orange note per rewritten hook (v1 → v2 with
scores), a scripts note, `arrow_to` from each note to the original hook card (matched by text), and a `say`
("Judge: 10 hooks rewritten, avg 5.9 → 9.6 ..."). Ids are `judge-<tag>-…`. `--dry-run` prints the ops instead.

Try it: `node bin/judge.js ugc/fixtures/ignura --mock --out /tmp/judge --dry-run`
Code: `judge/heuristic.mjs` (rubric, scorer, rewriter), `judge/model.mjs`, `judge/loop.mjs`, `judge/canvas.mjs`.
Tests: `node --test test/judge.test.mjs`.
