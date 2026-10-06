"use client";

import dynamic from "next/dynamic";
import { useEffect, useState, type FormEvent } from "react";
import { withBase } from "../lib/base";
import type { Run } from "../lib/runs";
import styles from "./RunExperience.module.css";

const Canvas = dynamic(() => import("./Canvas"), { ssr: false });

const terminal = new Set(["completed", "partial", "failed"]);
const labels: Record<Run["status"], string> = {
  queued: "Waiting for a worker",
  running: "Exploring your product",
  completed: "Run complete",
  partial: "Run finished with gaps",
  failed: "Run could not finish",
};

function updateLocation(runId?: string, canvas = false) {
  const url = new URL(window.location.href);
  url.searchParams.delete("run");
  url.searchParams.delete("view");
  if (runId) url.searchParams.set("run", runId);
  else if (canvas) url.searchParams.set("view", "canvas");
  window.history.replaceState(null, "", url);
}

export default function RunExperience({ initialRunId = null, initialCanvas = false }: { initialRunId?: string | null; initialCanvas?: boolean }) {
  const [targetUrl, setTargetUrl] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [runId, setRunId] = useState<string | null>(initialRunId);
  const [showCanvas, setShowCanvas] = useState(!!initialRunId || initialCanvas);
  const [showForm, setShowForm] = useState(!initialRunId && !initialCanvas);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");

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

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setError("");
    const trimmed = targetUrl.trim();
    let url: URL;
    try {
      url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
      if (!trimmed || !["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      setError("Enter a valid website or web app URL.");
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
      setRunId(data.run.id);
      setStatusError("");
      setShowCanvas(true);
      setShowForm(false);
      updateLocation(data.run.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the run. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const viewCanvas = () => {
    setShowCanvas(true);
    setShowForm(false);
    updateLocation(runId || undefined, true);
  };

  return (
    <>
      {showCanvas && <Canvas />}
      {showForm ? (
        <main className={`${styles.launcher} ${showCanvas ? styles.overlay : ""}`}>
          <section className={styles.formPanel} aria-labelledby="url-question">
            <p className={styles.brand}>AstraHack</p>
            <h1 id="url-question">What’s the URL of your website or app?</h1>
            <p className={styles.description}>We’ll explore its key flows, capture screenshots, and create ad concepts, X and Reddit campaign drafts, and UGC plans on your canvas.</p>
            <form onSubmit={submit}>
              <label className={styles.label} htmlFor="target-url">Website or web app URL</label>
              <div className={styles.fields}>
                <input id="target-url" name="url" type="text" inputMode="url" autoComplete="url"
                  autoCapitalize="none" spellCheck={false} required placeholder="https://your-product.com"
                  value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)}
                  aria-invalid={!!error} aria-describedby={error ? "url-error url-help" : "url-help"}
                  disabled={submitting} autoFocus />
                <button type="submit" disabled={submitting}>{submitting ? "Starting…" : "Explore product"}</button>
              </div>
              <p id="url-help" className={styles.help}>Use a publicly accessible URL. The current web flow explores websites and browser apps.</p>
              {error && <p id="url-error" role="alert" className={styles.error}>{error}</p>}
            </form>
            <button type="button" className={styles.textButton} onClick={viewCanvas} disabled={submitting}>
              {runId ? "Back to run" : "View canvas"}
            </button>
          </section>
        </main>
      ) : (
        <aside className={styles.runPanel} aria-label="Product exploration">
          <div className={styles.runHeading}>
            <strong>{run ? labels[run.status] : statusError ? "Run unavailable" : runId ? "Loading run…" : "AstraHack"}</strong>
            <button type="button" className={styles.textButton} onClick={() => { setError(""); setShowForm(true); }}>New run</button>
          </div>
          {run && <>
            <a className={styles.target} href={run.url} target="_blank" rel="noreferrer">{run.url}</a>
            <p role="status">{run.message || (run.status === "queued" ? "Your URL is queued. Exploration starts when a worker picks it up." : labels[run.status])}</p>
          </>}
          {statusError && <p role="alert" className={styles.error}>{statusError}</p>}
        </aside>
      )}
    </>
  );
}
