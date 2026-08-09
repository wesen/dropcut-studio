/**
 * Hybrid finishing — raster on shallow regions, waterline contours on steep ones.
 *
 * Neither pure strategy is right everywhere. Raster spaces passes evenly in XY,
 * which is correct on a near-horizontal surface and useless on a wall. Constant-Z
 * waterline contours space passes evenly in Z, which is correct on a wall and
 * useless on a flat top (where a single Z level covers everything).
 *
 * So: split the surface by slope and use each where it belongs.
 *
 * The classification band deliberately OVERLAPS. `shallow` accepts up to
 * 1.15*tan(theta) and `steep` accepts down to 0.85*tan(theta), so a band around
 * the threshold gets machined by both. Overlap costs a little time; a gap leaves
 * a visible unmachined ring, which is a scrapped part.
 *
 * Design doc: Part IX.6.
 */

import { mm } from "@cam/units";
import { point } from "@cam/math";
import type { Path } from "@cam/ir";
import { pathFrom } from "@cam/ir";
import { radiusOf } from "@cam/machine";
import { fieldMax, marchingSquares, sampleSlope, splitByMask } from "@cam/geometry";
import type { PlanningContext, ToolpathSet } from "@cam/planner";
import { defaultRefineOptions, liftToLevel, refineSpan } from "@cam/planner";
import { resolveStepover } from "./raster.js";

export interface HybridParams {
  readonly scallop: number;
  /** Slope above which a region counts as steep, in degrees. */
  readonly steepAngle: number;
  readonly direction: "X" | "Y";
  readonly chordTolerance: number;
}

/** Hysteresis on the shallow/steep split. See the module comment. */
const SHALLOW_FACTOR = 1.15;
const STEEP_FACTOR = 0.85;

export function planHybridWaterline(ctx: PlanningContext, params: HybridParams): ToolpathSet {
  const R = radiusOf(ctx.tool.geometry);
  const step = resolveStepover(ctx, { scallop: params.scallop });
  const spacing = Math.min(0.6, Math.max(0.15, step * 0.75));
  const field = ctx.cutterLocationField(spacing);
  const evaluate = ctx.evaluate();
  const refine = defaultRefineOptions(R, params.chordTolerance);

  const tanTheta = Math.tan((Math.max(5, params.steepAngle) * Math.PI) / 180);
  const isShallow = (x: number, y: number) => sampleSlope(field, x, y) <= tanTheta * SHALLOW_FACTOR;
  const isSteep = (x: number, y: number) => sampleSlope(field, x, y) >= tanTheta * STEEP_FACTOR;

  const paths: Path<"work">[] = [];

  /* ---------------- 1. raster the shallow regions ---------------- */

  const b = ctx.bounds;
  const alongX = params.direction === "X";
  const aLo = alongX ? b.minX : b.minY;
  const aHi = alongX ? b.maxX : b.maxY;
  const bLo = alongX ? b.minY : b.minX;
  const bHi = alongX ? b.maxY : b.maxX;
  const toWorld = alongX
    ? (a: number, s: number): [number, number] => [a, s]
    : (a: number, s: number): [number, number] => [s, a];

  const rows = Math.max(1, Math.ceil((bHi - bLo) / step));
  const rowStep = (bHi - bLo) / rows;
  const sampleStep = spacing * 0.75;
  let rasterSpans = 0;

  for (let j = 0; j <= rows; j++) {
    if (ctx.signal?.aborted) break;
    const s = bLo + j * rowStep;
    const forward = j % 2 === 0;

    // Find the intervals along this row where the surface is shallow.
    const intervals: [number, number][] = [];
    let open: number | null = null;
    for (let a = aLo; a <= aHi + 1e-9; a += sampleStep) {
      const aa = Math.min(a, aHi);
      const [wx, wy] = toWorld(aa, s);
      const ok = isShallow(wx, wy);
      if (ok && open === null) open = aa;
      if ((!ok || aa >= aHi) && open !== null) {
        const end = ok ? aa : aa - sampleStep;
        // Discard slivers: a span shorter than two field cells is noise.
        if (end - open > 2 * spacing) intervals.push([open, end]);
        open = null;
      }
      if (aa >= aHi) break;
    }

    for (const iv of forward ? intervals : [...intervals].reverse()) {
      const [aStart, aEnd] = forward ? iv : [iv[1], iv[0]];
      const [sx, sy] = toWorld(aStart, s);
      const [ex, ey] = toWorld(aEnd, s);
      const sz = evaluate(sx, sy);
      const ez = evaluate(ex, ey);

      const xyz: number[] = [];
      refineSpan(evaluate, sx, sy, sz, ex, ey, ez, refine, xyz);
      if (xyz.length === 0) continue;

      paths.push(pathFrom(point(sx, sy, sz, "work")).polyTo(Float64Array.from(xyz)).build());
      rasterSpans++;
    }
    if ((j & 7) === 7) ctx.progress(0.5 * (j / rows));
  }

  /* ---------------- 2. waterline the steep regions ---------------- */

  const topZ = fieldMax(field.F) - 0.6 * step;
  const floor = ctx.setup.floorZ + 0.05;
  const levelCount = Math.max(0, Math.floor((topZ - floor) / step) + 1);
  let waterlineRuns = 0;

  for (let li = 0; li < levelCount; li++) {
    if (ctx.signal?.aborted) break;
    const z = topZ - li * step;

    const contours = marchingSquares(
      field.F, field.nx, field.ny, field.x0, field.y0, field.spacing, z,
    );

    for (const contour of contours) {
      for (const run of splitByMask(contour, isSteep)) {
        if (run.pts.length < 4) continue;
        const xyz = liftToLevel(run.pts, z);
        paths.push(
          pathFrom(point(xyz[0], xyz[1], z, "work")).polyTo(xyz.subarray(3)).build(),
        );
        waterlineRuns++;
      }
    }
    if ((li & 3) === 3) ctx.progress(0.5 + 0.5 * (li / Math.max(1, levelCount)));
  }

  return {
    paths,
    purpose: "finish",
    description:
      `hybrid: ${rasterSpans} raster spans (shallow) + ${waterlineRuns} waterline runs (steep) ` +
      `at ${params.steepAngle}deg`,
    stepover: mm(step),
  };
}
