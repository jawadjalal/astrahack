"use client";

import { useState } from "react";
import { withBase } from "../../lib/base";
import { withBoard } from "../../lib/board.mjs";
import { IconCopy } from "./icons";

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="ig-copy"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      <code>{label}</code>
      <span aria-hidden>{done ? "copied" : <IconCopy />}</span>
    </button>
  );
}

/** Shown while the board has nothing on it. Pointer events pass through except on the copy chips. */
export function EmptyState({ board }: { board?: string } = {}) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const endpoint = `${origin}${withBoard(withBase("/api/ops"), board)}`;
  const curl = `curl -X POST ${endpoint} -H 'content-type: application/json' -d '{"type":"add_shape","kind":"note","x":0,"y":0,"text":"hello from my agent"}'`;
  return (
    <div className="ig-empty">
      <img className="ig-empty-astra" src={withBase("/ignura/astra/astra.svg")} alt="" width={150} draggable={false} />
      <h1>
        Waiting for your <em>agent<img className="ig-und" src={withBase("/ignura/doodles/underline-swoosh.svg")} alt="" draggable={false} /></em>...
      </h1>
      <p className="ig-empty-line">
        Point it here: run the <b>MCP server</b> (<code>canvas_*</code> tools) or <b>POST /api/ops</b>.
      </p>
      <div className="ig-empty-copy">
        <Copy text={endpoint} label="POST /api/ops" />
        <Copy text={curl} label="copy a test curl" />
      </div>
      <p className="ig-empty-hint">
        Or drop an image or MP4 anywhere, or hit <b>Add</b>.
      </p>
    </div>
  );
}
