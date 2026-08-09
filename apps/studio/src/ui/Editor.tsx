/**
 * The script editor: CodeMirror 6.
 *
 * Not Monaco. ~150 KB against ~2 MB, a composable extension model, and no
 * competing worker architecture to fight with ours (ADR-007). Its cost is no
 * in-editor type checking, which the small DSL surface does not really need.
 *
 * Two things must NOT go through React state:
 *  - the document, on every keystroke (CodeMirror owns it; we sync outward on a
 *    debounce via the store's auto-compile middleware)
 *  - the playback line highlight, which changes many times a second
 *
 * Design doc: Part VII.4.
 */

import { useEffect, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
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

  const initialScript = useSelector((s: RootState) => s.project.script);
  const diagnostics = useSelector((s: RootState) => s.compile.diagnostics);

  // Keep the latest script in a ref so the mount effect never re-runs.
  const scriptRef = useRef(initialScript);
  scriptRef.current = initialScript;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: scriptRef.current,
        extensions: [
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
        ],
      }),
    });
    viewRef.current = view;
    registerEditorView(view);

    return () => {
      registerEditorView(null);
      view.destroy();
      viewRef.current = null;
    };
  }, [dispatch]);

  // Push compiler diagnostics into the gutter and as squiggles.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch(setDiagnostics(view.state, toCodeMirror(view, diagnostics)));
  }, [diagnostics]);

  return <div ref={hostRef} className="editor" />;
}

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
