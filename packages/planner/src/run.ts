/**
 * @cam/planner/run — turn a ManufacturingPlan into a CanonicalProgram.
 *
 * This is the stage the prototype's `generateJob` collapsed into one 460-line
 * function. Here each concern is a separate, testable step:
 *
 *     plan -> [per operation]  strategy  -> ToolpathSet
 *                              orderPaths -> travel-efficient order
 *                              planLink   -> stay down or retract
 *                              planEntry  -> helix / ramp / plunge
 *                           -> CanonicalCommand[]
 *
 * The runner owns tool changes, spindle scoping and the CL-field cache. The
 * strategies own only geometry.
 *
 * Design doc: Part III.1, XII.3.
 */

import type { Mm } from "@cam/units";
import { mm, mmPerMin, rpm } from "@cam/units";
import { box2, box3, point } from "@cam/math";
import type { Box2 } from "@cam/math";
import type {
  CanonicalCommand, CanonicalProgram, Diagnostic, Path, Provenance, ToolRef,
} from "@cam/ir";
import { error, provenance as makeProvenance, warning } from "@cam/ir";
import type { Tool } from "@cam/machine";
import { radiusOf } from "@cam/machine";
import type { CLField, Mesh } from "@cam/geometry";
import { buildCLField, makeCutterLocation } from "@cam/geometry";
import type {
  ManufacturingPlan, Operation, PlanningContext, ToolpathSet,
} from "./types.js";
import { planEntry } from "./entry.js";
import { orderPaths, planLink } from "./linker.js";

export interface RunOptions {
  readonly mesh?: Mesh;
  readonly signal?: { readonly aborted: boolean };
  onProgress?(fraction: number, note?: string): void;
  /** Strategy dispatch. Injected so @cam/planner does not depend on @cam/strategies. */
  readonly strategies: StrategyDispatch;
}

export interface StrategyDispatch {
  (ctx: PlanningContext, op: Operation): ToolpathSet;
}

export interface RunResult {
  readonly program: CanonicalProgram<"work">;
  readonly diagnostics: readonly Diagnostic[];
  readonly summaries: readonly { operationId: string; description: string; paths: number }[];
}

export function runPlan(plan: ManufacturingPlan, opts: RunOptions): RunResult {
  const diagnostics: Diagnostic[] = [];
  const commands: CanonicalCommand<"work">[] = [];
  const summaries: RunResult["summaries"] = [];
  const toolRefs = new Map<string, ToolRef>();

  let activeToolId: string | null = null;
  let spindleRunning = false;
  let cursor = { x: 0, y: 0, z: plan.setup.clearance as number };

  const bounds = planBounds(plan);

  for (let i = 0; i < plan.operations.length; i++) {
    if (opts.signal?.aborted) break;
    const op = plan.operations[i];
    const prov = makeProvenance(op.id);

    const tool = plan.tools[op.toolId];
    if (!tool) {
      diagnostics.push(error("interlock.noTool",
        `operation "${op.id}" references unknown tool "${op.toolId}"`, { provenance: prov }));
      continue;
    }

    const toolRef: ToolRef = { id: tool.id, number: tool.number };
    toolRefs.set(tool.id, toolRef);

    /* --- tool change, with the spindle interlock respected --- */
    if (activeToolId !== tool.id) {
      if (spindleRunning) {
        commands.push({ kind: "spindle", state: { mode: "off" }, provenance: prov });
        spindleRunning = false;
      }
      commands.push({ kind: "tool-change", tool: toolRef, provenance: prov });
      activeToolId = tool.id;
    }

    if (!spindleRunning) {
      commands.push({
        kind: "spindle",
        state: { mode: "cw", speed: op.spindleSpeed ?? rpm(12000) },
        provenance: prov,
      });
      spindleRunning = true;
    }

    commands.push({ kind: "comment", text: `${op.id} (${op.kind})`, provenance: prov });

    /* --- run the strategy --- */
    const ctx = makeContext(plan, op, tool, bounds, prov, opts);
    let set: ToolpathSet;
    try {
      set = opts.strategies(ctx, op);
    } catch (e) {
      diagnostics.push(error("script.error",
        `operation "${op.id}" failed: ${e instanceof Error ? e.message : String(e)}`,
        { provenance: prov }));
      continue;
    }

    if (set.diagnostics) diagnostics.push(...set.diagnostics);
    if (set.paths.length === 0) {
      diagnostics.push(warning("program.noMotion",
        `operation "${op.id}" produced no toolpaths`, { provenance: prov }));
      continue;
    }

    /* --- order, link and emit --- */
    const ordered = orderPaths(set.paths, cursor.x, cursor.y);
    const surfaceAt = ctx.evaluate(op.kind === "rough-surface" ? op.stockToLeave : 0);
    const toolRadius = radiusOf(tool.geometry);

    for (let p = 0; p < ordered.length; p++) {
      const path = ordered[p];
      const pathProv: Provenance = { ...prov, strategyName: set.description, pathIndex: p };

      const linkOpts = {
        stayDownDistance: Math.max(3 * set.stepover, 1.5),
        clearanceZ: plan.setup.clearance as number,
        stockTopZ: plan.setup.stock.topZ as number,
        surfaceAt,
        rideClearance: 0.6,
        feed: op.feed,
        toolRadius,
        tool: toolRef,
        provenance: pathProv,
      };

      if (p === 0) {
        // First path of the operation: traverse in at clearance, then descend
        // under feed control.
        commands.push({
          kind: "traverse",
          to: point(path.start.x, path.start.y, plan.setup.clearance, "work"),
          clearance: { safeZ: plan.setup.clearance, allowCoordinated: true },
          provenance: pathProv,
        });
        commands.push(...entryCommands(
          plan, op, path, tool, toolRef, pathProv, surfaceAt, plan.setup.clearance));
      } else {
        const link = planLink(cursor, path.start, linkOpts);
        commands.push(...link.commands);
        if (link.kind === "retract") {
          // The traverse stopped at the safe height; descend from there rather
          // than from the global clearance plane, which would mean climbing.
          commands.push(...entryCommands(
            plan, op, path, tool, toolRef, pathProv, surfaceAt, link.leavesAtZ));
        }
      }

      commands.push({
        kind: "cut",
        path,
        feed: op.feed,
        tolerance: chordToleranceOf(op),
        purpose: set.purpose,
        tool: toolRef,
        provenance: pathProv,
      });

      cursor = { x: path.end.x, y: path.end.y, z: path.end.z };
    }

    // Retract at the end of the operation.
    commands.push({
      kind: "traverse",
      to: point(cursor.x, cursor.y, plan.setup.clearance, "work"),
      clearance: { safeZ: plan.setup.clearance, allowCoordinated: false },
      provenance: prov,
    });
    cursor = { ...cursor, z: plan.setup.clearance as number };

    (summaries as { operationId: string; description: string; paths: number }[]).push({
      operationId: op.id,
      description: set.description,
      paths: ordered.length,
    });

    opts.onProgress?.((i + 1) / plan.operations.length, op.id);
  }

  if (spindleRunning) {
    commands.push({ kind: "spindle", state: { mode: "off" }, provenance: makeProvenance("<end>") });
  }

  return {
    program: {
      setup: {
        stock: plan.setup.stock,
        clearance: plan.setup.clearance,
        workOffset: plan.setup.workOffset,
      },
      commands,
      tools: toolRefs,
    },
    diagnostics,
    summaries,
  };
}

/* ---------------------------- helpers --------------------------------- */

/** Placeholder for 2.5D operations, which never consult a mesh. */
const EMPTY_MESH: Mesh = {
  tris: new Float64Array(0),
  triangleCount: 0,
  bounds: box3(0, 0, 0, 0, 0, 0),
  name: "empty",
};

function chordToleranceOf(op: Operation): Mm {
  return op.kind === "finish-surface" ? op.chordTolerance : mm(0.01);
}

/**
 * Descend into the material at the start of a path.
 *
 * Roughing gets a proper helix/ramp entry because it is cutting full-width into
 * solid stock. Finishing paths follow the CL surface and start where the surface
 * already is, so a straight descent from clearance is correct and a ramp would
 * just waste time.
 */
function entryCommands(
  plan: ManufacturingPlan,
  op: Operation,
  path: Path<"work">,
  tool: Tool,
  toolRef: ToolRef,
  prov: Provenance,
  surfaceAt: (x: number, y: number) => number,
  fromZ: number,
): CanonicalCommand<"work">[] {
  const start = path.start;

  // Already at or below the target: nothing to descend.
  if (fromZ <= start.z + 1e-9) return [];

  if (op.kind !== "rough-surface" && op.kind !== "pocket") {
    // Finishing paths start ON the CL surface, so a straight controlled plunge
    // is correct. It must be a CUT, not a rapid: it may pass through material
    // that roughing has not removed.
    return [{
      kind: "cut",
      path: {
        frame: "work",
        start: point(start.x, start.y, fromZ, "work"),
        end: start,
        segments: [{ kind: "line", to: start }],
      },
      feed: op.plungeFeed ?? mmPerMin(Math.max(30, op.feed / 3)),
      tolerance: mm(0.01),
      purpose: "plunge",
      tool: toolRef,
      provenance: prov,
    }];
  }

  // Direction of the first cutting move, for ramp orientation.
  const next = firstDirection(path);
  const entry = planEntry({
    x: start.x, y: start.y, z: start.z,
    fromZ,
    dirX: next.x, dirY: next.y,
    available: next.length,
    toolRadius: radiusOf(tool.geometry),
    mode: op.kind === "rough-surface"
      ? (op.entry.kind === "auto" ? "auto" : op.entry.kind === "ramp" ? "ramp" : "plunge")
      : "auto",
    maxRampAngle: op.kind === "rough-surface" && op.entry.kind === "auto"
      ? op.entry.maxRampAngle
      : op.kind === "rough-surface" && op.entry.kind === "ramp" ? op.entry.angle : 3,
    clear: (x, y, z) => surfaceAt(x, y) <= z + 1e-6,
    provenance: prov,
  });

  return [{
    kind: "cut",
    path: entry.path,
    feed: op.plungeFeed ?? mmPerMin(Math.max(30, op.feed / 2)),
    tolerance: mm(0.01),
    purpose: entry.kind === "plunge" ? "plunge" : "ramp",
    tool: toolRef,
    provenance: prov,
  }];
}

/** Unit direction and length of a path's first move. */
function firstDirection(path: Path<"work">): { x: number; y: number; length: number } {
  const s = path.start;
  const seg = path.segments[0];
  let tx: number = s.x;
  let ty: number = s.y;

  if (seg?.kind === "line") { tx = seg.to.x; ty = seg.to.y; }
  else if (seg?.kind === "arc") { tx = seg.to.x; ty = seg.to.y; }
  else if (seg?.kind === "poly" && seg.pts.length >= 3) { tx = seg.pts[0]; ty = seg.pts[1]; }

  const dx = tx - s.x;
  const dy = ty - s.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return { x: 1, y: 0, length: 0 };
  return { x: dx / L, y: dy / L, length: L };
}

function planBounds(plan: ManufacturingPlan): Box2 {
  const s = plan.setup.stock;
  return box2(s.originX, s.originY, s.originX + s.x, s.originY + s.y);
}

/**
 * Build the per-operation planning context, with a memoised CL field.
 *
 * Memoisation matters: hybrid and constant-scallop each want a field, building
 * one costs seconds, and a plan that uses both would otherwise pay twice for
 * identical work.
 */
function makeContext(
  plan: ManufacturingPlan,
  op: Operation,
  tool: Tool,
  bounds: Box2,
  prov: Provenance,
  opts: RunOptions,
): PlanningContext {
  const evaluators = new Map<number, (x: number, y: number) => number>();
  const fields = new Map<string, CLField>();

  const margin = op.kind === "rough-surface" || op.kind === "finish-surface" ? op.margin : mm(0);
  const padded = box2(
    bounds.minX - margin, bounds.minY - margin,
    bounds.maxX + margin, bounds.maxY + margin,
  );

  const evaluate = (inflate = 0) => {
    const cached = evaluators.get(inflate);
    if (cached) return cached;
    if (!opts.mesh) {
      // 2.5D operations do not need a mesh; the "surface" is the stock top.
      const flat = () => plan.setup.stock.topZ as number;
      evaluators.set(inflate, flat);
      return flat;
    }
    const fn = makeCutterLocation(opts.mesh, tool.geometry, {
      floorZ: plan.setup.floorZ,
      inflate,
    });
    evaluators.set(inflate, fn);
    return fn;
  };

  return {
    mesh: opts.mesh ?? EMPTY_MESH,
    tool,
    setup: plan.setup,
    bounds: padded,
    provenance: prov,
    signal: opts.signal,
    progress: (f, note) => opts.onProgress?.(f, note ?? op.id),
    evaluate,
    cutterLocationField(spacing, inflate = 0) {
      const key = `${spacing}:${inflate}`;
      const cached = fields.get(key);
      if (cached) return cached;
      const field = buildCLField(evaluate(inflate), padded, spacing, { signal: opts.signal });
      if (!field) throw new Error("CL field build was cancelled");
      fields.set(key, field);
      return field;
    },
  };
}
