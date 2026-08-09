/**
 * Project controls: name, save state, and the library drawer.
 *
 * The design goal is that the common case needs no dialog. Ctrl-S on a project
 * that has been saved before writes to wherever it already lives — the library,
 * or a file on disk if one is bound. Only "Save to file…" opens a picker.
 */

import { useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { EXAMPLES } from "@cam/script-host";
import type { AppDispatch, RootState } from "../state/store.js";
import { isDirty, libraryToggled, persistenceErrorCleared, projectRenamed } from "../state/slices.js";
import {
  deleteProject, exportProjectFile, importProjectFile, newProject,
  openFromLibrary, openProjectFromFile, refreshLibrary, saveProject, saveProjectToFile,
} from "../state/projectThunks.js";
import { disk } from "../state/projectStore.js";

export function ProjectBar() {
  const dispatch = useDispatch<AppDispatch>();
  const project = useSelector((s: RootState) => s.project);
  const libraryOpen = useSelector((s: RootState) => s.library.open);
  const dirty = isDirty(project);
  const fileInput = useRef<HTMLInputElement>(null);

  // Ctrl/Cmd-S saves. Registered on the window because the editor swallows
  // keystrokes and the user should not have to leave it to save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (e.shiftKey) void dispatch(saveProjectToFile());
        else void dispatch(saveProject());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  return (
    <div className="project-bar">
      <ProjectName />

      <span className={dirty ? "dirty" : "clean"} title={dirty ? "unsaved changes" : "saved"}>
        {dirty ? "●" : "○"}
      </span>

      {project.diskFileName && (
        <span className="dim file" title="bound to a file on disk">
          {project.diskFileName}
        </span>
      )}

      <button onClick={() => void dispatch(saveProject())} disabled={project.saving}>
        {project.saving ? "saving…" : "Save"}
      </button>

      <button
        onClick={() => void dispatch(saveProjectToFile())}
        title={disk.available()
          ? "Write a .dropcut.json you can keep in version control"
          : "This browser cannot write files directly — downloads instead"}
      >
        {disk.available() ? "Save to file…" : "Download"}
      </button>

      {disk.available() && (
        <button onClick={() => void dispatch(openProjectFromFile())}>Open file…</button>
      )}

      <button
        onClick={() => {
          dispatch(libraryToggled(undefined));
          void dispatch(refreshLibrary());
        }}
        className={libraryOpen ? "active" : ""}
      >
        Library
      </button>

      <select
        defaultValue=""
        onChange={(e) => {
          if (e.target.value === "__blank") void dispatch(newProject(undefined));
          else if (e.target.value) void dispatch(newProject({ exampleName: e.target.value }));
          e.target.value = "";
        }}
      >
        <option value="" disabled>New…</option>
        <option value="__blank">blank</option>
        {EXAMPLES.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
      </select>

      <button onClick={() => void dispatch(exportProjectFile())} title="Download a copy">
        Export
      </button>
      <button onClick={() => fileInput.current?.click()} title="Load a .dropcut.json">
        Import
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void dispatch(importProjectFile(file));
          e.target.value = "";
        }}
      />

      {project.lastError && (
        <span className="persist-error" onClick={() => dispatch(persistenceErrorCleared())}>
          {project.lastError} ✕
        </span>
      )}

      {libraryOpen && <LibraryDrawer />}
    </div>
  );
}

function ProjectName() {
  const dispatch = useDispatch<AppDispatch>();
  const name = useSelector((s: RootState) => s.project.name);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  useEffect(() => { setDraft(name); }, [name]);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) dispatch(projectRenamed(trimmed));
    else setDraft(name);
  };

  if (!editing) {
    return (
      <button className="project-name" onClick={() => setEditing(true)} title="Rename">
        {name}
      </button>
    );
  }

  return (
    <input
      className="project-name-input"
      value={draft}
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setDraft(name); setEditing(false); }
      }}
    />
  );
}

function LibraryDrawer() {
  const dispatch = useDispatch<AppDispatch>();
  const { entries, loading } = useSelector((s: RootState) => s.library);
  const currentId = useSelector((s: RootState) => s.project.documentId);

  return (
    <div className="library">
      <div className="library-head">
        <span>SAVED PROJECTS</span>
        <button onClick={() => dispatch(libraryToggled(false))}>✕</button>
      </div>

      {loading && <div className="library-empty">loading…</div>}

      {!loading && entries.length === 0 && (
        <div className="library-empty">
          Nothing saved yet. <b>Save</b> keeps a project in this browser;
          <b> Save to file…</b> writes a <code>.dropcut.json</code> you can commit.
        </div>
      )}

      {entries.map((e) => (
        <div key={e.id} className={e.id === currentId ? "library-row current" : "library-row"}>
          <button className="library-open" onClick={() => void dispatch(openFromLibrary(e.id))}>
            {e.name}
          </button>
          <span className="dim">{relative(e.modifiedAt)}</span>
          <button
            className="library-delete"
            title="Delete"
            onClick={() => void dispatch(deleteProject(e.id))}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/** Relative timestamps, because an absolute one tells the reader nothing here. */
function relative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
