/**
 * A module-level handle to the live viewport.
 *
 * The transport bar has to call `play()`, `seek()` and friends directly: routing
 * them through Redux would put the 60 Hz clock in the store, which is exactly
 * what tier 3 exists to prevent. A singleton is honest about there being one
 * viewport, and keeps the imperative escape hatch in one visible place rather
 * than threading refs through the component tree.
 */

import type { ViewportApi } from "@cam/viewer-three";

let current: ViewportApi | null = null;
const listeners = new Set<(api: ViewportApi | null) => void>();

export function setViewport(api: ViewportApi | null): void {
  current = api;
  for (const l of listeners) l(api);
}

export const getViewport = (): ViewportApi | null => current;

export function onViewportChange(cb: (api: ViewportApi | null) => void): () => void {
  listeners.add(cb);
  cb(current);
  return () => listeners.delete(cb);
}
