/**
 * Store wiring and the auto-compile middleware.
 *
 * `serializableCheck` and `immutableCheck` stay ON. They are the enforcement
 * mechanism for the three-tier rule, and disabling them "to make the warning go
 * away" is exactly how a store ends up holding a 24 MB typed array.
 *
 * Design doc: Part V.1, V.6.
 */

import { configureStore } from "@reduxjs/toolkit";
import type { Middleware } from "@reduxjs/toolkit";
import { EXAMPLES } from "@cam/script-host";
import { compile } from "./compileThunk.js";
import { reducers } from "./slices.js";
import { machineChanged, scriptChanged, simulateToggled } from "./slices.js";

/**
 * Recompile shortly after the user stops typing.
 *
 * 600 ms is the prototype's value and it feels right: fast enough to be live,
 * slow enough not to compile in the middle of an identifier. An in-flight
 * compile is abandoned rather than awaited — its result would be stale.
 */
const AUTO_COMPILE_DEBOUNCE_MS = 600;

const autoCompile: Middleware = (api) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: { abort: () => void } | undefined;

  return (next) => (action) => {
    const result = next(action);

    const type = (action as { type?: string }).type;
    const triggers = type === scriptChanged.type
      || type === machineChanged.type
      || type === simulateToggled.type;

    if (triggers) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        inFlight?.abort();
        inFlight = api.dispatch(compile() as never) as unknown as { abort: () => void };
      }, AUTO_COMPILE_DEBOUNCE_MS);
    }

    return result;
  };
};

export function createStore() {
  return configureStore({
    reducer: reducers,
    preloadedState: {
      project: {
        name: "surface-finish",
        script: EXAMPLES[1].source,
        machineId: "linuxcnc",
        simulate: true,
        simulationResolution: 140,
      },
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: true,
        immutableCheck: true,
      }).concat(autoCompile),
  });
}

export type AppStore = ReturnType<typeof createStore>;
export type RootState = ReturnType<AppStore["getState"]>;
export type AppDispatch = AppStore["dispatch"];
