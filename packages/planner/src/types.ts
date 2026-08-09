/**
 * @cam/planner/types — the manufacturing plan and the strategy contract.
 *
 * A ManufacturingPlan is DECLARATIVE and SERIALISABLE: operations plus
 * parameters, no motion. That is not an accident of taste — it is what lets the
 * plan cross a postMessage boundary from the script sandbox, and what makes it
 * the natural save format.
 *
 * Strategies turn one operation into toolpaths. They are plugins registered by
 * name, so adding a machining strategy never means editing the planner.
 *
 * Design doc: Parts IV.5, IV.6.
 */

import type { Mm, MmPerMin, Ratio, Rpm } from "@cam/units";
import type { Box2 } from "@cam/math";
import type { CuttingPurpose, Path, Provenance } from "@cam/ir";
import type { Tool, ToolId } from "@cam/machine";
import type { CLField, Mesh } from "@cam/geometry";

export type OperationId = string;

/* ----------------------------- strategies ------------------------------ */

export type StrategySpec =
  | { readonly kind: "raster"; readonly direction: "X" | "Y";
      readonly scallop?: Mm; readonly stepover?: Ratio }
  | { readonly kind: "hybrid-waterline"; readonly scallop: Mm; readonly steepAngle: number }
  | { readonly kind: "constant-scallop"; readonly scallop: Mm }
  | { readonly kind: "zlevel-rough"; readonly stepdown: Mm;
      readonly stepover: Ratio; readonly stockToLeave: Mm };

export type EntrySpec =
  | { readonly kind: "auto"; readonly maxRampAngle: number }
  | { readonly kind: "ramp"; readonly angle: number }
  | { readonly kind: "plunge" };

/* ------------------------------ operations ----------------------------- */

interface OperationBase {
  readonly id: OperationId;
  readonly toolId: ToolId;
  readonly feed: MmPerMin;
  readonly plungeFeed?: MmPerMin;
  readonly spindleSpeed?: Rpm;
}

export interface RoughSurfaceOp extends OperationBase {
  readonly kind: "rough-surface";
  readonly stepdown: Mm;
  readonly stepover: Ratio;
  readonly stockToLeave: Mm;
  readonly entry: EntrySpec;
  readonly margin: Mm;
}

export interface FinishSurfaceOp extends OperationBase {
  readonly kind: "finish-surface";
  readonly strategy: StrategySpec;
  readonly chordTolerance: Mm;
  readonly margin: Mm;
}

export interface FaceOp extends OperationBase {
  readonly kind: "face";
  readonly area: Box2;
  readonly z: Mm;
  readonly stepover: Ratio;
}

export interface PocketOp extends OperationBase {
  readonly kind: "pocket";
  readonly area: Box2;
  readonly depth: Mm;
  readonly stepdown: Mm;
  readonly stepover: Ratio;
}

export interface DrillOp extends OperationBase {
  readonly kind: "drill";
  readonly points: readonly { readonly x: Mm; readonly y: Mm }[];
  readonly depth: Mm;
  readonly peck?: Mm;
}

export type Operation = RoughSurfaceOp | FinishSurfaceOp | FaceOp | PocketOp | DrillOp;

/* -------------------------------- plan --------------------------------- */

export interface PlanSetup {
  readonly stock: {
    readonly x: Mm; readonly y: Mm; readonly z: Mm;
    readonly originX: Mm; readonly originY: Mm; readonly topZ: Mm;
  };
  readonly clearance: Mm;
  readonly workOffset: string;
  /** Z below which nothing may cut. Usually the stock bottom. */
  readonly floorZ: Mm;
}

export interface ManufacturingPlan {
  readonly setup: PlanSetup;
  readonly operations: readonly Operation[];
  readonly tools: Readonly<Record<ToolId, Tool>>;
}

/* ---------------------------- strategy API ----------------------------- */

/**
 * What a strategy produces: a set of independent paths, in the order it wants
 * them machined. Linking between them is the planner's job, not the strategy's —
 * that separation is what the prototype's `generateJob` collapsed.
 */
export interface ToolpathSet {
  readonly paths: readonly Path<"work">[];
  readonly purpose: CuttingPurpose;
  /** Human-readable summary, e.g. "constant scallop: 47 contours". */
  readonly description: string;
  /** Stepover actually used, for the error budget and UI. */
  readonly stepover: Mm;
  /** Extra diagnostics the strategy wants surfaced. */
  readonly diagnostics?: readonly import("@cam/ir").Diagnostic[];
}

export interface PlanningContext {
  readonly mesh: Mesh;
  readonly tool: Tool;
  readonly setup: PlanSetup;
  readonly bounds: Box2;
  readonly provenance: Provenance;
  readonly signal?: { readonly aborted: boolean };
  progress(fraction: number, note?: string): void;
  /**
   * Memoised CL field. Hybrid and constant-scallop both need one and it costs
   * seconds to build, so the context caches by (inflate, spacing).
   */
  cutterLocationField(spacing: number, inflate?: number): CLField;
  /** Raw CL evaluator, for exact height lookups off the grid. */
  evaluate(inflate?: number): (x: number, y: number) => number;
}

export interface ToolpathStrategy<P = unknown> {
  readonly name: string;
  plan(ctx: PlanningContext, params: P): ToolpathSet;
}
