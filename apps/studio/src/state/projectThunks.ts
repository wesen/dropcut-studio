/**
 * Project lifecycle: new, open, save, save-as, delete, import, export.
 *
 * Every operation reports failure into state rather than throwing. Storage
 * fails for mundane reasons — a denied permission prompt, a private browsing
 * window that blocks IndexedDB, a quota — and none of those should surface as
 * an unhandled rejection in the console while the UI silently does nothing.
 *
 * A cancelled picker is NOT a failure. The user closing a file dialog is a
 * normal outcome and must leave state untouched, which is why `DiskResult`
 * distinguishes cancellation from error.
 */

import { createAsyncThunk } from "@reduxjs/toolkit";
import { EXAMPLES } from "@cam/script-host";
import type { ProjectDocument, ProjectSettings } from "./projectFile.js";
import { createDocument, updateDocument } from "./projectFile.js";
import { disk, library, session, transfer } from "./projectStore.js";
import {
  documentOpened, documentSaved, libraryLoaded, libraryLoading,
  persistenceFailed, projectReset, savingStarted,
} from "./slices.js";
import type { ProjectState } from "./slices.js";
import type { ThunkApi } from "./compileThunk.js";
import { compile } from "./compileThunk.js";

const settingsFrom = (p: ProjectState): ProjectSettings => ({
  name: p.name,
  script: p.script,
  machineId: p.machineId,
  simulate: p.simulate,
  simulationResolution: p.simulationResolution,
});

/**
 * The live File System Access handle, if the project is bound to a file.
 *
 * Handles are not serialisable in the sense Redux wants — they are structured-
 * cloneable but they are host objects with methods, and putting one in the store
 * would trip `serializableCheck` for good reason. The store keeps the file NAME
 * for display; the handle lives here.
 */
let diskHandle: Parameters<typeof disk.write>[0] | null = null;

export const clearDiskHandle = (): void => { diskHandle = null; };
export const hasDiskHandle = (): boolean => diskHandle !== null;

/* --------------------------------- library -------------------------------- */

export const refreshLibrary = createAsyncThunk<void, void, ThunkApi>(
  "project/refreshLibrary",
  async (_, { dispatch }) => {
    if (!library.available()) return;
    dispatch(libraryLoading());
    try {
      dispatch(libraryLoaded(await library.list()));
    } catch (e) {
      dispatch(libraryLoaded([]));
      dispatch(persistenceFailed(message(e)));
    }
  },
);

/* ---------------------------------- new ----------------------------------- */

export const newProject = createAsyncThunk<void, { exampleName?: string } | undefined, ThunkApi>(
  "project/new",
  async (arg, { dispatch }) => {
    const example = arg?.exampleName
      ? EXAMPLES.find((e) => e.name === arg.exampleName)
      : undefined;

    clearDiskHandle();
    session.rememberProject(null);
    dispatch(projectReset({
      name: example?.name ?? "untitled",
      script: example?.source ?? "",
    }));
    await dispatch(compile());
  },
);

/* --------------------------------- saving --------------------------------- */

/**
 * Save to wherever the project already lives.
 *
 * A project bound to a file writes to that file. A project that only exists in
 * the library updates its library entry. A project that has never been saved is
 * created in the library — saving should never require a dialog for the common
 * case of "I have been editing and want to keep this".
 */
export const saveProject = createAsyncThunk<boolean, void, ThunkApi>(
  "project/save",
  async (_, { getState, dispatch }) => {
    const p = getState().project;
    dispatch(savingStarted());

    const document = p.documentId === null
      ? createDocument(settingsFrom(p))
      : updateDocument(
          { ...(await library.load(p.documentId) ?? createDocument(settingsFrom(p))),
            id: p.documentId },
          settingsFrom(p),
        );

    // Write to disk first when bound to a file: if that fails, the library copy
    // should not claim to be the saved state.
    if (diskHandle !== null) {
      const written = await disk.write(diskHandle, document);
      if (!written.ok) {
        if (!("cancelled" in written)) dispatch(persistenceFailed(written.error));
        else dispatch(persistenceFailed("save cancelled"));
        return false;
      }
    }

    try {
      if (library.available()) await library.save(document);
      session.rememberProject(document.id);
    } catch (e) {
      dispatch(persistenceFailed(message(e)));
      return false;
    }

    dispatch(documentSaved({ document }));
    void dispatch(refreshLibrary());
    return true;
  },
);

/** Prompt for a file location and bind the project to it. */
export const saveProjectToFile = createAsyncThunk<boolean, void, ThunkApi>(
  "project/saveToFile",
  async (_, { getState, dispatch }) => {
    const p = getState().project;
    if (!disk.available()) {
      transfer.download(documentFor(p));
      return true;
    }

    dispatch(savingStarted());
    const document = documentFor(p);
    const result = await disk.saveAs(document);

    if (!result.ok) {
      dispatch(persistenceFailed("cancelled" in result ? "save cancelled" : result.error));
      return false;
    }

    diskHandle = result.value.handle;
    try {
      if (library.available()) await library.save(document);
      session.rememberProject(document.id);
    } catch {
      // A successful disk write is the important part; a library failure here
      // is worth ignoring rather than telling the user the save failed.
    }
    dispatch(documentSaved({ document, diskFileName: result.value.name }));
    void dispatch(refreshLibrary());
    return true;
  },
);

function documentFor(p: ProjectState): ProjectDocument {
  const settings = settingsFrom(p);
  return p.documentId === null
    ? createDocument(settings)
    : updateDocument(
        { ...createDocument(settings), id: p.documentId, createdAt: new Date().toISOString() },
        settings,
      );
}

/* --------------------------------- opening -------------------------------- */

export const openFromLibrary = createAsyncThunk<boolean, string, ThunkApi>(
  "project/openFromLibrary",
  async (id, { dispatch }) => {
    try {
      const document = await library.load(id);
      if (!document) {
        dispatch(persistenceFailed(`project ${id} is no longer in the library`));
        return false;
      }
      clearDiskHandle();
      session.rememberProject(document.id);
      dispatch(documentOpened({ document }));
      await dispatch(compile());
      return true;
    } catch (e) {
      dispatch(persistenceFailed(message(e)));
      return false;
    }
  },
);

export const openProjectFromFile = createAsyncThunk<boolean, void, ThunkApi>(
  "project/openFromFile",
  async (_, { dispatch }) => {
    if (!disk.available()) {
      dispatch(persistenceFailed("this browser cannot open files directly — use Import"));
      return false;
    }
    const result = await disk.open();
    if (!result.ok) {
      if (!("cancelled" in result)) dispatch(persistenceFailed(result.error));
      return false;
    }
    diskHandle = result.value.file.handle;
    session.rememberProject(result.value.document.id);
    dispatch(documentOpened({
      document: result.value.document,
      diskFileName: result.value.file.name,
    }));
    await dispatch(compile());
    return true;
  },
);

/** Import via a plain file input. Works everywhere; does not bind to the file. */
export const importProjectFile = createAsyncThunk<boolean, File, ThunkApi>(
  "project/import",
  async (file, { dispatch }) => {
    const result = await transfer.fromFile(file);
    if (!result.ok) {
      dispatch(persistenceFailed(result.error));
      return false;
    }
    clearDiskHandle();
    dispatch(documentOpened({ document: result.value }));
    await dispatch(compile());
    return true;
  },
);

export const exportProjectFile = createAsyncThunk<void, void, ThunkApi>(
  "project/export",
  async (_, { getState }) => {
    transfer.download(documentFor(getState().project));
  },
);

/* -------------------------------- deleting -------------------------------- */

export const deleteProject = createAsyncThunk<void, string, ThunkApi>(
  "project/delete",
  async (id, { getState, dispatch }) => {
    try {
      await library.remove(id);
      if (getState().project.documentId === id) {
        clearDiskHandle();
        session.rememberProject(null);
        dispatch(projectReset({ name: "untitled", script: getState().project.script }));
      }
      void dispatch(refreshLibrary());
    } catch (e) {
      dispatch(persistenceFailed(message(e)));
    }
  },
);

/* -------------------------------- startup --------------------------------- */

/**
 * Restore the last session, or fall back to an example.
 *
 * Called once at mount. A missing or unreadable last project is not an error
 * worth reporting — it just means the user gets the example, which is the same
 * thing a first-time visitor gets.
 */
export const restoreSession = createAsyncThunk<void, void, ThunkApi>(
  "project/restore",
  async (_, { dispatch }) => {
    void dispatch(refreshLibrary());

    const lastId = session.lastProject();
    if (lastId && library.available()) {
      try {
        const document = await library.load(lastId);
        if (document) {
          dispatch(documentOpened({ document }));
          await dispatch(compile());
          return;
        }
      } catch {
        // Fall through to the example.
      }
    }
    await dispatch(compile());
  },
);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
