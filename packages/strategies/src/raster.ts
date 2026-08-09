/**
 * Raster finishing — parallel passes at constant XY spacing.
 *
 * The simplest 3D finishing strategy and still the right answer for shallow,
 * broadly horizontal surfaces. Passes alternate direction (boustrophedon) so the
 * tool never crosses the whole part in free air between rows.
 *
 * Its weakness is structural, not fixable by tuning: constant spacing in XY
 * means passes are far apart MEASURED ALONG a steep wall, so the finish degrades
 * exactly where it is most visible. That is what hybrid-waterline and
 * constant-scallop exist to fix.
 *
 * Design doc: Part IX.5.
 */

import { mm } from "@cam/units";
import { point } from "@cam/math";
import { pathFrom } from "@cam/ir";
import type { Path } from "@cam/ir";
import { radiusOf, stepoverForScallop } from "@cam/machine";
import type { PlanningContext, ToolpathSet } from "@cam/planner";
import { defaultRefineOptions, refineSpan } from "@cam/planner";

export interface RasterParams {
  readonly direction: "X" | "Y";
  /** Ball tools: target cusp height. Ignored for other geometries. */
  readonly scallop?: number;
  /** Non-ball tools: stepover as a fraction of tool diameter. */
  readonly stepover?: number;
  readonly chordTolerance: number;
}

export function planRaster(ctx: PlanningContext, params: RasterParams): ToolpathSet {
  const R = radiusOf(ctx.tool.geometry);
  const step = resolveStepover(ctx, params);
  const evaluate = ctx.evaluate();
  const refine = defaultRefineOptions(R, params.chordTolerance);

  const alongX = params.direction === "X";
  const b = ctx.bounds;

  // Work in an abstract (a, b) frame where `a` runs along the pass direction and
  // `b` steps between passes. `toWorld` is the ONLY place the swap happens —
  // the prototype scattered this across several helpers and it was the easiest
  // thing in the file to get backwards.
  const aLo = alongX ? b.minX : b.minY;
  const aHi = alongX ? b.maxX : b.maxY;
  const bLo = alongX ? b.minY : b.minX;
  const bHi = alongX ? b.maxY : b.maxX;
  const toWorld = alongX
    ? (a: number, s: number): [number, number] => [a, s]
    : (a: number, s: number): [number, number] => [s, a];

  const span = bHi - bLo;
  const rows = Math.max(1, Math.ceil(span / step));
  const rowStep = span / rows;

  const paths: Path<"work">[] = [];

  for (let j = 0; j <= rows; j++) {
    if (ctx.signal?.aborted) break;

    const s = bLo + j * rowStep;
    const forward = j % 2 === 0;
    const aStart = forward ? aLo : aHi;
    const aEnd = forward ? aHi : aLo;

    const [sx, sy] = toWorld(aStart, s);
    const [ex, ey] = toWorld(aEnd, s);
    const sz = evaluate(sx, sy);
    const ez = evaluate(ex, ey);

    const xyz: number[] = [];
    refineSpan(evaluate, sx, sy, sz, ex, ey, ez, refine, xyz);
    if (xyz.length === 0) continue;

    paths.push(
      pathFrom(point(sx, sy, sz, "work"))
        .polyTo(Float64Array.from(xyz))
        .build(),
    );

    if ((j & 7) === 7) ctx.progress(j / rows);
  }

  return {
    paths,
    purpose: "finish",
    description: `raster along ${params.direction}: ${paths.length} passes at ${step.toFixed(3)} mm`,
    stepover: mm(step),
  };
}

/**
 * Resolve the stepover from either a scallop target (ball tools) or an explicit
 * fraction of tool diameter (everything else).
 */
export function resolveStepover(
  ctx: PlanningContext,
  params: { scallop?: number; stepover?: number },
): number {
  const g = ctx.tool.geometry;
  const R = radiusOf(g);

  if (g.type === "ball" && params.scallop !== undefined) {
    return stepoverForScallop(R, params.scallop);
  }
  if (params.stepover !== undefined) {
    return Math.max(0.02, params.stepover * g.diameter);
  }
  // No guidance given: half the diameter is the conventional default.
  return g.diameter * 0.5;
}
