"use client";

import { useEffect, useRef, useState } from "react";
import { Box, createShapeId, type Editor, type TLShapeId } from "tldraw";
import { activity, type ActivityRow } from "../../lib/activity";
import { sevColor } from "../shapes/severity";
import { IconActivity, IconChevron } from "./icons";
import { withBase } from "../../lib/base";
import { chrome, fitBox } from "../../lib/fit";

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

const GLYPH: Record<ActivityRow["kind"], string> = {
  image: "▣",
  video: "▶",
  shape: "✎",
  arrow: "➜",
  annotate: "◻",
  finding: "!",
  say: "“",
  edit: "~",
  focus: "◎",
  clear: "×",
};

function focusRow(editor: Editor, row: ActivityRow) {
  const ids = row.ids.map((i) => createShapeId(i) as TLShapeId).filter((i) => editor.getShape(i));
  if (!ids.length) return;
  // the first id is the row's own element; arrows also list their endpoints for framing
  let box: Box | null = null;
  for (const id of ids) {
    const b = editor.getShapePageBounds(id);
    if (b) box = box ? Box.Common([box, b]) : b.clone();
  }
  if (!box) return;
  editor.select(ids[0]);
  fitBox(editor, box, { maxZoom: 1.2, duration: 450, pad: 80 });
}

export function ActivityPanel({ editor }: { editor: Editor }) {
  const [rows, setRows] = useState<ActivityRow[]>(activity.get());
  // null = automatic: stays tucked away while the board is empty, opens once the agent has done something
  const [pref, setPref] = useState<boolean | null>(null);
  const open = pref ?? rows.length > 0;
  const setOpen = (v: boolean) => setPref(v);
  const [now, setNow] = useState(() => Date.now());
  const [fresh, setFresh] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(
    () =>
      activity.subscribe((r) => {
        setRows(r);
        setFresh(r[r.length - 1]?.key ?? null);
      }),
    [],
  );
  // keep the camera helpers aware of the space the panel takes
  useEffect(() => {
    chrome.left = open && window.innerWidth >= 700 ? 332 : 0;
    return () => {
      chrome.left = 0;
    };
  }, [open]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows, open]);

  if (!open) {
    return (
      <button type="button" className="ig-act-tab" onClick={() => setOpen(true)} aria-label="Open activity" data-tip="Show what the agent did">
        <IconActivity />
        <span>Activity</span>
        {rows.length > 0 && <b>{rows.length}</b>}
      </button>
    );
  }

  return (
    <aside className="ig-act" aria-label="Agent activity">
      <header className="ig-act-head">
        <img src={withBase("/ignura/iggy/iggy-mark.svg")} width={22} height={22} alt="" draggable={false} />
        <h2>What Iggy did</h2>
        <span className="ig-act-count">{rows.length}</span>
        <button type="button" className="ig-icon-btn" onClick={() => setOpen(false)} aria-label="Collapse activity">
          <IconChevron dir="left" />
        </button>
      </header>
      <div
        className="ig-act-list"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {rows.length === 0 ? (
          <p className="ig-act-empty">Nothing yet. When your agent adds a screenshot or flags a bug, it shows up here.</p>
        ) : (
          rows.map((r) => (
            <button
              type="button"
              key={r.key}
              className={`ig-act-row ${r.key === fresh ? "is-fresh" : ""}`}
              disabled={!r.ids.length}
              onClick={() => focusRow(editor, r)}
              title={r.ids.length ? "Show on the board" : undefined}
            >
              <span
                className={`ig-act-dot k-${r.kind}`}
                style={r.severity ? ({ "--dot": sevColor(r.severity) } as React.CSSProperties) : undefined}
                aria-hidden
              >
                {GLYPH[r.kind]}
              </span>
              <span className="ig-act-text">{r.text}</span>
              <time>{ago(r.ts, now)}</time>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
