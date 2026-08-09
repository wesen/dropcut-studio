/**
 * Where projects live.
 *
 * Three storage routes, chosen deliberately:
 *
 *  - IndexedDB is the default library. It is async, has no practical size
 *    limit, and stores structured clones rather than strings — which matters
 *    the moment a project needs to carry an STL mesh. `localStorage` would work
 *    for today's few-kilobyte text documents and would have to be abandoned
 *    within one feature.
 *
 *  - The File System Access API writes real files the user can see, diff and
 *    commit. This is the interesting one for CAM: a machining program belongs in
 *    version control next to the part it cuts. Chromium-only for the directory
 *    picker; the code degrades rather than breaking.
 *
 *  - Download and file-input upload work everywhere and need no permission.
 *
 * NOT USED: the Origin Private File System. It is often mistaken for a way to
 * mount a local directory, but OPFS is origin-private and invisible to the user
 * — a sandboxed scratch filesystem with a file-shaped API. It would give us
 * nothing IndexedDB does not already give us here.
 */

import type { ProjectDocument } from "./projectFile.js";
import { parseDocument, serialise, suggestedFilename } from "./projectFile.js";

/* ------------------------------- IndexedDB ------------------------------- */

const DB_NAME = "dropcut-studio";
const DB_VERSION = 1;
const STORE = "projects";

/**
 * Minimal promise wrapper over IndexedDB.
 *
 * A library would be about 600 bytes, but the API surface we need is four
 * operations and the wrapper is shorter than the dependency's README.
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        // Sorting the library by recency is the only query we make.
        store.createIndex("modifiedAt", "modifiedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("could not open IndexedDB"));
  });
}

function transact<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = fn(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    tx.oncomplete = () => db.close();
  }));
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly modifiedAt: string;
  readonly createdAt: string;
}

export const library = {
  async list(): Promise<ProjectSummary[]> {
    const all = await transact<ProjectDocument[]>("readonly", (s) => s.getAll());
    return all
      .map((d) => ({ id: d.id, name: d.name, modifiedAt: d.modifiedAt, createdAt: d.createdAt }))
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  },

  async load(id: string): Promise<ProjectDocument | null> {
    const doc = await transact<ProjectDocument | undefined>("readonly", (s) => s.get(id));
    return doc ?? null;
  },

  async save(doc: ProjectDocument): Promise<void> {
    await transact("readwrite", (s) => s.put(doc));
  },

  async remove(id: string): Promise<void> {
    await transact("readwrite", (s) => s.delete(id));
  },

  available(): boolean {
    return typeof indexedDB !== "undefined";
  },
};

/* -------------------------- File System Access --------------------------- */

/**
 * Feature detection.
 *
 * `showSaveFilePicker` exists in Chromium and Edge. Firefox and Safari have
 * neither it nor `showDirectoryPicker`, so those users get download/upload,
 * which is not a downgrade in capability so much as in convenience.
 */
export function fileSystemAccessAvailable(): boolean {
  return typeof globalThis !== "undefined"
    && typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";
}

type PermissionMode = "read" | "readwrite";

interface FileHandleLike {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
  queryPermission?(opts: { mode: PermissionMode }): Promise<PermissionState>;
  requestPermission?(opts: { mode: PermissionMode }): Promise<PermissionState>;
}

/**
 * Ensure we still hold permission on a handle.
 *
 * Handles survive a reload (they are structured-cloneable, so they can live in
 * IndexedDB), but the PERMISSION does not. Re-requesting must happen inside a
 * user gesture, which is why every caller of this is a click handler.
 */
async function ensurePermission(handle: FileHandleLike, mode: PermissionMode): Promise<boolean> {
  if (!handle.queryPermission || !handle.requestPermission) return true;
  if (await handle.queryPermission({ mode }) === "granted") return true;
  return await handle.requestPermission({ mode }) === "granted";
}

export interface DiskFile {
  readonly handle: FileHandleLike;
  readonly name: string;
}

export type DiskResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }
  | { readonly ok: false; readonly cancelled: true; readonly error: string };

const cancelled = (): DiskResult<never> =>
  ({ ok: false, cancelled: true, error: "cancelled" });

const isAbort = (e: unknown): boolean =>
  e instanceof DOMException ? e.name === "AbortError" : false;

export const disk = {
  available: fileSystemAccessAvailable,

  /** Prompt for a location and write the document there. */
  async saveAs(doc: ProjectDocument): Promise<DiskResult<DiskFile>> {
    if (!fileSystemAccessAvailable()) {
      return { ok: false, error: "this browser cannot write files directly" };
    }
    try {
      const picker = (globalThis as unknown as {
        showSaveFilePicker(o: unknown): Promise<FileHandleLike>;
      }).showSaveFilePicker;

      const handle = await picker({
        suggestedName: suggestedFilename(doc.name),
        types: [{
          description: "DROPCUT project",
          accept: { "application/json": [".json"] },
        }],
      });
      const written = await disk.write(handle, doc);
      return written.ok ? { ok: true, value: { handle, name: handle.name } } : written;
    } catch (e) {
      if (isAbort(e)) return cancelled();
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  /** Write to a handle we already hold. */
  async write(handle: FileHandleLike, doc: ProjectDocument): Promise<DiskResult<void>> {
    try {
      if (!await ensurePermission(handle, "readwrite")) {
        return { ok: false, error: "write permission was not granted" };
      }
      const writable = await handle.createWritable();
      await writable.write(serialise(doc));
      await writable.close();
      return { ok: true, value: undefined };
    } catch (e) {
      if (isAbort(e)) return cancelled();
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  /** Prompt for a file and read it. */
  async open(): Promise<DiskResult<{ document: ProjectDocument; file: DiskFile }>> {
    if (!fileSystemAccessAvailable()) {
      return { ok: false, error: "this browser cannot open files directly" };
    }
    try {
      const picker = (globalThis as unknown as {
        showOpenFilePicker(o: unknown): Promise<FileHandleLike[]>;
      }).showOpenFilePicker;

      const [handle] = await picker({
        multiple: false,
        types: [{
          description: "DROPCUT project",
          accept: { "application/json": [".json"] },
        }],
      });
      if (!handle) return cancelled();

      if (!await ensurePermission(handle, "read")) {
        return { ok: false, error: "read permission was not granted" };
      }
      const text = await (await handle.getFile()).text();
      const parsed = parseDocument(text);
      if (!parsed.ok) return { ok: false, error: parsed.error };

      return {
        ok: true,
        value: { document: parsed.document, file: { handle, name: handle.name } },
      };
    } catch (e) {
      if (isAbort(e)) return cancelled();
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};

/* -------------------------- universal fallback --------------------------- */

/**
 * Download and upload. Works in every browser, needs no permission, and is the
 * only route that also serves "give this program to someone else".
 */
export const transfer = {
  download(doc: ProjectDocument): void {
    const blob = new Blob([serialise(doc)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedFilename(doc.name);
    a.click();
    URL.revokeObjectURL(url);
  },

  async fromFile(file: File): Promise<DiskResult<ProjectDocument>> {
    try {
      const parsed = parseDocument(await file.text());
      return parsed.ok
        ? { ok: true, value: parsed.document }
        : { ok: false, error: `${file.name}: ${parsed.error}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};

/* ------------------------------ last session ----------------------------- */

/**
 * Which project was open last, so a reload returns you to it.
 *
 * `localStorage` IS the right tool here, and the contrast is the point: this is
 * a single short string, read synchronously during startup before anything can
 * await. That is exactly what localStorage is good at, and exactly what project
 * documents are not.
 */
const LAST_PROJECT_KEY = "dropcut.lastProjectId";

export const session = {
  rememberProject(id: string | null): void {
    try {
      if (id === null) localStorage.removeItem(LAST_PROJECT_KEY);
      else localStorage.setItem(LAST_PROJECT_KEY, id);
    } catch {
      // Private browsing modes can throw on write. Losing "reopen last project"
      // is not worth failing a save over.
    }
  },

  lastProject(): string | null {
    try {
      return localStorage.getItem(LAST_PROJECT_KEY);
    } catch {
      return null;
    }
  },
};
