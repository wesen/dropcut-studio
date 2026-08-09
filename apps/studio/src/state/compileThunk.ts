/**
 * The compile thunk.
 *
 * Runs the same pipeline the CLI runs — literally the same function — and then
 * splits the result: BIG things into the artifact cache, SMALL summaries into
 * Redux. That split is the whole of ADR-004 in practice.
 *
 * Design doc: Part V.4.
 */

import { createAsyncThunk } from "@reduxjs/toolkit";
import type { CheckStatus, Diagnostic } from "@cam/ir";
import { getMachine } from "@cam/machine";
import type { Mesh } from "@cam/geometry";
import { PRESETS, tessellate, translateMesh } from "@cam/geometry";
import { runPlan } from "@cam/planner";
import { dispatchStrategy } from "@cam/strategies";
import { lower, recertify, validate } from "@cam/compiler";
import { emitRs274 } from "@cam/post-rs274";
import { emitMakera } from "@cam/post-makera";
import type { CheckMove } from "@cam/analysis";
import { estimateTime, runSampledChecks } from "@cam/analysis";
import { runScript } from "@cam/script-host";
import { buildRenderBuffers } from "@cam/viewer-three";
import { mm } from "@cam/units";
import type { Tool } from "@cam/machine";
import { collectGarbage, putArtifact } from "./artifactCache.js";
import type { CertificateRow, CompileSucceeded, ProjectState } from "./slices.js";
import { compileFailed, compileStarted, compileSucceeded } from "./slices.js";

/** Meshes available to scripts. Built once — tessellation is not free. */
let meshCache: Record<string, Mesh> | null = null;
function builtinMeshes(): Record<string, Mesh> {
  meshCache ??= Object.fromEntries(
    Object.entries(PRESETS).map(([name, field]) => [name, tessellate(field, name)]),
  );
  return meshCache;
}

export interface CompileThunkResult {
  readonly ok: boolean;
}

/**
 * The slice of state every thunk in the app needs.
 *
 * Declared once and shared, so thunks can dispatch each other. Two thunks with
 * structurally different `state` types cannot be composed, which TypeScript
 * reports as an inscrutable overload failure rather than the trivial mismatch
 * it actually is.
 */
export interface ThunkApi {
  state: { project: ProjectState };
}

export const compile = createAsyncThunk<CompileThunkResult, void, ThunkApi>(
  "compile/run", async (_arg, { getState, dispatch }) => {
  const { script, machineId, simulate, simulationResolution } = getState().project;
  const started = performance.now();
  dispatch(compileStarted());

  const machine = getMachine(machineId);
  const meshes = builtinMeshes();

  /* 1. Script. */
  const scriptResult = runScript(script, { meshNames: Object.keys(meshes) });
  if (!scriptResult.ok) {
    dispatch(compileFailed({ stage: "script", diagnostics: scriptResult.diagnostics }));
    return { ok: false };
  }

  const selected = scriptResult.meshName ? meshes[scriptResult.meshName] : undefined;
  const mesh = selected
    ? translateMesh(selected, scriptResult.meshOffset.x, scriptResult.meshOffset.y,
      scriptResult.meshOffset.z)
    : undefined;

  const diagnostics: Diagnostic[] = [...scriptResult.diagnostics];

  /* 2. Plan. */
  const run = runPlan(scriptResult.plan, { mesh, strategies: dispatchStrategy });
  diagnostics.push(...run.diagnostics);
  if (diagnostics.some((d) => d.severity === "error")) {
    dispatch(compileFailed({ stage: "plan", diagnostics }));
    return { ok: false };
  }

  /* 3-4. Lower and validate. */
  const lowered = lower(run.program, machine);
  const validated = validate(lowered, machine);
  if (!validated.ok) {
    dispatch(compileFailed({
      stage: "validate",
      diagnostics: [...diagnostics, ...validated.diagnostics],
    }));
    return { ok: false };
  }

  /* 5. Emit. */
  const tools = scriptResult.plan.tools;
  const emitted = machine.dialect === "makera"
    ? emitMakera(validated.program, machine, { tools: Object.values(tools) })
    : emitRs274(validated.program, machine);

  /* 6-7. Simulate and recertify. */
  let program = validated.program;
  if (simulate) {
    const byNumber = new Map<number, Tool>(Object.values(tools).map((t) => [t.number, t]));
    const moves: CheckMove[] = emitted.motions.flatMap((m) => {
      const tool = m.toolNumber === null ? undefined : byNumber.get(m.toolNumber);
      return tool
        ? [{ kind: m.kind, from: m.from, to: m.to, tool: tool.geometry, gcodeLine: m.gcodeLine }]
        : [];
    });

    const s = scriptResult.plan.setup.stock;
    const checks = runSampledChecks(moves, {
      stock: { width: s.x, depth: s.y, height: s.z,
        originX: s.originX, originY: s.originY, topZ: s.topZ },
      safeZ: s.topZ,
      resolution: simulationResolution,
    });
    diagnostics.push(...checks.diagnostics);
    program = recertify(validated.program, {
      spatialResolution: mm(checks.resolution),
      numericalTolerance: mm(0.02),
      diagnostics: checks.diagnostics,
    });

    if (checks.diagnostics.some((d) => d.severity === "error")) {
      dispatch(compileFailed({ stage: "checks", diagnostics }));
      return { ok: false };
    }
  }

  /* 8. Split: buffers into the cache, summaries into Redux. */
  const buffers = buildRenderBuffers(emitted.motions.map((m) => ({
    kind: m.kind, from: m.from, to: m.to, seconds: m.seconds,
    gcodeLine: m.gcodeLine,
    purpose: m.provenance.strategyName?.includes("rough") ? "rough" : "finish",
  })));

  const stockDef = scriptResult.plan.setup.stock;
  const artifactId = putArtifact({
    program,
    document: emitted.document,
    buffers,
    mesh: mesh ?? null,
    stock: {
      width: stockDef.x, depth: stockDef.y, height: stockDef.z,
      originX: stockDef.originX, originY: stockDef.originY, topZ: stockDef.topZ,
    },
  });
  collectGarbage(new Set([artifactId]));

  const time = estimateTime(
    emitted.motions.map((m) => ({
      kind: m.kind,
      length: Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y, m.to.z - m.from.z),
      feed: m.feed,
    })),
    machine.rapidRate,
  );

  const payload: CompileSucceeded = {
    artifactId,
    diagnostics,
    stats: {
      lines: emitted.document.lines.length,
      motions: emitted.motions.length,
      cutLengthMm: time.cutLength,
      rapidLengthMm: time.rapidLength,
      seconds: time.total,
      timeModel: time.model,
    },
    summaries: run.summaries.map((s) => ({ ...s })),
    certificate: certificateRows(program.certificate),
    errorBudgetMm: program.certificate.errorBudget.totalGeometric,
    elapsedMs: Math.round(performance.now() - started),
  };

  dispatch(compileSucceeded(payload));
  return { ok: true };
});

/**
 * Flatten the certificate into serialisable rows.
 *
 * The store must not hold branded `Mm` values in nested unions — they are just
 * numbers at runtime, but keeping the store's shape flat and obvious is worth
 * more than reusing the type.
 */
function certificateRows(cert: {
  travel: CheckStatus; spindle: CheckStatus; feedLimits: CheckStatus;
  interlocks: CheckStatus; gouge: CheckStatus; rapidCrash: CheckStatus;
  fixture: CheckStatus; holder: CheckStatus;
}): CertificateRow[] {
  const rows: [string, CheckStatus][] = [
    ["travel limits", cert.travel],
    ["spindle range", cert.spindle],
    ["feed limits", cert.feedLimits],
    ["interlocks", cert.interlocks],
    ["gouge", cert.gouge],
    ["rapid through stock", cert.rapidCrash],
    ["fixture collision", cert.fixture],
    ["holder collision", cert.holder],
  ];

  return rows.map(([label, s]) => {
    switch (s.kind) {
      case "verified-exact":
        return { label, status: "exact" as const, detail: "exact" };
      case "verified-to-resolution":
        return {
          label, status: "resolution" as const,
          detail: `verified to ${s.spatial.toFixed(3)} mm grid, ${s.numerical.toFixed(3)} mm tolerance`,
        };
      case "not-checked":
        return { label, status: "skipped" as const, detail: `not checked — ${s.reason}` };
      case "unverifiable":
        return { label, status: "unknown" as const, detail: `unverifiable — ${s.reason}` };
    }
  });
}
