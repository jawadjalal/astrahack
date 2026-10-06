"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useValue, type Editor } from "tldraw";
import {
  IconArrow,
  IconClose,
  IconDraw,
  IconFit,
  IconFollow,
  IconHand,
  IconLink,
  IconNote,
  IconPlus,
  IconPresent,
  IconSelect,
  IconText,
  IconTrash,
  IconUpload,
} from "./icons";
import { ACCEPT, ingestMedia, linkProblem } from "./mediaActions";
import { fitAll } from "../../lib/fit";

type Props = {
  editor: Editor;
  follow: boolean;
  onFollow: () => void;
  onPresent: () => void;
  onClear: () => void;
};

const TOOLS: { id: string; label: string; key: string; icon: ReactNode }[] = [
  { id: "select", label: "Select", key: "V", icon: <IconSelect /> },
  { id: "hand", label: "Hand", key: "H", icon: <IconHand /> },
  { id: "draw", label: "Draw", key: "D", icon: <IconDraw /> },
  { id: "note", label: "Note", key: "N", icon: <IconNote /> },
  { id: "arrow", label: "Arrow", key: "A", icon: <IconArrow /> },
  { id: "text", label: "Text", key: "T", icon: <IconText /> },
];

function Btn({
  label,
  hint,
  active,
  onClick,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`ig-tool ${active ? "is-active" : ""} ${className}`}
      aria-label={label}
      aria-pressed={active}
      data-tip={hint ? `${label}  ${hint}` : label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Toolbar({ editor, follow, onFollow, onPresent, onClear }: Props) {
  const tool = useValue("tool", () => editor.getCurrentToolId(), [editor]);
  const [menu, setMenu] = useState<null | "add" | "clear">(null);
  const [link, setLink] = useState("");
  const [err, setErr] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  // close popovers on outside click / Escape
  useEffect(() => {
    if (!menu) return;
    const down = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setMenu(null);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [menu]);

  // "U" opens the Add menu
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "u") {
        e.preventDefault();
        setMenu((m) => (m === "add" ? null : "add"));
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const pickFiles = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (file.current) file.current.value = "";
    if (!files.length) return;
    ingestMedia(editor, files);
    setMenu(null);
  };

  const submitLink = () => {
    const url = link.trim();
    if (!url) return;
    const problem = linkProblem(url);
    if (problem) return setErr(problem);
    ingestMedia(editor, [url]);
    setLink("");
    setErr("");
    setMenu(null);
  };

  return (
    <div className="ig-toolbar-wrap" ref={root}>
      {menu === "add" && (
        <div className="ig-pop ig-pop-add" role="dialog" aria-label="Add to the board">
          <div className="ig-pop-title">Add to the board</div>
          <button type="button" className="ig-pop-row" onClick={() => file.current?.click()}>
            <IconUpload />
            <span>
              <b>Upload image or video</b>
              <small>PNG, JPG, MP4, WebM, MOV. You can also drop or paste them anywhere.</small>
            </span>
          </button>
          <div className="ig-pop-row ig-pop-link">
            <IconLink />
            <input
              className="ig-input"
              placeholder="Paste an image or video link"
              value={link}
              autoFocus
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") submitLink();
              }}
            />
            <button type="button" className="ig-btn ig-btn-small" onClick={submitLink} disabled={!link.trim()}>
              Add
            </button>
          </div>
          {err && <div className="ig-pop-note is-err">{err}</div>}
          <input ref={file} type="file" accept={ACCEPT} multiple hidden onChange={(e) => pickFiles(e.target.files)} />
        </div>
      )}
      {menu === "clear" && (
        <div className="ig-pop ig-pop-clear" role="alertdialog" aria-label="Clear the board">
          <div className="ig-pop-title">Clear the whole board?</div>
          <p className="ig-pop-p">Everything your agent drew goes away for everyone watching.</p>
          <div className="ig-pop-actions">
            <button type="button" className="ig-btn ig-btn-ghost" onClick={() => setMenu(null)}>
              Keep it
            </button>
            <button
              type="button"
              className="ig-btn ig-btn-danger"
              onClick={() => {
                setMenu(null);
                onClear();
              }}
            >
              Clear it
            </button>
          </div>
        </div>
      )}

      <div className="ig-toolbar" role="toolbar" aria-label="Canvas tools">
        {TOOLS.map((t) => (
          <Btn key={t.id} label={t.label} hint={t.key} active={tool === t.id} onClick={() => editor.setCurrentTool(t.id)}>
            {t.icon}
            <i className="ig-key">{t.key}</i>
          </Btn>
        ))}
        <span className="ig-sep" aria-hidden />
        <button
          type="button"
          className={`ig-add ${menu === "add" ? "is-open" : ""}`}
          data-tip="Add image, video or link  U"
          aria-expanded={menu === "add"}
          onClick={() => setMenu(menu === "add" ? null : "add")}
        >
          {menu === "add" ? <IconClose /> : <IconPlus />}
          <span>Add</span>
        </button>
        <span className="ig-sep" aria-hidden />
        <Btn label="Present (client view)" hint="Shift+P" onClick={onPresent}>
          <IconPresent />
        </Btn>
        <Btn label={follow ? "Following the agent" : "Follow the agent"} hint="Shift+F" active={follow} onClick={onFollow}>
          <IconFollow />
        </Btn>
        <Btn label="Fit everything" hint="Shift+1" onClick={() => fitAll(editor)}>
          <IconFit />
        </Btn>
        <Btn label="Clear the board" active={menu === "clear"} onClick={() => setMenu(menu === "clear" ? null : "clear")} className="ig-tool-danger">
          <IconTrash />
        </Btn>
      </div>
    </div>
  );
}
