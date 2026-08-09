/**
 * @cam/script-host/api — the capability object handed to user scripts.
 *
 * This is the entire surface a script can see. It is built fresh per run and
 * passed as named parameters to the compiled function, so the script has no
 * ambient access to anything else.
 *
 * Two carried-over ideas from the IDE prototype, both worth keeping:
 *
 *  - BRANDED UNITS AT RUNTIME. TypeScript brands erase, and a script is not
 *    type-checked, so `mm(4)` returns a boxed `{__unit, v}`. Passing the wrong
 *    brand throws; passing a bare number works but WARNS. That combination
 *    matters: a first-time user typing `diameter: 4` should get a working
 *    program and a yellow note, not a red wall.
 *
 *  - SCOPE COMBINATORS. `withSpindle(opts, body)` emits the start, runs the
 *    body, and emits the stop. The user cannot forget the M5, because there is
 *    no way to express the unbalanced form.
 *
 * Design doc: Part VII.3.
 */

import type { Mm, MmPerMin, Ratio, Rpm } from "@cam/units";
import { mm as toMm, mmPerMin as toFeed, ratio as toRatio, rpm as toRpm } from "@cam/units";
import { box2 } from "@cam/math";
import type { Diagnostic } from "@cam/ir";
import { warning } from "@cam/ir";
import type { Tool, ToolGeometry } from "@cam/machine";
import type {
  EntrySpec, ManufacturingPlan, Operation, PlanSetup, StrategySpec,
} from "@cam/planner";

/* --------------------------- boxed units ------------------------------- */

export interface Boxed<K extends string> {
  readonly __unit: K;
  readonly v: number;
}

const box = <K extends string>(unit: K, v: number): Boxed<K> => ({ __unit: unit, v });

export type MmArg = Boxed<"mm"> | number;
export type RpmArg = Boxed<"rpm"> | number;
export type FeedArg = Boxed<"mm/min"> | number;
export type DegArg = Boxed<"deg"> | number;

/* ------------------------------ builder -------------------------------- */

export interface ScriptResult {
  readonly plan: ManufacturingPlan;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Build the API object and the accessor that harvests its result.
 *
 * Everything mutable lives in this closure, so two concurrent runs cannot see
 * each other's state.
 */
export function createScriptApi(options: {
  /** Where the script's `geometry.mesh(name)` looks things up. */
  readonly meshNames?: readonly string[];
} = {}) {
  const diagnostics: Diagnostic[] = [];
  const tools: Record<string, Tool> = {};
  const operations: Operation[] = [];

  let toolSeq = 0;
  const opCounts: Record<string, number> = {};
  let setup: PlanSetup = {
    stock: { x: toMm(100), y: toMm(100), z: toMm(20),
      originX: toMm(0), originY: toMm(0), topZ: toMm(0) },
    clearance: toMm(5),
    workOffset: "G54",
    floorZ: toMm(-20),
  };

  let activeSpindle: Rpm | null = null;
  let activeToolId: string | null = null;
  let meshName: string | null = null;
  let meshOffset = { x: 0, y: 0, z: 0 };

  const warn = (message: string, code: Diagnostic["code"] = "units.bareNumber") => {
    diagnostics.push(warning(code, message));
  };

  /**
   * Unwrap a boxed unit. Bare numbers are accepted with a warning; the wrong
   * brand is a hard error, because it is never a typo the user meant.
   */
  function unwrap(value: unknown, unit: string, context: string): number {
    if (value === null || value === undefined) {
      throw new TypeError(`${context}: required value is missing`);
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError(`${context}: ${value} is not a finite number`);
      warn(`bare number passed to ${context} — interpreted as ${unit}; prefer ${unit === "mm/min" ? "mmPerMin()" : unit + "()"}`);
      return value;
    }
    if (typeof value === "object" && "__unit" in (value as object)) {
      const b = value as Boxed<string>;
      if (b.__unit !== unit) {
        throw new TypeError(`${context}: expected ${unit}, got ${b.__unit}`);
      }
      return b.v;
    }
    throw new TypeError(`${context}: expected ${unit}, got ${typeof value}`);
  }

  const optional = (value: unknown, unit: string, context: string, fallback: number): number =>
    value === undefined || value === null ? fallback : unwrap(value, unit, context);

  const nextOpId = (kind: string) => {
    opCounts[kind] = (opCounts[kind] ?? 0) + 1;
    return `${kind}#${opCounts[kind]}`;
  };

  const requireTool = (context: string): string => {
    if (!activeToolId) {
      throw new Error(`${context}: no tool selected — call job.toolChange(t) or job.withTool(t, ...)`);
    }
    return activeToolId;
  };

  /* ------------------------------ units -------------------------------- */

  const units = {
    mm: (v: number) => box("mm", v),
    inch: (v: number) => box("mm", v * 25.4),
    rpm: (v: number) => box("rpm", v),
    mmPerMin: (v: number) => box("mm/min", v),
    deg: (v: number) => box("deg", v),
    percent: (v: number) => v / 100,
  };

  /* ------------------------------ tools -------------------------------- */

  function defineTool(name: string, geometry: ToolGeometry, extra: Partial<Tool> = {}): Tool {
    const id = `T${++toolSeq}`;
    const tool: Tool = { id, number: toolSeq, name: name || id, geometry, ...extra };
    tools[id] = tool;
    return tool;
  }

  const toolsApi = {
    flatEndMill(o: { name?: string; diameter: MmArg; fluteLength?: MmArg }) {
      return defineTool(o?.name ?? "", {
        type: "flat", diameter: toMm(unwrap(o?.diameter, "mm", "tools.flatEndMill diameter")),
      }, fluteOf(o?.fluteLength));
    },
    ballEndMill(o: { name?: string; diameter: MmArg; fluteLength?: MmArg }) {
      return defineTool(o?.name ?? "", {
        type: "ball", diameter: toMm(unwrap(o?.diameter, "mm", "tools.ballEndMill diameter")),
      }, fluteOf(o?.fluteLength));
    },
    bullNose(o: { name?: string; diameter: MmArg; cornerRadius: MmArg }) {
      return defineTool(o?.name ?? "", {
        type: "bull",
        diameter: toMm(unwrap(o?.diameter, "mm", "tools.bullNose diameter")),
        cornerRadius: toMm(unwrap(o?.cornerRadius, "mm", "tools.bullNose cornerRadius")),
      });
    },
    vBit(o: { name?: string; diameter: MmArg; tipDiameter: MmArg; includedAngle: DegArg }) {
      return defineTool(o?.name ?? "", {
        type: "vbit",
        diameter: toMm(unwrap(o?.diameter, "mm", "tools.vBit diameter")),
        tipDiameter: toMm(unwrap(o?.tipDiameter, "mm", "tools.vBit tipDiameter")),
        includedAngle: unwrap(o?.includedAngle, "deg", "tools.vBit includedAngle") as never,
      });
    },
  };

  const fluteOf = (v: MmArg | undefined): Partial<Tool> =>
    v === undefined ? {} : { fluteLength: toMm(unwrap(v, "mm", "fluteLength")) };

  /* ---------------------------- strategies ------------------------------ */

  const strategy = {
    raster(o: { direction?: "X" | "Y"; scallop?: MmArg; stepover?: number } = {}): StrategySpec {
      return {
        kind: "raster",
        direction: o.direction ?? "X",
        ...(o.scallop !== undefined
          ? { scallop: toMm(unwrap(o.scallop, "mm", "strategy.raster scallop")) } : {}),
        ...(o.stepover !== undefined ? { stepover: toRatio(o.stepover) } : {}),
      };
    },
    hybridWaterline(o: { scallop: MmArg; steepAngle?: DegArg }): StrategySpec {
      return {
        kind: "hybrid-waterline",
        scallop: toMm(unwrap(o?.scallop, "mm", "strategy.hybridWaterline scallop")),
        steepAngle: optional(o?.steepAngle, "deg", "strategy.hybridWaterline steepAngle", 45),
      };
    },
    constantScallop(o: { scallop: MmArg }): StrategySpec {
      return {
        kind: "constant-scallop",
        scallop: toMm(unwrap(o?.scallop, "mm", "strategy.constantScallop scallop")),
      };
    },
  };

  const entry = {
    auto(o: { maxRampAngle?: DegArg } = {}): EntrySpec {
      return { kind: "auto", maxRampAngle: optional(o.maxRampAngle, "deg", "entry.auto maxRampAngle", 3) };
    },
    ramp(o: { angle?: DegArg } = {}): EntrySpec {
      return { kind: "ramp", angle: optional(o.angle, "deg", "entry.ramp angle", 3) };
    },
    plunge(): EntrySpec {
      return { kind: "plunge" };
    },
  };

  /* ------------------------------- job --------------------------------- */

  const job = {
    setup(o: {
      stock: { x: MmArg; y: MmArg; z: MmArg; originX?: MmArg; originY?: MmArg; topZ?: MmArg };
      clearance?: MmArg;
      workOffset?: string;
      floorZ?: MmArg;
    }) {
      const s = o?.stock;
      if (!s) throw new Error("job.setup: stock is required");
      const topZ = optional(s.topZ, "mm", "setup.stock.topZ", 0);
      const zHeight = unwrap(s.z, "mm", "setup.stock.z");
      setup = {
        stock: {
          x: toMm(unwrap(s.x, "mm", "setup.stock.x")),
          y: toMm(unwrap(s.y, "mm", "setup.stock.y")),
          z: toMm(zHeight),
          originX: toMm(optional(s.originX, "mm", "setup.stock.originX", 0)),
          originY: toMm(optional(s.originY, "mm", "setup.stock.originY", 0)),
          topZ: toMm(topZ),
        },
        clearance: toMm(optional(o.clearance, "mm", "setup.clearance", 5)),
        workOffset: o.workOffset ?? "G54",
        floorZ: toMm(optional(o.floorZ, "mm", "setup.floorZ", topZ - zHeight)),
      };
    },

    toolChange(tool: Tool) {
      if (!tool || typeof tool !== "object" || !("geometry" in tool)) {
        throw new TypeError("job.toolChange: expected a tool from tools.*");
      }
      activeToolId = tool.id;
    },

    withTool(tool: Tool, body: () => void) {
      const previous = activeToolId;
      job.toolChange(tool);
      try { body(); } finally { activeToolId = previous; }
    },

    withSpindle(o: { speed: RpmArg }, body: () => void) {
      const previous = activeSpindle;
      activeSpindle = toRpm(unwrap(o?.speed, "rpm", "withSpindle speed"));
      try { body(); } finally { activeSpindle = previous; }
    },

    /* ------------------------ 2.5D operations ------------------------- */

    face(o: {
      x: MmArg; y: MmArg; w: MmArg; h: MmArg; z: MmArg;
      stepover?: number; feed: FeedArg;
    }) {
      const x = unwrap(o.x, "mm", "face.x");
      const y = unwrap(o.y, "mm", "face.y");
      operations.push({
        kind: "face",
        id: nextOpId("face"),
        toolId: requireTool("job.face"),
        feed: toFeed(unwrap(o.feed, "mm/min", "face.feed")),
        area: box2(x, y, x + unwrap(o.w, "mm", "face.w"), y + unwrap(o.h, "mm", "face.h")),
        z: toMm(unwrap(o.z, "mm", "face.z")),
        stepover: toRatio(o.stepover ?? 0.5),
        ...spindleOf(),
      });
    },

    rectPocket(o: {
      x: MmArg; y: MmArg; w: MmArg; h: MmArg; depth: MmArg;
      stepdown: MmArg; stepover?: number; feed: FeedArg; plungeFeed?: FeedArg;
    }) {
      const x = unwrap(o.x, "mm", "rectPocket.x");
      const y = unwrap(o.y, "mm", "rectPocket.y");
      operations.push({
        kind: "pocket",
        id: nextOpId("pocket"),
        toolId: requireTool("job.rectPocket"),
        feed: toFeed(unwrap(o.feed, "mm/min", "rectPocket.feed")),
        area: box2(x, y,
          x + unwrap(o.w, "mm", "rectPocket.w"), y + unwrap(o.h, "mm", "rectPocket.h")),
        depth: toMm(unwrap(o.depth, "mm", "rectPocket.depth")),
        stepdown: toMm(unwrap(o.stepdown, "mm", "rectPocket.stepdown")),
        stepover: toRatio(o.stepover ?? 0.4),
        ...plungeOf(o.plungeFeed),
        ...spindleOf(),
      });
    },

    drill(o: {
      points: readonly { x: MmArg; y: MmArg }[];
      depth: MmArg; peck?: MmArg; feed: FeedArg;
    }) {
      operations.push({
        kind: "drill",
        id: nextOpId("drill"),
        toolId: requireTool("job.drill"),
        feed: toFeed(unwrap(o.feed, "mm/min", "drill.feed")),
        points: (o.points ?? []).map((p, i) => ({
          x: toMm(unwrap(p.x, "mm", `drill.points[${i}].x`)),
          y: toMm(unwrap(p.y, "mm", `drill.points[${i}].y`)),
        })),
        depth: toMm(unwrap(o.depth, "mm", "drill.depth")),
        ...(o.peck !== undefined ? { peck: toMm(unwrap(o.peck, "mm", "drill.peck")) } : {}),
        ...spindleOf(),
      });
    },

    /* ------------------------ 3D operations --------------------------- */

    roughSurface(o: {
      stepdown: MmArg; stepover?: number; stockToLeave: MmArg;
      entry?: EntrySpec; margin?: MmArg; feed: FeedArg; plungeFeed?: FeedArg;
    }) {
      operations.push({
        kind: "rough-surface",
        id: nextOpId("rough"),
        toolId: requireTool("job.roughSurface"),
        feed: toFeed(unwrap(o.feed, "mm/min", "roughSurface.feed")),
        stepdown: toMm(unwrap(o.stepdown, "mm", "roughSurface.stepdown")),
        stepover: toRatio(o.stepover ?? 0.45),
        stockToLeave: toMm(unwrap(o.stockToLeave, "mm", "roughSurface.stockToLeave")),
        entry: o.entry ?? { kind: "auto", maxRampAngle: 3 },
        margin: toMm(optional(o.margin, "mm", "roughSurface.margin", 1)),
        ...plungeOf(o.plungeFeed),
        ...spindleOf(),
      });
    },

    finishSurface(o: {
      strategy: StrategySpec; chordTolerance?: MmArg; margin?: MmArg; feed: FeedArg;
    }) {
      if (!o?.strategy?.kind) {
        throw new TypeError("job.finishSurface: strategy is required — use strategy.*");
      }
      operations.push({
        kind: "finish-surface",
        id: nextOpId("finish"),
        toolId: requireTool("job.finishSurface"),
        feed: toFeed(unwrap(o.feed, "mm/min", "finishSurface.feed")),
        strategy: o.strategy,
        chordTolerance: toMm(optional(o.chordTolerance, "mm", "finishSurface.chordTolerance", 0.01)),
        margin: toMm(optional(o.margin, "mm", "finishSurface.margin", 1)),
        ...spindleOf(),
      });
    },
  };

  const spindleOf = () => (activeSpindle === null ? {} : { spindleSpeed: activeSpindle });
  const plungeOf = (v: FeedArg | undefined) =>
    v === undefined ? {} : { plungeFeed: toFeed(unwrap(v, "mm/min", "plungeFeed")) };

  /* ----------------------------- geometry ------------------------------ */

  const geometry = {
    /**
     * Select the part mesh, optionally placing it in the work envelope.
     *
     * Meshes arrive in their own frame — the built-in presets are centred on the
     * origin — but a machine's travel does not have to include negative
     * coordinates. `at` translates the part into work coordinates, which is the
     * same thing a machinist does when deciding where on the bed to clamp it.
     */
    mesh(name: string, o: { at?: { x?: MmArg; y?: MmArg; z?: MmArg } } = {}) {
      if (options.meshNames && !options.meshNames.includes(name)) {
        throw new Error(
          `geometry.mesh("${name}") — no such mesh` +
          (options.meshNames.length ? ` (have: ${options.meshNames.join(", ")})` : ""),
        );
      }
      meshName = name;
      meshOffset = {
        x: optional(o.at?.x, "mm", "geometry.mesh at.x", 0),
        y: optional(o.at?.y, "mm", "geometry.mesh at.y", 0),
        z: optional(o.at?.z, "mm", "geometry.mesh at.z", 0),
      };
      return { kind: "mesh" as const, name };
    },
  };

  /* ------------------------------ result -------------------------------- */

  const api = {
    ...units,
    tools: toolsApi,
    strategy,
    entry,
    job,
    geometry,
  };

  const harvest = (): ScriptResult => ({
    plan: { setup, operations, tools },
    diagnostics,
  });

  return {
    api,
    harvest,
    get meshName() { return meshName; },
    get meshOffset() { return meshOffset; },
  };
}

export type ScriptApi = ReturnType<typeof createScriptApi>["api"];

/** Names the sandbox binds as function parameters. Order must match `values`. */
export const apiNames = (api: ScriptApi): string[] => Object.keys(api);
export const apiValues = (api: ScriptApi): unknown[] => Object.values(api);
