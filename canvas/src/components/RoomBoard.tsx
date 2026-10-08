"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { boardUrl } from "../lib/boardClient";
import { authHeaders } from "../lib/roomToken";
import { roomToOps, type RoomIn } from "../lib/roomToOps";
import { isRoomId } from "../lib/roomId";

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
  return <Canvas board={board} readOnly={readOnly} room restoreSavedFocus agentName={agent} />;
}
