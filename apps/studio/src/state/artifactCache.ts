/**
 * Tier 2: the artifact cache.
 *
 * Redux holds the DOCUMENT and small derived summaries. It must not hold a
 * 24 MB `Float32Array`, a Three.js scene graph, or a compiled program's object
 * graph — those break serialisability checks, make DevTools unusable, and would
 * force us to disable exactly the middleware that keeps the store honest.
 *
 * So: big artifacts live here, keyed by an id, and the store holds only the id.
 * When the id changes, components re-read; when it does not, nothing happens
 * even if unrelated state changed.
 *
 * Design doc: Part V.1, V.3, ADR-004.
 */

import type { RenderBuffers, ValidatedProgram } from "@cam/ir";
import type { Mesh } from "@cam/geometry";
import type { GCodeDocument } from "@cam/compiler";

export interface StockBox {
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly topZ: number;
}

export interface CompileArtifact {
  readonly program: ValidatedProgram;
  readonly document: GCodeDocument;
  readonly buffers: RenderBuffers;
  readonly mesh: Mesh | null;
  readonly stock: StockBox;
}

export type ArtifactId = string;

const store = new Map<ArtifactId, CompileArtifact>();
let sequence = 0;

/**
 * Store an artifact and return its id.
 *
 * A monotonic counter rather than a content hash: hashing megabytes of float
 * data on every compile costs more than it saves, and identity here only needs
 * to answer "is this the same artifact I already rendered?".
 */
export function putArtifact(artifact: CompileArtifact): ArtifactId {
  const id = `artifact:${++sequence}`;
  store.set(id, artifact);
  return id;
}

export function getArtifact(id: ArtifactId | null): CompileArtifact | undefined {
  return id === null ? undefined : store.get(id);
}

/**
 * Drop everything except the ids still referenced by the store.
 *
 * Without this, every keystroke-triggered recompile leaks a toolpath buffer.
 * Called from middleware after each compile.
 */
export function collectGarbage(live: ReadonlySet<ArtifactId>): number {
  let removed = 0;
  for (const id of store.keys()) {
    if (!live.has(id)) {
      store.delete(id);
      removed++;
    }
  }
  return removed;
}

/** Diagnostics for the UI and tests. */
export const artifactCount = (): number => store.size;
export const clearArtifacts = (): void => { store.clear(); };
