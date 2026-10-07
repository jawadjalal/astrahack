"use client";

import type { CSSProperties } from "react";
import type { Run } from "../lib/runs";
import { DART_BODY, DART_SHADE } from "./ui/AgentAvatar";
import styles from "./RunStepper.module.css";

/**
 * The stages the worker walks through (docs/WEB_RUNS.md). Each step covers one or more worker `stage` values.
 * After exploring, QA analysis, screenshot selection and launch-kit generation run in parallel, so the worker's
 * stage hops between analyzing / capturing / generating_* and they all share one step. `finished` is not a step.
 */
export const RUN_STEPS = [
  { label: "In line", stages: ["queued", "starting"] },
  { label: "Using your site", stages: ["exploring"] },
  { label: "Writing it up", stages: ["analyzing", "capturing", "generating_kit", "generating_ads", "generating_campaigns", "generating_ugc"] },
  { label: "Pinning to the board", stages: ["publishing", "publishing_features", "publishing_kit"] },
] as const;

export const LAST_STEP = RUN_STEPS.length - 1;

/**
 * Where a run is along the stepper: a step index, or RUN_STEPS.length when every step is done. A failed run
 * reports `finished` as its stage, so the caller keeps the furthest step it has seen (see `reached`).
 */
export function stepIndex(run: Pick<Run, "status" | "stage">): number {
  if (run.status === "completed" || run.status === "partial") return RUN_STEPS.length;
  const found = RUN_STEPS.findIndex((step) => (step.stages as readonly string[]).includes(run.stage));
  if (found >= 0) return found;
  return run.status === "running" ? 1 : 0;
}

/** The orange pointer Astra uses on the whiteboard, reused as her cursor on the stepper. */
export function AstraDart({ size = 28 }: { size?: number }) {
  return (
    <svg className="ig-agent-dart" viewBox="3.37 2.86 30 30" width={size} height={size} aria-hidden focusable="false">
      <path d={DART_BODY} fill="none" stroke="#FFFDF9" strokeWidth={4.4} strokeLinejoin="round" />
      <path d={DART_BODY} fill="#FF6A1F" />
      <path d={DART_SHADE} fill="#E2500E" />
      <path d="M7.05 8.50L10.15 9.95" stroke="#fff" strokeWidth={2} strokeLinecap="round" fill="none" />
      <path d={DART_BODY} fill="none" stroke="#161616" strokeWidth={2.8} strokeLinejoin="round" />
    </svg>
  );
}

const Check = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
    <path className="ig-draw" pathLength={1} d="M5.2 12.6c1.7 1.4 3.2 3 4.3 4.9C12 12.4 15.4 8.4 19.4 5.6" />
  </svg>
);
const Cross = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" aria-hidden focusable="false">
    <path className="ig-draw" pathLength={1} d="M6 6.4L18.2 17.8" />
    <path className="ig-draw" pathLength={1} style={{ ["--ig-delay" as string]: "140ms" }} d="M18 6L6.3 18" />
  </svg>
);

/**
 * A hand-drawn stepper with Astra's cursor parked on the step she is on. `current` is a step index (or
 * RUN_STEPS.length for all done); `failed` marks that step as the one the run stopped on.
 */
export default function RunStepper({ current, failed = false, labels }: { current: number; failed?: boolean; labels?: readonly string[] }) {
  const cursor = Math.min(current, LAST_STEP);
  const style = { "--i": cursor, "--n": RUN_STEPS.length } as CSSProperties;
  return (
    <div className={styles.stepper} style={style}>
      <ol className={styles.steps} aria-label="Exploration progress">
        {RUN_STEPS.map((step, index) => {
          const done = index < current;
          const here = index === current;
          const state = done ? "done" : here ? (failed ? "failed" : "active") : "todo";
          const sr = done ? "done" : state === "failed" ? "stopped here" : state === "active" ? "in progress" : "waiting";
          return (
            <li key={step.label} className={`${styles.step} ${styles[state]}`} aria-current={state === "active" ? "step" : undefined}>
              <span className={styles.node} aria-hidden>
                {done ? <Check /> : state === "failed" ? <Cross /> : <b>{index + 1}</b>}
              </span>
              <span className={styles.label}>
                {labels?.[index] ?? step.label}
                <span className={styles.sr}> ({sr})</span>
              </span>
              {index < LAST_STEP && (
                <i className={styles.seg} aria-hidden>
                  <b />
                </i>
              )}
            </li>
          );
        })}
      </ol>
      <span className={styles.cursor} aria-hidden>
        <span className="ig-agent-bob">
          <AstraDart />
        </span>
      </span>
    </div>
  );
}

/** Five tiny drawn dots, for the docked status chip. */
export function MiniSteps({ current, failed = false }: { current: number; failed?: boolean }) {
  return (
    <span className={styles.mini} aria-hidden>
      {RUN_STEPS.map((step, index) => (
        <i key={step.label} className={index < current ? styles.miniDone : index === current ? (failed ? styles.miniFailed : styles.miniActive) : undefined} />
      ))}
    </span>
  );
}
