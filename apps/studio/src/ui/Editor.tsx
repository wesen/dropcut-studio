/**
 * The script editor: CodeMirror 6.
 *
 * Not Monaco. ~150 KB against ~2 MB, a composable extension model, and no
 * competing worker architecture to fight with ours (ADR-007). Its cost is no
 * in-editor type checking, which the small DSL surface does not really need.
 *
 * OWNERSHIP. CodeMirror owns the document while the user is typing, and the
 * store owns it when something else replaces it — opening a project, starting a
 * new one, importing a file. Those two directions need different mechanisms:
 * typing flows OUT through an update listener, and a document load flows IN by
 * replacing the editor state. Getting only the first direction working is easy
 * and produces an editor that silently ignores every project you open.
 *
 * Two things must NOT go through React state:
 *  - the document, on every keystroke
 *  - the playback line highlight, which changes many times a second
 *
 * Design doc: Part VII.4.
 */

import { useEffect, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { Decoration } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import type { Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";
import type { Diagnostic } from "@cam/ir";
import type { AppDispatch, RootState } from "../state/store.js";
import { scriptChanged } from "../state/slices.js";

/* --------------------- active-line highlight ---------------------------- */

const setActiveLine = StateEffect.define<number | null>();

const activeLineMark = Decoration.line({ class: "cm-activeMachiningLine" });

/**
 * A StateField rather than React state.
 *
 * During playback this updates ~12 times a second. Routing it through a
 * component render would re-render the whole editor each time for the sake of
 * one background colour.
 */
const activeLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setActiveLine)) continue;
      const line = e.value;
      if (line === null || line < 1 || line > tr.state.doc.lines) {
        next = Decoration.none;
      } else {
        next = Decoration.set([activeLineMark.range(tr.state.doc.line(line).from)]);
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/* ------------------------------ component ------------------------------- */

export function Editor() {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const dispatch = useDispatch<AppDispatch>();

  const script = useSelector((s: RootState) => s.project.script);
  const loadGeneration = useSelector((s: RootState) => s.project.loadGeneration);
  const diagnostics = useSelector((s: RootState) => s.compile.diagnostics);

  // Read at mount only. Subsequent changes arrive through the sync effects
  // below, which is the part that is easy to forget.
  const scriptRef = useRef(script);
  scriptRef.current = script;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      parent: host,
      state: makeState(scriptRef.current, dispatch),
    });
    viewRef.current = view;
    registerEditorView(view);

    return () => {
      registerEditorView(null);
      view.destroy();
      viewRef.current = null;
    };
  }, [dispatch]);

  /**
   * A document was loaded from outside: replace the editor state wholesale.
   *
   * `setState` rather than a change transaction, because it also discards undo
   * history. With a plain transaction, Ctrl-Z immediately after opening a
   * project would undo backwards into the PREVIOUS project's text — the editor
   * would appear to corrupt the file you just opened.
   *
   * Guarded on `loadGeneration` rather than on the text, so that reopening the
   * same document still resets history, and so a load whose text coincidentally
   * matches is not mistaken for a no-op.
   */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (loadGeneration === 0) return;   // nothing loaded yet; mount handled it
    view.setState(makeState(scriptRef.current, dispatch));
  }, [loadGeneration, dispatch]);

  /**
   * Safety net: keep the document in step with the store.
   *
   * Normally a no-op, because the store's script IS what the user typed. It
   * catches any future path that mutates the script without bumping the load
   * generation, so such a change degrades to "cursor jumps" rather than "the
   * editor silently shows the wrong program".
   */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === script) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: script },
    });
  }, [script]);

  // Push compiler diagnostics into the gutter and as squiggles.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch(setDiagnostics(view.state, toCodeMirror(view, diagnostics)));
  }, [diagnostics]);

  return <div ref={hostRef} className="editor" />;
}

/** The extension set, shared by mount and by document loads. */
function extensions(dispatch: AppDispatch): Extension[] {
  return [
    lineNumbers(),
    history(),
    highlightActiveLine(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    javascript(),
    lintGutter(),
    activeLineField,
    oneDark,
    EditorView.theme({
      "&": { height: "100%", fontSize: "12.5px" },
      ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
      ".cm-activeMachiningLine": { backgroundColor: "rgba(255, 177, 0, 0.12)" },
    }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) dispatch(scriptChanged(u.state.doc.toString()));
    }),
  ];
}

const makeState = (doc: string, dispatch: AppDispatch): EditorState =>
  EditorState.create({ doc, extensions: extensions(dispatch) });

/**
 * Map compiler diagnostics onto editor ranges.
 *
 * Only diagnostics that carry a script location can be placed. The rest appear
 * in the Diagnostics panel — which is why that panel exists, rather than relying
 * on the gutter alone.
 */
function toCodeMirror(view: EditorView, diagnostics: readonly Diagnostic[]): CmDiagnostic[] {
  const out: CmDiagnostic[] = [];
  const doc = view.state.doc;

  for (const d of diagnostics) {
    const loc = d.provenance?.script;
    if (!loc || loc.line < 1 || loc.line > doc.lines) continue;
    const line = doc.line(loc.line);
    out.push({
      from: line.from,
      to: line.to,
      severity: d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info",
      message: `${d.code}: ${d.message}`,
    });
  }
  return out;
}

/**
 * Module-level handle, so playback can highlight a line without a re-render.
 *
 * Same reasoning as the viewport handle: there is one editor, the update rate is
 * far above React's comfort zone, and keeping the escape hatch in one named
 * place beats threading refs through the tree.
 */
let editorView: EditorView | null = null;
export const registerEditorView = (v: EditorView | null): void => { editorView = v; };

/** Highlight a source line without going through React. */
export function highlightScriptLine(line: number | null): void {
  editorView?.dispatch({ effects: setActiveLine.of(line) });
}
