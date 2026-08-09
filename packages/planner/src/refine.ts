/**
 * @cam/planner/refine — adaptive chord refinement.
 *
 * A straight line between two points on a curved surface deviates from that
 * surface in the middle. Refinement subdivides until the deviation is under
 * tolerance, so the emitted polyline is guaranteed to track the real geometry.
 *
 * This is the standard adaptive-subdivision idiom, and the guarantee it provides
 * is what the error budget's "chord-refinement" contribution is claiming.
 *
 * Design doc: Part IX.5.
 */

export interface RefineOptions {
  /** Maximum allowed deviation from the true surface, in mm. */
  readonly tolerance: number;
  /** Always subdivide segments longer than this, even if flat. */
  readonly maxSegment: number;
  /** Never subdivide below this length. */
  readonly minSegment: number;
  /** Recursion bound. 11 levels allows 2048 points per input span. */
  readonly maxDepth: number;
}

export const defaultRefineOptions = (toolRadius: number, tolerance: number): RefineOptions => ({
  tolerance,
  // Longer segments than about a tool radius are refined regardless of measured
  // deviation, because midpoint sampling can miss a feature entirely between two
  // points that happen to agree.
  maxSegment: Math.min(Math.max(toolRadius, 0.6), 3),
  minSegment: Math.max(0.04, tolerance * 2),
  maxDepth: 11,
});

/**
 * Refine a straight span across a height field, appending xyz to `out`.
 *
 * The start point is NOT emitted — callers already have it. This makes chaining
 * spans trivial and avoids duplicate points at joins.
 */
export function refineSpan(
  evaluate: (x: number, y: number) => number,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  opts: RefineOptions,
  out: number[],
): void {
  recurse(evaluate, x0, y0, z0, x1, y1, z1, opts, opts.maxDepth, out);
}

function recurse(
  evaluate: (x: number, y: number) => number,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  opts: RefineOptions,
  depth: number,
  out: number[],
): void {
  const len = Math.hypot(x1 - x0, y1 - y0);

  if (depth <= 0 || len < opts.minSegment) {
    out.push(x1, y1, z1);
    return;
  }

  const xm = (x0 + x1) / 2;
  const ym = (y0 + y1) / 2;
  const zm = evaluate(xm, ym);
  // Deviation of the linear interpolant from the true surface at the midpoint.
  const deviation = Math.abs(zm - (z0 + z1) / 2);

  if (len > opts.maxSegment || deviation > opts.tolerance) {
    recurse(evaluate, x0, y0, z0, xm, ym, zm, opts, depth - 1, out);
    recurse(evaluate, xm, ym, zm, x1, y1, z1, opts, depth - 1, out);
  } else {
    out.push(x1, y1, z1);
  }
}

/**
 * Refine a whole 2D polyline onto a surface, returning interleaved xyz.
 *
 * Used to lift contour polylines (which are flat XY curves) onto the exact CL
 * surface rather than trusting the interpolated field value — the field decides
 * WHERE to cut, the evaluator decides HOW DEEP.
 */
export function liftPolyline(
  evaluate: (x: number, y: number) => number,
  pts: Float64Array,
  opts: RefineOptions,
): Float64Array {
  const n = pts.length / 2;
  if (n === 0) return new Float64Array(0);

  const out: number[] = [];
  let px = pts[0];
  let py = pts[1];
  let pz = evaluate(px, py);
  out.push(px, py, pz);

  for (let i = 1; i < n; i++) {
    const qx = pts[i * 2];
    const qy = pts[i * 2 + 1];
    const qz = evaluate(qx, qy);
    refineSpan(evaluate, px, py, pz, qx, qy, qz, opts, out);
    px = qx; py = qy; pz = qz;
  }

  return Float64Array.from(out);
}

/** Lift a 2D polyline to a constant Z, without refinement. Waterline passes. */
export function liftToLevel(pts: Float64Array, z: number): Float64Array {
  const n = pts.length / 2;
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = pts[i * 2];
    out[i * 3 + 1] = pts[i * 2 + 1];
    out[i * 3 + 2] = z;
  }
  return out;
}
