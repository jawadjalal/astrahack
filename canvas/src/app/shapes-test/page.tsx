"use client";

import { Tldraw, AssetRecordType, createShapeId, type Editor } from "tldraw";
import "tldraw/tldraw.css";
import { applyCustomOp, customShapeUtils } from "@/components/shapes";
// Ops are parsed through the real contract so defaults (w/h, severity, verified) match the server.
import { OpSchema, type Op } from "@/lib/ops";

// Dev-only visual check for the custom shapes.
// Inline SVG so the page never depends on a hotlinked image.
const IMG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#e0e7ff"/><rect x="40" y="40" width="560" height="60" rx="8" fill="#6366f1"/><rect x="40" y="130" width="260" height="200" rx="8" fill="#fff"/><rect x="330" y="130" width="270" height="90" rx="8" fill="#fff"/><rect x="330" y="240" width="270" height="90" rx="8" fill="#fff"/><rect x="200" y="370" width="240" height="56" rx="28" fill="#10b981"/></svg>`
  );
const MP4 = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

function seed(editor: Editor) {
  (window as unknown as { editor: Editor }).editor = editor; // for console debugging
  try {
    run(editor);
  } catch (e) {
    console.error("seed failed", e);
  }
}

function run(editor: Editor) {
  if (editor.getShape(createShapeId("img1"))) return;
  const assetId = AssetRecordType.createId("img1");
  editor.createAssets([
    {
      id: assetId,
      typeName: "asset",
      type: "image",
      meta: {},
      props: { name: "img1", src: IMG, w: 640, h: 480, mimeType: "image/png", isAnimated: false },
    },
  ]);
  editor.createShape({ id: createShapeId("img1"), type: "image", x: 0, y: 0, props: { w: 480, h: 360, assetId } });

  const ops: Op[] = ([
    // annotate BEFORE its target video exists, to exercise the pending queue
    { type: "annotate", id: "ann-vid", target: "vid1", box: { x: 0.55, y: 0.2, w: 0.25, h: 0.3 }, label: "Late target", severity: "high" },
    { type: "annotate", id: "ann1", target: "img1", box: { x: 0.1, y: 0.15, w: 0.4, h: 0.35 }, label: "Broken layout", severity: "critical" },
    { type: "add_video", id: "vid1", src: MP4, x: 560, y: 30, w: 480, h: 270, label: "Run 1: checkout flow", autoplay: false, seekTo: 2 },
    {
      type: "add_finding", id: "f1", x: 0, y: 460, title: "Submit button does nothing after the form is filled in",
      severity: "critical", expected: "Order is placed and a confirmation page appears.",
      actual: "Button shows a spinner for 1s then nothing happens; no network request is made.",
      verified: true, target: "img1", timestamp: 42,
    },
    { type: "add_finding", id: "f2", x: 440, y: 460, title: "Tooltip clipped", severity: "low", verified: false, target: "vid1" },
    { type: "add_finding", id: "f3", x: 880, y: 460, title: "Heading contrast is slightly low", severity: "medium", expected: "4.5:1", actual: "3.9:1", verified: false },
    { type: "add_finding", id: "f4", x: 1320, y: 460, title: "FYI: analytics script loads twice", severity: "info", verified: false, timestamp: 7 },
    { type: "add_finding", id: "f5", x: 1320, y: 0, title: "Session expires silently", severity: "high", expected: "A warning toast", actual: "Redirect to login without notice", verified: true },
  ] as unknown[]).map((o) => OpSchema.parse(o));
  for (const op of ops) applyCustomOp(editor, op);
  requestAnimationFrame(() => editor.zoomToFit({ animation: { duration: 0 } }));
}

export default function ShapesTest() {
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Tldraw shapeUtils={customShapeUtils} onMount={seed} />
    </div>
  );
}
