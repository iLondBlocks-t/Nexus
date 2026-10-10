import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import type { Extension } from "@codemirror/state";
import { api, errorText } from "../api";
import { useI18n } from "../i18n";

interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
}

function languageFor(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "ts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "jsx":
      return javascript({ jsx: true });
    case "json":
      return json();
    case "html":
      return html();
    case "css":
      return css();
    case "md":
      return markdown();
    case "py":
      return python();
    default:
      return [];
  }
}

export function FilesEditor({ projectId, tick, openFile, onOpen }: { projectId: string; tick: number; openFile: string | null; onOpen: (p: string | null) => void }) {
  const { t, theme } = useI18n();
  const [dirs, setDirs] = useState<Record<string, TreeEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savedText = useRef<string>("");
  const loadedPath = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const loadDir = useCallback(
    async (path: string) => {
      const res = await api<{ entries: TreeEntry[] }>("GET", `/api/projects/${encodeURIComponent(projectId)}/tree?path=${encodeURIComponent(path)}`);
      setDirs((d) => ({ ...d, [path]: res.entries }));
    },
    [projectId],
  );

  // Refresh the visible tree whenever the project changes.
  useEffect(() => {
    const paths = ["", ...expanded];
    Promise.all(paths.map((p) => loadDir(p))).catch((err) => setError(errorText(err)));
  }, [tick, expanded, loadDir]);

  const toggleDir = (path: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  };

  const setEditorText = useCallback((text: string, path: string) => {
    const view = viewRef.current;
    if (!view) return;
    view.setState(
      EditorState.create({
        doc: text,
        extensions: editorExtensions(path, theme),
      }),
    );
  }, [theme]);

  // Create the editor once.
  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({ doc: "", extensions: editorExtensions("", theme) }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor is created once; theme and language changes rebuild its state below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the open file. The same file is reloaded on external change (agent edits) only when the buffer is clean.
  useEffect(() => {
    if (!openFile) return;
    const same = loadedPath.current === openFile;
    if (same && dirtyRef.current) {
      setStatus(t("unsaved"));
      return;
    }
    if (!same && dirtyRef.current && !window.confirm(`${t("unsaved")}. ${t("confirmDiscard")}`)) {
      onOpen(loadedPath.current);
      return;
    }
    api<{ content: string }>("GET", `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(openFile)}`)
      .then((res) => {
        loadedPath.current = openFile;
        savedText.current = res.content;
        setEditorText(res.content, openFile);
        setDirty(false);
        setStatus("");
      })
      .catch((err) => setError(errorText(err)));
    // onOpen is stable enough (a state setter from the parent); not a reload trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFile, projectId, tick, setEditorText, t]);

  const save = useCallback(async () => {
    const view = viewRef.current;
    if (!view || !openFile) return;
    const content = view.state.doc.toString();
    try {
      await api("PUT", `/api/projects/${encodeURIComponent(projectId)}/file`, { path: openFile, content });
      savedText.current = content;
      setDirty(false);
      setStatus(t("saved"));
    } catch (err) {
      setError(errorText(err));
    }
  }, [openFile, projectId, t]);

  // Ctrl/Cmd-S is handled on the editor host so it always calls the latest save.
  const saveRef = useRef(save);
  saveRef.current = save;

  function renderTree(path: string, depth = 0): ReactElement[] {
    const entries = dirs[path] ?? [];
    return entries.flatMap((e) => {
      const isOpen = expanded.has(e.path);
      const row = (
        <li key={e.path} role="treeitem" aria-expanded={e.type === "dir" ? isOpen : undefined} aria-selected={openFile === e.path}>
          <button
            className={`tree-row ${openFile === e.path ? "selected" : ""}`}
            style={{ paddingInlineStart: `${10 + depth * 14}px` }}
            onClick={() => (e.type === "dir" ? toggleDir(e.path) : onOpen(e.path))}
          >
            <span aria-hidden="true">{e.type === "dir" ? (isOpen ? "▾ " : "▸ ") : "· "}</span>
            {e.name}
          </button>
        </li>
      );
      return e.type === "dir" && isOpen ? [row, ...renderTree(e.path, depth + 1)] : [row];
    });
  }

  return (
    <div className="editor-layout">
      <div className="files" aria-label={t("files")}>
        <div className="pane-title">{t("files")}</div>
        <ul role="tree" className="tree">
          {renderTree("")}
        </ul>
        {dirs[""]?.length === 0 && <p className="muted small">—</p>}
      </div>
      <div className="editor-wrap">
        <div className="pane-title row">
          <span className="grow" dir="ltr">
            {openFile ?? t("editor")}
            {dirty && <span className="badge warn">●</span>}
          </span>
          {openFile && (
            <button className="primary small" onClick={save} disabled={!dirty}>
              {t("save")}
            </button>
          )}
        </div>
        {!openFile && <p className="muted pad">{t("selectFile")}</p>}
        <div className="cm-host" ref={hostRef} hidden={!openFile} onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void saveRef.current();
          }
        }} />
        {status && <p className="muted small pad" role="status">{status}</p>}
        {error && (
          <p className="error small pad" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );

  function editorExtensions(path: string, th: string): Extension[] {
    return [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      languageFor(path),
      th === "midnight" ? oneDark : [],
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          const changed = u.state.doc.toString() !== savedText.current;
          setDirty(changed);
        }
      }),
      EditorView.theme({ "&": { height: "100%", fontSize: "13.5px" }, ".cm-scroller": { fontFamily: "var(--mono)" } }),
    ];
  }
}
