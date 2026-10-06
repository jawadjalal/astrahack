"use client";

import { DefaultStylePanel, useEditor, useValue, type TLUiStylePanelProps } from "tldraw";

const STYLED_TOOLS = new Set(["draw", "arrow", "geo", "note", "text", "line", "highlight"]);

/** tldraw's style panel, but only when there is something to style: a selection, or a drawing tool in hand. */
export function IguraStylePanel(props: TLUiStylePanelProps) {
  const editor = useEditor();
  const show = useValue(
    "ig-show-styles",
    () => !editor.getIsReadonly() && (editor.getSelectedShapeIds().length > 0 || STYLED_TOOLS.has(editor.getCurrentToolId())),
    [editor],
  );
  if (!show) return null;
  return <DefaultStylePanel {...props} />;
}
