"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef } from "react";
import type { Editor } from "tldraw";
import { boardUrl } from "../lib/boardClient";
import { authHeaders } from "../lib/roomToken";
import { roomToOps, type RoomIn } from "../lib/roomToOps";
import { isRoomId } from "../lib/roomId";
import { availableSections, goToSection } from "../lib/roomSections";

const Canvas = dynamic(() => import("./Canvas"), {
  ssr: false,
  loading: () => <p role="status" style={{ padding: 24, font: "16px system-ui" }}>Opening the board…</p>,
});

const measure = (url: string) =>
  new Promise<{ w: number; h: number } | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
    setTimeout(() => resolve(null), 6000);
  });

/**
 * The board of one Ignura project room. `readOnly` is a visitor (public link): no tools, no editing.
 * A team member's page (ro=0) also listens for the parent page to hand it the room's notes; if the board is
 * still empty it draws them (title, overview, findings with their screenshots, opportunities, sketch).
 */
export default function RoomBoard({ board, readOnly, agent }: { board: string; readOnly: boolean; agent?: string }) {
  const seeding = useRef(false);
  const editorRef = useRef<Editor | null>(null);
  const announced = useRef("");

  // tell the parent page which sections exist, so its chips only offer real ones
  const announce = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const sections = availableSections(ed);
    const key = JSON.stringify(sections);
    if (key === announced.current) return;
    announced.current = key;
    window.parent?.postMessage({ type: "ig-room-sections", sections }, window.location.origin);
  }, []);
  const onEditor = useCallback((ed: Editor) => {
    editorRef.current = ed;
    // the board fills in as its history replays, and again when a team member's seed lands
    let tries = 0;
    const t = setInterval(() => { announce(); if (++tries > 40) clearInterval(t); }, 800);
  }, [announce]);

  // chips and the Present button on the parent page
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const ed = editorRef.current;
      if (event.data?.type === "ig-room-goto" && ed) goToSection(ed, String(event.data.section));
      if (event.data?.type === "ig-room-present") window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyP", shiftKey: true }));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (readOnly || !isRoomId(board)) return;
    const onMessage = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== "ig-room-seed" || seeding.current) return;
      seeding.current = true;
      try {
        const state = await fetch(boardUrl("/api/state", board), { cache: "no-store", headers: authHeaders() });
        if (!state.ok) return;
        const { ops } = (await state.json()) as { ops: unknown[] };
        if (ops.length) return;
        const all = await roomToOps(event.data.room as RoomIn, measure);
        for (let i = 0; i < all.length; i += 40) {
          const res = await fetch(boardUrl("/api/ops", board), {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeaders() },
            body: JSON.stringify(all.slice(i, i + 40)),
          });
          if (!res.ok) break;
        }
      } finally {
        seeding.current = false;
      }
    };
    window.addEventListener("message", onMessage);
    window.parent?.postMessage({ type: "ig-room-ready" }, window.location.origin);
    return () => window.removeEventListener("message", onMessage);
  }, [board, readOnly]);

  if (!isRoomId(board)) {
    return <p style={{ padding: 24, font: "16px system-ui" }}>This board link is not valid.</p>;
  }
  return <Canvas board={board} readOnly={readOnly} room restoreSavedFocus agentName={agent} onEditor={onEditor} />;
}
