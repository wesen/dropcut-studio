/**
 * Redux slices.
 *
 * Six slices, matching the design doc. `project` is the only one that is
 * persisted and undoable — undoing a *compile* makes no sense; recompiling from
 * an undone script does.
 *
 * Everything in here is small and serialisable by construction. The rule that
 * enforces it is `serializableCheck`, which stays ON in development. If a typed
 * array ever needs to reach a component, it goes in the artifact cache and the
 * store holds its id.
 *
 * Design doc: Part V.2.
 */

import { createSlice } from "@reduxjs/toolkit";
import type { PayloadAction } from "@reduxjs/toolkit";
import type { Diagnostic } from "@cam/ir";
import type { ArtifactId } from "./artifactCache.js";
import type { ProjectDocument, ProjectSettings } from "./projectFile.js";
import { settingsEqual, settingsOf } from "./projectFile.js";
import type { ProjectSummary } from "./projectStore.js";

/* ------------------------------- project ------------------------------- */

export interface ProjectState {
  readonly name: string;
  readonly script: string;
  readonly machineId: string;
  readonly simulate: boolean;
  readonly simulationResolution: number;

  /* --- persistence --- */

  /** Id of the document in the library, or null if never saved. */
  readonly documentId: string | null;
  /**
   * Snapshot of the settings as last saved.
   *
   * Dirty tracking compares against this rather than keeping a boolean, so
   * editing a script and undoing the edit correctly reports clean again.
   */
  readonly savedSettings: ProjectSettings | null;
  /** Name of the on-disk file, when one is bound via File System Access. */
  readonly diskFileName: string | null;
  readonly saving: boolean;
  readonly lastError: string | null;
}

const projectSlice = createSlice({
  name: "project",
  initialState: {
    name: "untitled",
    script: "",
    machineId: "linuxcnc",
    simulate: true,
    simulationResolution: 140,
    documentId: null,
    savedSettings: null,
    diskFileName: null,
    saving: false,
    lastError: null,
  } as ProjectState,
  reducers: {
    scriptChanged: (s, a: PayloadAction<string>) => { s.script = a.payload; },
    machineChanged: (s, a: PayloadAction<string>) => { s.machineId = a.payload; },
    simulateToggled: (s, a: PayloadAction<boolean>) => { s.simulate = a.payload; },
    projectRenamed: (s, a: PayloadAction<string>) => { s.name = a.payload; },

    /** Replace the whole editing buffer from a loaded document. */
    documentOpened: (s, a: PayloadAction<{ document: ProjectDocument; diskFileName?: string }>) => {
      const d = a.payload.document;
      s.name = d.name;
      s.script = d.script;
      s.machineId = d.machineId;
      s.simulate = d.simulate;
      s.simulationResolution = d.simulationResolution;
      s.documentId = d.id;
      s.savedSettings = settingsOf(d);
      s.diskFileName = a.payload.diskFileName ?? null;
      s.lastError = null;
    },

    /** Mark the current buffer as persisted. */
    documentSaved: (s, a: PayloadAction<{ document: ProjectDocument; diskFileName?: string }>) => {
      s.documentId = a.payload.document.id;
      s.name = a.payload.document.name;
      s.savedSettings = settingsOf(a.payload.document);
      if (a.payload.diskFileName !== undefined) s.diskFileName = a.payload.diskFileName;
      s.saving = false;
      s.lastError = null;
    },

    /** Start from nothing. Detaches from both the library entry and any file. */
    projectReset: (s, a: PayloadAction<{ name: string; script: string }>) => {
      s.name = a.payload.name;
      s.script = a.payload.script;
      s.documentId = null;
      s.savedSettings = null;
      s.diskFileName = null;
      s.lastError = null;
    },

    savingStarted: (s) => { s.saving = true; s.lastError = null; },
    persistenceFailed: (s, a: PayloadAction<string>) => {
      s.saving = false;
      s.lastError = a.payload;
    },
    persistenceErrorCleared: (s) => { s.lastError = null; },
  },
});

/* ------------------------------- library -------------------------------- */

export interface LibraryState {
  readonly entries: readonly ProjectSummary[];
  readonly loading: boolean;
  readonly open: boolean;
}

const librarySlice = createSlice({
  name: "library",
  initialState: { entries: [], loading: false, open: false } as LibraryState,
  reducers: {
    libraryLoading: (s) => { s.loading = true; },
    libraryLoaded: (s, a: PayloadAction<readonly ProjectSummary[]>) => {
      s.entries = [...a.payload];
      s.loading = false;
    },
    libraryToggled: (s, a: PayloadAction<boolean | undefined>) => {
      s.open = a.payload ?? !s.open;
    },
  },
});

/** True when the editing buffer differs from what was last persisted. */
export function isDirty(p: ProjectState): boolean {
  if (p.savedSettings === null) return p.script.trim().length > 0;
  return !settingsEqual(p.savedSettings, {
    name: p.name,
    script: p.script,
    machineId: p.machineId,
    simulate: p.simulate,
    simulationResolution: p.simulationResolution,
  });
}

/* ------------------------------- compile ------------------------------- */

export interface CompileStats {
  readonly lines: number;
  readonly motions: number;
  readonly cutLengthMm: number;
  readonly rapidLengthMm: number;
  readonly seconds: number;
  readonly timeModel: string;
}

export interface OperationSummary {
  readonly operationId: string;
  readonly description: string;
  readonly paths: number;
}

export interface CertificateRow {
  readonly label: string;
  readonly status: "exact" | "resolution" | "skipped" | "unknown";
  readonly detail: string;
}

export interface CompileState {
  readonly status: "idle" | "running" | "ok" | "failed";
  readonly artifactId: ArtifactId | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly stats: CompileStats | null;
  readonly summaries: readonly OperationSummary[];
  readonly certificate: readonly CertificateRow[];
  readonly errorBudgetMm: number;
  readonly progress: number;
  readonly failedStage: string | null;
  readonly elapsedMs: number;
}

const initialCompile: CompileState = {
  status: "idle",
  artifactId: null,
  diagnostics: [],
  stats: null,
  summaries: [],
  certificate: [],
  errorBudgetMm: 0,
  progress: 0,
  failedStage: null,
  elapsedMs: 0,
};

export interface CompileSucceeded {
  readonly artifactId: ArtifactId;
  readonly diagnostics: readonly Diagnostic[];
  readonly stats: CompileStats;
  readonly summaries: readonly OperationSummary[];
  readonly certificate: readonly CertificateRow[];
  readonly errorBudgetMm: number;
  readonly elapsedMs: number;
}

const compileSlice = createSlice({
  name: "compile",
  initialState: initialCompile,
  reducers: {
    compileStarted: (s) => {
      s.status = "running";
      s.progress = 0;
      s.failedStage = null;
    },
    compileProgress: (s, a: PayloadAction<number>) => { s.progress = a.payload; },
    compileSucceeded: (s, a: PayloadAction<CompileSucceeded>) => {
      s.status = "ok";
      s.artifactId = a.payload.artifactId;
      s.diagnostics = [...a.payload.diagnostics];
      s.stats = a.payload.stats;
      s.summaries = [...a.payload.summaries];
      s.certificate = [...a.payload.certificate];
      s.errorBudgetMm = a.payload.errorBudgetMm;
      s.elapsedMs = a.payload.elapsedMs;
      s.progress = 1;
      s.failedStage = null;
    },
    compileFailed: (s, a: PayloadAction<{ stage: string; diagnostics: readonly Diagnostic[] }>) => {
      s.status = "failed";
      // The artifact id is cleared so the viewport shows nothing rather than
      // stale geometry from a previous, unrelated compile.
      s.artifactId = null;
      s.diagnostics = [...a.payload.diagnostics];
      s.stats = null;
      s.summaries = [];
      s.certificate = [];
      s.failedStage = a.payload.stage;
      s.progress = 1;
    },
  },
});

/* ------------------------------ playback ------------------------------- */

export interface PlaybackState {
  readonly playing: boolean;
  readonly speed: number;
  /** Throttled copy of the viewport clock, for components that need it. */
  readonly time: number;
  readonly duration: number;
  readonly activeGcodeLine: number | null;
}

const playbackSlice = createSlice({
  name: "playback",
  initialState: {
    playing: false, speed: 8, time: 0, duration: 0, activeGcodeLine: null,
  } as PlaybackState,
  reducers: {
    // Dispatched by the viewport's throttled tick, NOT per animation frame.
    tick: (s, a: PayloadAction<{ time: number; duration: number; playing: boolean;
      gcodeLine: number }>) => {
      s.time = a.payload.time;
      s.duration = a.payload.duration;
      s.playing = a.payload.playing;
      s.activeGcodeLine = a.payload.gcodeLine >= 0 ? a.payload.gcodeLine : null;
    },
    speedChanged: (s, a: PayloadAction<number>) => { s.speed = a.payload; },
    playbackReset: (s) => { s.time = 0; s.playing = false; s.activeGcodeLine = null; },
  },
});

/* ------------------------------ viewport ------------------------------- */

export type LayerName = "part" | "stock" | "toolpath" | "rapids" | "trail" | "tool";

export interface ViewportState {
  readonly show: Record<LayerName, boolean>;
  readonly colorMode: "purpose" | "depth";
  readonly view: "iso" | "top" | "front" | "right";
}

const viewportSlice = createSlice({
  name: "viewport",
  initialState: {
    show: { part: true, stock: true, toolpath: true, rapids: true, trail: true, tool: true },
    colorMode: "purpose",
    view: "iso",
  } as ViewportState,
  reducers: {
    layerToggled: (s, a: PayloadAction<LayerName>) => {
      s.show[a.payload] = !s.show[a.payload];
    },
    colorModeChanged: (s, a: PayloadAction<"purpose" | "depth">) => { s.colorMode = a.payload; },
    viewChanged: (s, a: PayloadAction<ViewportState["view"]>) => { s.view = a.payload; },
  },
});

/* --------------------------------- ui ---------------------------------- */

export type BottomTab = "gcode" | "diagnostics" | "certificate" | "operations";

export interface UiState {
  readonly bottomTab: BottomTab;
  readonly editorWidthPct: number;
  readonly bottomHeightPct: number;
  readonly selectedGcodeLine: number | null;
}

const uiSlice = createSlice({
  name: "ui",
  initialState: {
    bottomTab: "gcode", editorWidthPct: 42, bottomHeightPct: 40, selectedGcodeLine: null,
  } as UiState,
  reducers: {
    bottomTabChanged: (s, a: PayloadAction<BottomTab>) => { s.bottomTab = a.payload; },
    gcodeLineSelected: (s, a: PayloadAction<number | null>) => { s.selectedGcodeLine = a.payload; },
  },
});

export const {
  scriptChanged, machineChanged, simulateToggled, projectRenamed,
  documentOpened, documentSaved, projectReset,
  savingStarted, persistenceFailed, persistenceErrorCleared,
} = projectSlice.actions;
export const { libraryLoading, libraryLoaded, libraryToggled } = librarySlice.actions;
export const {
  compileStarted, compileProgress, compileSucceeded, compileFailed,
} = compileSlice.actions;
export const { tick, speedChanged, playbackReset } = playbackSlice.actions;
export const { layerToggled, colorModeChanged, viewChanged } = viewportSlice.actions;
export const { bottomTabChanged, gcodeLineSelected } = uiSlice.actions;

export const reducers = {
  project: projectSlice.reducer,
  library: librarySlice.reducer,
  compile: compileSlice.reducer,
  playback: playbackSlice.reducer,
  viewport: viewportSlice.reducer,
  ui: uiSlice.reducer,
};
