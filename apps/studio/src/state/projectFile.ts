/**
 * The project document: what gets saved, and what a saved file means.
 *
 * A saved project outlives the code that wrote it. That single fact drives every
 * decision here: the format carries an explicit version, migration is a function
 * that exists from the first version rather than being retrofitted at the moment
 * it is first needed, and loading validates rather than trusting.
 *
 * The document is deliberately NOT the Redux `ProjectState`. Those two want to
 * diverge — the store holds transient things like the current selection, and the
 * file wants identity and timestamps the store has no use for. Keeping them
 * separate means a store refactor does not silently change the file format.
 */

/**
 * Bumped when the shape changes incompatibly.
 *
 * Version 1: script, machine, simulation settings. No assets — meshes are
 * built-in presets referenced by name, so nothing binary needs storing yet.
 */
export const PROJECT_FORMAT_VERSION = 1;

export interface ProjectDocument {
  readonly formatVersion: number;
  readonly id: string;
  readonly name: string;
  /** ISO 8601. */
  readonly createdAt: string;
  readonly modifiedAt: string;

  readonly script: string;
  readonly machineId: string;
  readonly simulate: boolean;
  readonly simulationResolution: number;
}

/** The fields a document shares with the Redux project slice. */
export interface ProjectSettings {
  readonly name: string;
  readonly script: string;
  readonly machineId: string;
  readonly simulate: boolean;
  readonly simulationResolution: number;
}

export const FILE_EXTENSION = ".dropcut.json";

/**
 * Identifiers are generated rather than derived from the name, so renaming a
 * project does not orphan it and two projects may share a name.
 */
export function newProjectId(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return c.randomUUID();
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createDocument(settings: ProjectSettings, now = new Date()): ProjectDocument {
  const stamp = now.toISOString();
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    id: newProjectId(),
    name: settings.name || "untitled",
    createdAt: stamp,
    modifiedAt: stamp,
    script: settings.script,
    machineId: settings.machineId,
    simulate: settings.simulate,
    simulationResolution: settings.simulationResolution,
  };
}

export function updateDocument(
  doc: ProjectDocument,
  settings: ProjectSettings,
  now = new Date(),
): ProjectDocument {
  return {
    ...doc,
    ...settings,
    name: settings.name || doc.name,
    modifiedAt: now.toISOString(),
  };
}

/** Settings comparison, for the dirty flag. Timestamps and id are irrelevant. */
export function settingsEqual(a: ProjectSettings, b: ProjectSettings): boolean {
  return a.name === b.name
    && a.script === b.script
    && a.machineId === b.machineId
    && a.simulate === b.simulate
    && a.simulationResolution === b.simulationResolution;
}

export const settingsOf = (doc: ProjectDocument): ProjectSettings => ({
  name: doc.name,
  script: doc.script,
  machineId: doc.machineId,
  simulate: doc.simulate,
  simulationResolution: doc.simulationResolution,
});

/* ------------------------------ serialising ------------------------------ */

export function serialise(doc: ProjectDocument): string {
  // Two-space indent so a saved file diffs cleanly in git, which is a large part
  // of why anyone would want it on disk rather than in a browser database.
  return JSON.stringify(doc, null, 2) + "\n";
}

export type ParseResult =
  | { readonly ok: true; readonly document: ProjectDocument }
  | { readonly ok: false; readonly error: string };

/**
 * Parse and migrate a saved document.
 *
 * Validates rather than trusting: a file on disk may have been hand-edited,
 * truncated, or written by a future version. Every failure produces a message
 * the UI can show, never an exception.
 */
export function parseDocument(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "expected a JSON object" };
  }

  const o = raw as Record<string, unknown>;
  const version = typeof o.formatVersion === "number" ? o.formatVersion : 0;

  if (version > PROJECT_FORMAT_VERSION) {
    return {
      ok: false,
      error: `file format version ${version} is newer than this build understands ` +
        `(${PROJECT_FORMAT_VERSION}) — update the application`,
    };
  }

  // Reject WRONG-TYPED fields before migrating. Migration fills in fields that
  // are ABSENT, which is the right response to an older format; applying the
  // same defaults to a field that is present but malformed would silently
  // discard the user's data — opening the file would show an empty script.
  const wrongType = checkFieldTypes(o);
  if (wrongType) return { ok: false, error: wrongType };

  return migrate(o, version);
}

/** Field types that must be right if present at all. */
function checkFieldTypes(o: Record<string, unknown>): string | null {
  const expected: [string, string][] = [
    ["id", "string"], ["name", "string"], ["createdAt", "string"], ["modifiedAt", "string"],
    ["script", "string"], ["machineId", "string"],
    ["simulate", "boolean"], ["simulationResolution", "number"],
  ];
  for (const [key, type] of expected) {
    if (o[key] !== undefined && typeof o[key] !== type) {
      return `field '${key}' should be a ${type}, got ${typeof o[key]}`;
    }
  }
  return null;
}

/**
 * Bring an older document up to the current version.
 *
 * With only one version this is close to a no-op, and that is the point: the
 * seam exists before it is needed, so version 2 is a case in a switch rather
 * than an archaeology exercise.
 */
function migrate(o: Record<string, unknown>, from: number): ParseResult {
  const now = new Date().toISOString();

  const document: ProjectDocument = {
    formatVersion: PROJECT_FORMAT_VERSION,
    id: typeof o.id === "string" ? o.id : newProjectId(),
    name: typeof o.name === "string" && o.name ? o.name : "untitled",
    createdAt: typeof o.createdAt === "string" ? o.createdAt : now,
    modifiedAt: typeof o.modifiedAt === "string" ? o.modifiedAt : now,
    script: typeof o.script === "string" ? o.script : "",
    machineId: typeof o.machineId === "string" ? o.machineId : "linuxcnc",
    simulate: typeof o.simulate === "boolean" ? o.simulate : true,
    simulationResolution:
      typeof o.simulationResolution === "number" ? o.simulationResolution : 140,
  };

  if (from === 0) {
    // A version-less file predates the format entirely. Accept it if it at
    // least carries a script; the defaults above fill in the rest.
    if (typeof o.script !== "string") {
      return { ok: false, error: "file has no format version and no 'script' field" };
    }
  }

  return { ok: true, document };
}

/** Filesystem-safe filename for a project. */
export function suggestedFilename(name: string): string {
  const base = name
    .trim()
    .replace(/[^\w\- ]+/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase() || "untitled";
  return base + FILE_EXTENSION;
}
