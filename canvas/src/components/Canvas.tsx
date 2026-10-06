"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tldraw, useValue, type Editor, type TLUiComponents } from "tldraw";
import "tldraw/tldraw.css";
import { applyEnvelope } from "../lib/applyOp";
import { withBase } from "../lib/base";
import type { Envelope } from "../lib/ops";
import { activity } from "../lib/activity";
import { makeIguraTheme } from "../lib/ignuraTheme";
import { fitAll } from "../lib/fit";
import { useMediaIntake } from "./media/useMediaIntake";
import { customShapeUtils } from "./shapes";
import { motion } from "./shapes/RoughBox";
import { Toolbar } from "./ui/Toolbar";
import { ActivityPanel } from "./ui/ActivityPanel";
import { AgentAvatar } from "./ui/AgentAvatar";
import { EmptyState } from "./ui/EmptyState";
import { IguraStylePanel } from "./ui/IguraStylePanel";

type Status = "connecting" | "connected" | "reconnecting";

// Replace tldraw's busy chrome. Shortcuts keep working; our own toolbar/panels live outside <Tldraw>.
const components: TLUiComponents = {
  Toolbar: null,
  MainMenu: null,
  PageMenu: null,
  ActionsMenu: null,
  HelpMenu: null,
  ZoomMenu: null,
  NavigationPanel: null,
  Minimap: null,
  QuickActions: null,
  KeyboardShortcutsDialog: null,
  HelperButtons: null,
  DebugPanel: null,
  DebugMenu: null,
  MenuPanel: null,
  TopPanel: null,
  SharePanel: null,
  StylePanel: IguraStylePanel,
};

export default function Canvas() {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [opCount, setOpCount] = useState(0);
  const [ready, setReady] = useState(false);
  const [follow, setFollow] = useState(true);
  const [present, setPresent] = useState(false);
  const followRef = useRef(true);
  followRef.current = follow;
  const themes = useMemo(() => ({ default: makeIguraTheme() }), []);

  const handleMount = useCallback((ed: Editor) => {
    ed.user.updateUserPreferences({ colorScheme: "light" });
    ed.updateInstanceState({ isGridMode: true }); // dotted paper
    (window as unknown as { __editor?: Editor }).__editor = ed; // debugging handle
    setEditor(ed);
  }, []);

  // ---- connection: state snapshot, then SSE with auto-reconnect ----
  useEffect(() => {
    if (!editor) return;
    let disposed = false;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let lastSeq = 0;
    let seen = new Set<number>();
    let bulk = true; // initial replay: no camera follow, no animation
    let chain: Promise<void> = Promise.resolve();
    activity.reset();

    const enqueue = (env: Envelope) => {
      if (seen.has(env.seq)) return;
      seen.add(env.seq);
      if (env.op.type === "clear") {
        // server may restart numbering after a clear; forget older seqs
        seen = new Set([env.seq]);
        lastSeq = env.seq;
      } else {
        lastSeq = Math.max(lastSeq, env.seq);
      }
      activity.push(env);
      chain = chain
        .then(() =>
          applyEnvelope(editor, env, {
            follow: !bulk && followRef.current,
            animate: !bulk,
          }),
        )
        .catch((e) => console.error("[canvas] apply failed", env, e))
        .then(() => setOpCount((n) => n + 1));
    };

    const connect = () => {
      if (disposed) return;
      es = new EventSource(withBase(`/api/events?since=${lastSeq}`));
      es.onopen = () => setStatus("connected");
      es.onmessage = (m) => {
        try {
          enqueue(JSON.parse(m.data) as Envelope);
        } catch (e) {
          console.error("[canvas] bad event", m.data, e);
        }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (disposed) return;
        setStatus("reconnecting");
        retry = setTimeout(connect, 1500);
      };
    };

    (async () => {
      try {
        const res = await fetch(withBase("/api/state"), { cache: "no-store" });
        const state = (await res.json()) as { seq: number; ops: Envelope[] };
        for (const env of state.ops) enqueue(env);
        lastSeq = Math.max(lastSeq, state.seq ?? 0);
      } catch (e) {
        console.warn("[canvas] state fetch failed", e);
      }
      if (disposed) return;
      await chain;
      bulk = false;
      motion.enabled = true;
      setReady(true);
      connect();
      // fit once the viewport is actually measured (a hidden/unsized tab reports 1x1 and
      // zoomToFit would pick a bogus zoom)
      for (let i = 0; i < 300 && !disposed && editor.getViewportScreenBounds().w < 50; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 150));
      if (!disposed && editor.getCurrentPageShapeIds().size) fitAll(editor, { immediate: true });
    })();

    return () => {
      disposed = true;
      es?.close();
      if (retry) clearTimeout(retry);
    };
  }, [editor]);

  // ---- present mode ----
  useEffect(() => {
    editor?.updateInstanceState({ isReadonly: present });
    if (present) editor?.selectNone();
  }, [editor, present]);

  // ---- shortcuts: Shift+P present, Shift+F follow, Esc leaves present ----
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape" && present) return setPresent(false);
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "KeyP") {
        e.preventDefault();
        setPresent((p) => !p);
      } else if (e.code === "KeyF") {
        e.preventDefault();
        setFollow((f) => !f);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [present]);

  // ---- media intake: drag-drop, paste, URL paste, progress toasts, lightbox ----
  useMediaIntake(editor);

  const clearAll = async () => {
    await fetch(withBase("/api/state"), { method: "DELETE" });
  };

  const empty = useValue("ig-empty", () => !!editor && editor.getCurrentPageShapeIds().size === 0, [editor]);

  return (
    <div
      className="ig-root"
      data-present={present || undefined}
      style={{ position: "fixed", inset: 0 }}
    >
      <Tldraw shapeUtils={customShapeUtils} themes={themes} components={components} onMount={handleMount} />

      {editor && (
        <>
          <AgentAvatar editor={editor} />
          {ready && empty && <EmptyState />}
          {!present && <ActivityPanel editor={editor} />}
          {!present && (
            <Toolbar
              editor={editor}
              follow={follow}
              onFollow={() => setFollow((f) => !f)}
              onPresent={() => setPresent(true)}
              onClear={clearAll}
            />
          )}
        </>
      )}

      <div className="ig-brand">
        <img src={withBase("/ignura/iggy/iggy-mark.svg")} width={26} height={26} alt="" draggable={false} />
        <span className="ig-brand-word">Ignura</span>
        <span className={`ig-status is-${status}`} role="status">
          <i />
          {status === "connected" ? "live" : status === "reconnecting" ? "reconnecting" : "connecting"}
          <small>{opCount} {opCount === 1 ? "op" : "ops"}</small>
        </span>
      </div>

      {present && (
        <button type="button" className="ig-exit" onClick={() => setPresent(false)}>
          Exit client view <kbd>Esc</kbd>
        </button>
      )}
    </div>
  );
}
