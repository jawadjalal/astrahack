"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { withBase } from "../lib/base";
import { boardForRun } from "../lib/board.mjs";
import { boardFromLocation } from "../lib/boardClient";
import type { Run } from "../lib/runs";
import RunStepper, { LAST_STEP, MiniSteps, RUN_STEPS, stepIndex } from "./RunStepper";
import { RoughDefs } from "./ui/RoughDefs";
import styles from "./RunExperience.module.css";

const Canvas = dynamic(() => import("./Canvas"), {
  ssr: false,
  loading: () => (
    <div className={styles.canvasLoading} role="status">
      <p>Loading your canvas…</p>
    </div>
  ),
});

const IGNURA_URL = "https://ignura.com/";
const REPLAY_STEPS = ["Understanding your site", "QA fleet", "Screenshots", "Launch kit"] as const;
const REPLAY_MESSAGES = [
  "Getting to know the pages and product flows.",
  "Following the QA fleet through the site.",
  "Bringing together the feature screenshots.",
  "Opening the screenshots and launch ideas on your whiteboard.",
] as const;
const REPLAY_HEADLINES: [string, string, string][] = [
  ["Astra is getting to ", "know", " your product"],
  ["Astra’s QA fleet is ", "using", " your site"],
  ["Astra is gathering your ", "screenshots", ""],
  ["Astra is opening your ", "launch kit", ""],
];

const terminal = new Set(["completed", "partial", "failed"]);
const labels: Record<Run["status"], string> = {
  queued: "Getting ready",
  running: "Exploring your product",
  completed: "All done",
  partial: "Done, with a few gaps",
  failed: "Couldn’t finish",
};

/** The run's evidence is reaching the whiteboard once it is publishing, or when it ended with something to show. */
const evidenceIsLive = (run: Run | null) =>
  !!run && (run.status === "completed" || run.status === "partial" || run.stage.startsWith("publishing"));

/** Astra's line for the big progress screen: [before, emphasised, after]. */
function headline(run: Run | null, unavailable: boolean): [string, string, string] {
  if (unavailable) return ["Astra lost track of this ", "run", ""];
  if (!run) return ["Finding your ", "run", "…"];
  if (run.status === "failed") return ["Astra couldn’t finish this ", "run", ""];
  switch (run.stage) {
    case "exploring": return ["Astra is ", "using", " your product"];
    case "analyzing":
    case "capturing":
    case "generating_kit":
    case "generating_ads":
    case "generating_campaigns":
    case "generating_ugc": return ["Astra is ", "writing up", " what she found"];
    case "publishing":
    case "publishing_features":
    case "publishing_kit": return ["Astra is pinning it to the ", "board", ""];
    default: return ["Astra is getting ", "ready", ""];
  }
}

function updateLocation(runId?: string, canvas = false) {
  const url = new URL(window.location.href);
  url.searchParams.delete("run");
  url.searchParams.delete("view");
  if (runId) url.searchParams.set("run", runId);
  else if (canvas) url.searchParams.set("view", "canvas");
  window.history.replaceState(null, "", url);
}

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export default function RunExperience({ initialRunId = null, initialCanvas = false, recordedIgnura = false }: { initialRunId?: string | null; initialCanvas?: boolean; recordedIgnura?: boolean }) {
  const [targetUrl, setTargetUrl] = useState(recordedIgnura ? IGNURA_URL : "");
  const [replayActive, setReplayActive] = useState(false);
  const [replayStep, setReplayStep] = useState(0);
  const [run, setRun] = useState<Run | null>(null);
  const [runId, setRunId] = useState<string | null>(initialRunId);
  // a run draws on its own board (named after the run id); `?board=<id>` opens any other board; no param means `main`
  const [urlBoard] = useState(() => boardFromLocation());
  const board = runId ? boardForRun(runId) : urlBoard;
  const [showCanvas, setShowCanvas] = useState(!!initialRunId || initialCanvas);
  const [showForm, setShowForm] = useState(!initialRunId && !initialCanvas);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  /** furthest step seen, so a failed run (whose stage reads "finished") can show where it stopped */
  const [reached, setReached] = useState(0);
  /** the visitor chose to look at the whiteboard before evidence arrived */
  const [peeked, setPeeked] = useState(false);
  /** the progress screen has finished fading out and is gone */
  const [stageGone, setStageGone] = useState(false);
  const fieldRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The recording route reuses existing evidence without creating a job or spending API credits.
  useEffect(() => {
    if (!replayActive) return;
    const timers = REPLAY_STEPS.map((_, index) =>
      setTimeout(() => setReplayStep(index + 1), (index + 1) * 2500),
    );
    return () => timers.forEach(clearTimeout);
  }, [replayActive]);

  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let finished = false;
      try {
        const response = await fetch(withBase(`/api/runs/${encodeURIComponent(runId)}`), {
          cache: "no-store", signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) {
          if (response.status === 404) finished = true;
          throw new Error(data.error || "Could not load run progress.");
        }
        if (!controller.signal.aborted) {
          setRun(data.run);
          setReached((current) => Math.max(current, Math.min(stepIndex(data.run), LAST_STEP)));
          setStatusError("");
        }
        finished = terminal.has(data.run.status);
      } catch (cause) {
        if (!controller.signal.aborted) setStatusError(cause instanceof Error ? cause.message : "Reconnecting to run progress…");
      } finally {
        if (!controller.signal.aborted && !finished) timer = setTimeout(poll, 2500);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [runId]);

  // Hand-off: once evidence starts landing (or the visitor peeks), the progress screen fades out over the board.
  const handedOff = peeked || (replayActive && replayStep >= REPLAY_STEPS.length) || evidenceIsLive(run);
  useEffect(() => {
    if (!handedOff) return;
    const timer = setTimeout(() => setStageGone(true), prefersReducedMotion() ? 0 : 480);
    return () => clearTimeout(timer);
  }, [handedOff]);

  const fail = (message: string, refocus = false) => {
    setError(message);
    if (refocus) inputRef.current?.focus();
    if (!prefersReducedMotion()) {
      fieldRef.current?.animate(
        [{ transform: "translateX(0)" }, { transform: "translateX(-8px) rotate(-.4deg)" }, { transform: "translateX(7px) rotate(.3deg)" },
          { transform: "translateX(-4px)" }, { transform: "translateX(0)" }],
        { duration: 380, easing: "ease-out" },
      );
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setError("");
    if (recordedIgnura) {
      setRun(null);
      setRunId(null);
      setStatusError("");
      setReplayStep(0);
      setReplayActive(true);
      setPeeked(false);
      setStageGone(false);
      setShowCanvas(true);
      setShowForm(false);
      updateLocation(undefined, true);
      return;
    }
    const trimmed = targetUrl.trim();
    let url: URL;
    try {
      url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
      if (!trimmed || !["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      fail("That doesn’t look like a web address. Try something like https://your-product.com.", true);
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch(withBase("/api/runs"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.href }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not start the run. Please try again.");
      setRun(data.run);
      setReached(Math.min(stepIndex(data.run), LAST_STEP));
      setPeeked(false);
      setStageGone(false);
      setRunId(data.run.id);
      setStatusError("");
      setShowCanvas(true);
      setShowForm(false);
      updateLocation(data.run.id);
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : "Could not start the run. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const viewCanvas = () => {
    setShowCanvas(true);
    setShowForm(false);
    updateLocation(runId || undefined, true);
  };

  const newRun = () => {
    setError("");
    setReplayActive(false);
    setReplayStep(0);
    setShowForm(true);
  };

  // ---- derived view state ----
  const unavailable = !run && !!statusError;
  const stageVisible = !showForm && (!!runId || replayActive) && !stageGone;
  const dockVisible = !showForm && (!(runId || replayActive) || handedOff);
  const failed = run?.status === "failed";
  const current = replayActive ? replayStep : run ? (failed ? Math.max(reached, 1) : stepIndex(run)) : 0;
  const activeUrl = replayActive ? IGNURA_URL : run?.url;
  const hasProgress = !!run || replayActive;
  const mood = error ? "oops" : submitting ? "busy" : targetUrl.trim() ? "typing" : "idle";
  const bubble = error ? "Hmm, that didn’t go through. Mind checking?" : submitting ? "On it. One moment…" : "Paste your site and I’ll use it like a customer.";
  const [before, em, after] = replayActive
    ? REPLAY_HEADLINES[Math.min(replayStep, REPLAY_STEPS.length - 1)]
    : headline(run, unavailable);
  const message = replayActive
    ? replayStep >= REPLAY_STEPS.length ? "Your screenshots and launch ideas are on the whiteboard." : REPLAY_MESSAGES[replayStep]
    : run ? run.message || (run.status === "queued" ? "Your URL is queued. Exploration starts when a worker picks it up." : labels[run.status]) : "";

  return (
    <>
      <RoughDefs />
      {showCanvas && <Canvas key={board} board={board} restoreSavedFocus={recordedIgnura} />}

      {showForm && (
        <main className={`${styles.stage} ${styles.paper} ${showCanvas ? styles.overlay : ""}`}>
          <p className={`ig-brand ${styles.brand}`}>
            <img src={withBase("/ignura/astra/astra-mark.svg")} width={26} height={26} alt="" draggable={false} />
            <span>Astra</span>
          </p>
          <section className={styles.formPanel} aria-labelledby="url-question">
            <h1 id="url-question" className={styles.title}>
              What’s the URL of your <em>website or app<img className={styles.swoosh} src={withBase("/ignura/doodles/underline-swoosh.svg")} alt="" draggable={false} /></em>?
            </h1>
            <p className={styles.description}>Astra will click around like a customer, take screenshots, and make ad ideas, X and Reddit drafts and UGC plans for your whiteboard.</p>
            <form className={styles.form} onSubmit={submit} aria-busy={submitting}>
              <div className={styles.astra} data-mood={mood} aria-hidden>
                <img className={styles.astraArt} src={withBase("/ignura/astra/astra.svg")} width={124} alt="" draggable={false} />
                {mood === "oops" && <img className={styles.oops} src={withBase("/ignura/doodles/exclaim.svg")} width={16} alt="" draggable={false} />}
              </div>
              <p className={styles.bubble} aria-hidden>{bubble}</p>
              <label className={styles.label} htmlFor="target-url">Website or web app URL</label>
              <div className={styles.fields}>
                <div className={`${styles.field} ${error ? styles.invalid : ""}`} ref={fieldRef}>
                  <svg className={styles.globe} viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
                    <path d="M12 3.2c4.9.1 8.7 3.9 8.7 8.8s-3.8 8.7-8.7 8.8C7.1 20.7 3.3 17 3.3 12S7.1 3.3 12 3.2z" />
                    <path d="M3.6 9.6c2.7.9 5.6 1.2 8.4 1.1 2.8 0 5.6-.4 8.3-1.2M3.7 14.6c2.7-.9 5.5-1.2 8.3-1.1 2.8 0 5.6.4 8.2 1.2" />
                    <path d="M12 3.4c-2.3 2.4-3.4 5.2-3.4 8.6s1.1 6.2 3.4 8.5c2.3-2.3 3.4-5.1 3.4-8.5S14.3 5.8 12 3.4z" />
                  </svg>
                  <input id="target-url" name="url" type="text" inputMode="url" autoComplete="url" ref={inputRef}
                    autoCapitalize="none" spellCheck={false} required placeholder="https://your-product.com"
                    value={targetUrl} readOnly={recordedIgnura} onChange={(event) => setTargetUrl(event.target.value)}
                    aria-invalid={!!error} aria-describedby={error ? "url-error url-help" : "url-help"}
                    disabled={submitting} autoFocus />
                </div>
                <button type="submit" className={`ig-btn ${styles.cta}`} disabled={submitting}>
                  <span>{submitting ? "Starting…" : "Send Astra in"}</span>
                  {!submitting && <i className={styles.arrow} aria-hidden />}
                </button>
              </div>
              <p id="url-help" className={styles.help}>Needs a public link. For now Astra works on websites and browser apps.</p>
              {error && <p id="url-error" role="alert" className={styles.error}>{error}</p>}
            </form>
            <ol className={styles.how} aria-label="What happens next">
              <li>Opens your site</li>
              <li>Uses it like a customer</li>
              <li>Pins findings and launch ideas</li>
            </ol>
            <button type="button" className={styles.textButton} onClick={viewCanvas} disabled={submitting}>
              {runId ? "Back to my run" : "Peek at the whiteboard"}
            </button>
          </section>
        </main>
      )}

      {stageVisible && (
        <main className={`${styles.stage} ${styles.paper} ${styles.overlay} ${handedOff ? styles.leaving : ""}`} aria-hidden={handedOff || undefined}>
          <p className={`ig-brand ${styles.brand}`}>
            <img src={withBase("/ignura/astra/astra-mark.svg")} width={26} height={26} alt="" draggable={false} />
            <span>Astra</span>
          </p>
          <section className={styles.runPanelBig} aria-labelledby="run-title">
            <div className={styles.astraBig} data-mood={failed || unavailable ? "oops" : "busy"} aria-hidden>
              <img className={styles.astraArt} src={withBase("/ignura/astra/astra.svg")} width={132} alt="" draggable={false} />
            </div>
            <h1 id="run-title" className={styles.title}>{before}<em>{em}<img className={styles.swoosh} src={withBase("/ignura/doodles/underline-swoosh.svg")} alt="" draggable={false} /></em>{after}</h1>
            {activeUrl && (
              <a className={styles.target} href={activeUrl} target="_blank" rel="noreferrer">
                <span>{activeUrl}</span>
              </a>
            )}
            {hasProgress && <div className={styles.stepWrap}><RunStepper current={current} failed={failed} labels={replayActive ? REPLAY_STEPS : undefined} /></div>}
            {hasProgress && <p role="status" className={styles.note}><span key={message}>{message}</span></p>}
            {statusError && <p role="alert" className={styles.error}>{statusError}</p>}
            <div className={styles.actions}>
              {(failed || unavailable) ? (
                <button type="button" className={`ig-btn ${styles.cta}`} onClick={newRun}><span>Try another URL</span></button>
              ) : null}
              <button type="button" className={styles.textButton} onClick={() => setPeeked(true)}>Peek at the whiteboard</button>
            </div>
          </section>
        </main>
      )}

      {dockVisible && (
        <aside className={`ig-pop ${styles.dock}`} aria-label="Product exploration">
          <img className={styles.dockMark} src={withBase("/ignura/astra/astra-mark.svg")} width={34} height={34} alt="" draggable={false} />
          <div className={styles.dockBody}>
            <strong>{replayActive ? (replayStep >= REPLAY_STEPS.length ? "All done" : REPLAY_STEPS[replayStep]) : run ? (run.status === "running" ? RUN_STEPS[Math.min(current, LAST_STEP)].label : labels[run.status]) : statusError ? "Run unavailable" : runId ? "Loading run…" : "Astra"}</strong>
            {activeUrl && <a className={styles.dockTarget} href={activeUrl} target="_blank" rel="noreferrer">{activeUrl}</a>}
          </div>
          {hasProgress && <span className={styles.dockMini}><MiniSteps current={current} failed={failed} /></span>}
          <button type="button" className="ig-btn ig-btn-small ig-btn-ghost" onClick={newRun}><span>New run</span></button>
          {hasProgress && <p role="status" className={styles.dockNote}>{message}</p>}
          {statusError && <p role="alert" className={`${styles.error} ${styles.dockNote}`}>{statusError}</p>}
        </aside>
      )}
    </>
  );
}
