/**
 * The full compile, as one reusable function.
 *
 * This is the same sequence the UI's compile thunk will run, kept headless so it
 * can be tested in Node and driven from the CLI. Keeping the pipeline in one
 * place — rather than duplicated between CLI and app — is what makes "the CLI
 * and the app agree" true by construction rather than by discipline.
 *
 *   script -> plan -> toolpaths -> canonical -> lower -> validate
 *          -> emit -> simulate -> recertify
 */

import { mm } from "@cam/units";
import type { Diagnostic, ValidatedProgram } from "@cam/ir";
import { hasErrors } from "@cam/ir";
import type { MachineProfile, Tool } from "@cam/machine";
import { getMachine } from "@cam/machine";
import type { Mesh } from "@cam/geometry";
import { PRESETS, tessellate, translateMesh } from "@cam/geometry";
import type { ManufacturingPlan } from "@cam/planner";
import { runPlan } from "@cam/planner";
import { dispatchStrategy } from "@cam/strategies";
import { lower, recertify, validate } from "@cam/compiler";
import type { EmitResult } from "@cam/post-rs274";
import { emitRs274 } from "@cam/post-rs274";
import { emitMakera } from "@cam/post-makera";
import type { CheckMove } from "@cam/analysis";
import { estimateTime, runSampledChecks } from "@cam/analysis";
import type { TimeEstimate } from "@cam/analysis";
import { runScript } from "@cam/script-host";

export interface CompileOptions {
  readonly machineId: string;
  /** Meshes available to `geometry.mesh(name)`. */
  readonly meshes?: Readonly<Record<string, Mesh>>;
  /** Skip the material simulation (faster, but the certificate says so). */
  readonly skipSimulation?: boolean;
  readonly simulationResolution?: number;
}

export interface CompileSuccess {
  readonly ok: true;
  readonly machine: MachineProfile;
  readonly plan: ManufacturingPlan;
  readonly program: ValidatedProgram;
  readonly emitted: EmitResult;
  readonly time: TimeEstimate;
  readonly diagnostics: readonly Diagnostic[];
  readonly summaries: readonly { operationId: string; description: string; paths: number }[];
}

export interface CompileFailure {
  readonly ok: false;
  readonly stage: "script" | "plan" | "validate" | "checks";
  readonly diagnostics: readonly Diagnostic[];
}

export type CompileOutcome = CompileSuccess | CompileFailure;

/** Meshes every script can reach by default. */
export function builtinMeshes(): Record<string, Mesh> {
  return Object.fromEntries(
    Object.entries(PRESETS).map(([name, field]) => [name, tessellate(field, name)]),
  );
}

export function compileScript(source: string, opts: CompileOptions): CompileOutcome {
  const machine = getMachine(opts.machineId);
  const meshes = opts.meshes ?? builtinMeshes();

  /* 1. Run the user's script to get a declarative plan. */
  const script = runScript(source, { meshNames: Object.keys(meshes) });
  if (!script.ok) return { ok: false, stage: "script", diagnostics: script.diagnostics };

  // Place the selected mesh where the script asked for it. Presets are centred
  // on the origin; a machine whose travel starts at zero cannot reach them there.
  const selected = script.meshName ? meshes[script.meshName] : undefined;
  const mesh = selected
    ? translateMesh(selected, script.meshOffset.x, script.meshOffset.y, script.meshOffset.z)
    : undefined;
  const diagnostics: Diagnostic[] = [...script.diagnostics];

  /* 2. Plan toolpaths. */
  const run = runPlan(script.plan, { mesh, strategies: dispatchStrategy });
  diagnostics.push(...run.diagnostics);
  if (hasErrors(diagnostics)) return { ok: false, stage: "plan", diagnostics };

  /* 3-4. Lower against the machine, then validate exactly. */
  const lowered = lower(run.program, machine);
  const validated = validate(lowered, machine);
  if (!validated.ok) {
    return { ok: false, stage: "validate", diagnostics: [...diagnostics, ...validated.diagnostics] };
  }

  /* 5. Emit. */
  const emitted = emitFor(validated.program, machine, script.plan.tools);

  /* 6-7. Simulate the EMITTED motion, then fold the evidence into the
     certificate. Simulation must come after emission because that is where
     traverses become real moves and arcs resolve into geometry. */
  let program = validated.program;
  if (!opts.skipSimulation) {
    const toolByNumber = new Map<number, Tool>(
      Object.values(script.plan.tools).map((t) => [t.number, t]),
    );

    // Each motion carries the T-number that was active when it was emitted, so
    // the simulation stamps the RIGHT cutter geometry rather than a guess.
    const moves: CheckMove[] = emitted.motions.flatMap((m) => {
      const tool = m.toolNumber === null ? undefined : toolByNumber.get(m.toolNumber);
      if (!tool) return [];
      return [{
        kind: m.kind, from: m.from, to: m.to,
        tool: tool.geometry, gcodeLine: m.gcodeLine,
      }];
    });

    const stock = script.plan.setup.stock;
    const checks = runSampledChecks(moves, {
      stock: {
        width: stock.x, depth: stock.y, height: stock.z,
        originX: stock.originX, originY: stock.originY, topZ: stock.topZ,
      },
      safeZ: stock.topZ,
      resolution: opts.simulationResolution ?? 150,
    });

    diagnostics.push(...checks.diagnostics);
    program = recertify(validated.program, {
      spatialResolution: mm(checks.resolution),
      numericalTolerance: mm(0.02),
      diagnostics: checks.diagnostics,
    });

    if (hasErrors(checks.diagnostics)) {
      return { ok: false, stage: "checks", diagnostics };
    }
  }

  const time = estimateTime(
    emitted.motions.map((m) => ({
      kind: m.kind,
      length: Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y, m.to.z - m.from.z),
      feed: m.feed,
    })),
    machine.rapidRate,
  );

  return {
    ok: true,
    machine,
    plan: script.plan,
    program,
    emitted,
    time,
    diagnostics,
    summaries: run.summaries,
  };
}

/**
 * Pick the backend for the target machine.
 *
 * The real tool table is passed through so the Makera header carries actual
 * cutter geometry. Synthesising a placeholder tool here would be exactly the
 * defect (D1) this project already fixed once.
 */
function emitFor(
  program: ValidatedProgram,
  machine: MachineProfile,
  tools: Readonly<Record<string, Tool>>,
): EmitResult {
  if (machine.dialect === "makera") {
    return emitMakera(program, machine, { tools: Object.values(tools) });
  }
  return emitRs274(program, machine);
}
