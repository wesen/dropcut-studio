/**
 * Constant-scallop finishing — the mathematically satisfying one.
 *
 * Passes are spaced a constant distance apart MEASURED ALONG THE 3D SURFACE, so
 * the cusp height between them is uniform everywhere regardless of slope. On a
 * dome this produces passes that visibly bunch together near the steep flanks
 * and spread out over the flat top, which is exactly right and exactly what a
 * constant-XY raster cannot do.
 *
 * Method: solve |grad T| = sqrt(1 + |grad f|^2) / s0 (see @cam/geometry/eikonal),
 * then take the integer level sets of T as the toolpaths. Each contour is lifted
 * onto the CL surface using the EXACT evaluator rather than the interpolated
 * field — the field says where to cut, the evaluator says how deep.
 *
 * Design doc: Part IX.7.
 */

import { mm } from "@cam/units";
import { point } from "@cam/math";
import type { Path } from "@cam/ir";
import { pathFrom } from "@cam/ir";
import { radiusOf, stepoverForScallop } from "@cam/machine";
import { marchingSquares, maxArrival, scallopSlowness, solveEikonal } from "@cam/geometry";
import type { Polyline } from "@cam/geometry";
import type { PlanningContext, ToolpathSet } from "@cam/planner";
import { defaultRefineOptions, liftPolyline } from "@cam/planner";

export interface ConstantScallopParams {
  readonly scallop: number;
  readonly chordTolerance: number;
  /** Field resolution. Defaults to a fraction of the stepover. */
  readonly fieldSpacing?: number;
}

export function planConstantScallop(
  ctx: PlanningContext,
  params: ConstantScallopParams,
): ToolpathSet {
  const R = radiusOf(ctx.tool.geometry);
  const step = ctx.tool.geometry.type === "ball"
    ? stepoverForScallop(R, params.scallop)
    : ctx.tool.geometry.diameter * 0.4;

  // The field must resolve features smaller than the stepover, or the level sets
  // will be quantised to the grid and the spacing guarantee breaks down.
  const spacing = params.fieldSpacing ?? Math.min(0.6, Math.max(0.15, step * 0.75));
  const field = ctx.cutterLocationField(spacing);
  ctx.progress(0.4, "solving eikonal");

  const T = solveEikonal(
    scallopSlowness(field.G, step),
    field.nx, field.ny, field.spacing,
  );

  const levels = Math.floor(maxArrival(T) - 0.4);
  const evaluate = ctx.evaluate();
  const refine = defaultRefineOptions(R, params.chordTolerance);

  const paths: Path<"work">[] = [];
  let cursorX = Number.NaN;
  let cursorY = Number.NaN;

  for (let level = 1; level <= levels; level++) {
    if (ctx.signal?.aborted) break;

    const contours = marchingSquares(
      T, field.nx, field.ny, field.x0, field.y0, field.spacing, level,
    );

    for (const raw of contours) {
      const oriented = orientForCursor(raw, cursorX, cursorY);
      if (oriented.pts.length < 4) continue;

      const xyz = liftPolyline(evaluate, oriented.pts, refine);
      if (xyz.length < 6) continue;

      paths.push(
        pathFrom(point(xyz[0], xyz[1], xyz[2], "work"))
          .polyTo(xyz.subarray(3))
          .build(),
      );
      cursorX = xyz[xyz.length - 3];
      cursorY = xyz[xyz.length - 2];
    }

    if ((level & 3) === 3) ctx.progress(0.4 + (0.6 * level) / Math.max(1, levels));
  }

  return {
    paths,
    purpose: "finish",
    description: `constant scallop: ${paths.length} iso-scallop contours at ${step.toFixed(3)} mm`,
    stepover: mm(step),
  };
}

/**
 * Rotate a closed contour so it starts nearest the tool's current position, or
 * reverse an open one if its far end is closer.
 *
 * This is a cheap greedy travelling-salesman heuristic. It matters: without it,
 * every contour starts at whatever point marching squares happened to emit
 * first, and the tool makes a long rapid to reach it on every single pass.
 */
function orientForCursor(poly: Polyline, cx: number, cy: number): Polyline {
  const n = poly.pts.length / 2;
  if (n < 2 || Number.isNaN(cx)) return poly;

  if (!poly.closed) {
    const dStart = Math.hypot(poly.pts[0] - cx, poly.pts[1] - cy);
    const dEnd = Math.hypot(poly.pts[(n - 1) * 2] - cx, poly.pts[(n - 1) * 2 + 1] - cy);
    if (dEnd >= dStart) return poly;
    const out = new Float64Array(poly.pts.length);
    for (let i = 0; i < n; i++) {
      out[i * 2] = poly.pts[(n - 1 - i) * 2];
      out[i * 2 + 1] = poly.pts[(n - 1 - i) * 2 + 1];
    }
    return { pts: out, closed: false };
  }

  // Closed: find the nearest vertex and rotate the loop to begin there.
  const unique = n - 1; // last point repeats the first
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < unique; i++) {
    const d = Math.hypot(poly.pts[i * 2] - cx, poly.pts[i * 2 + 1] - cy);
    if (d < bestD) { bestD = d; best = i; }
  }

  const out = new Float64Array((unique + 1) * 2);
  for (let k = 0; k <= unique; k++) {
    const src = (best + k) % unique;
    out[k * 2] = poly.pts[src * 2];
    out[k * 2 + 1] = poly.pts[src * 2 + 1];
  }
  return { pts: out, closed: true };
}
