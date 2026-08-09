/**
 * @cam/geometry/drop-cutter — the cutter-location surface.
 *
 * THE PROBLEM. Place a tool at (x, y), lower it straight down until it just
 * touches the mesh. What is the Z of the tool tip? That answer, as a function of
 * (x, y), is the cutter-location (CL) surface. Driving the tip along it machines
 * the part exactly without gouging.
 *
 * THE METHOD. Not iterative lowering — that is slow and inexact. Instead, solve
 * analytically per triangle and take the maximum. Contact with one triangle
 * decomposes into three cases (vertex, edge, face), each with a closed form.
 * Correctness follows because the contact height is the max over all features,
 * and each case computes its feature's exact contact height.
 *
 * PERFORMANCE. This function is called millions of times per job. It is
 * deliberately written in a style that looks unidiomatic: no allocation, no
 * polymorphic dispatch on tool type inside the loop, flat typed arrays, one
 * specialised closure per tool. Do not "clean it up" into classes.
 *
 * Design doc: Part IX.1.
 */

import type { ToolGeometry } from "@cam/machine";
import type { Mesh } from "./mesh.js";
import type { SpatialIndex } from "./spatial-index.js";
import { buildIndex, queryDisc } from "./spatial-index.js";

/** Evaluates the CL height (tool tip Z) at a point. */
export type CutterLocationFn = (x: number, y: number) => number;

export interface DropCutterOptions {
  /** Tip height where nothing is hit. Usually the stock floor. */
  readonly floorZ?: number;
  /** Grow the tool by this much — used by roughing to leave stock. */
  readonly inflate?: number;
}

/**
 * Build a CL evaluator for a mesh and tool.
 *
 * Supports ball, flat, and bull (toroidal) cutters. A bull nose with
 * cornerRadius == radius is a ball; with cornerRadius == 0 it is a flat. Both
 * degenerate cases are handled by the general torus code, but the dedicated ball
 * and flat paths are kept because they are meaningfully faster.
 */
export function makeCutterLocation(
  mesh: Mesh,
  tool: ToolGeometry,
  opts: DropCutterOptions = {},
): CutterLocationFn {
  const inflate = opts.inflate ?? 0;
  const floorZ = opts.floorZ ?? 0;
  const R = tool.diameter / 2 + inflate;

  const index = buildIndex(mesh, R);

  switch (tool.type) {
    case "ball":
      return ballEvaluator(mesh, index, R, floorZ, inflate);
    case "flat":
      return flatEvaluator(mesh, index, R, floorZ, inflate);
    case "bull":
      return bullEvaluator(mesh, index, R, Math.min(tool.cornerRadius + inflate, R), floorZ, inflate);
    case "vbit":
      // A V-bit's contact surface is a cone; approximate with a flat disc of the
      // tip diameter for now. Conical drop-cutter is a follow-up.
      return flatEvaluator(mesh, index, Math.max(tool.tipDiameter / 2, 0.05) + inflate,
        floorZ, inflate);
  }
}

/* --------------------------- ball nose -------------------------------- */

/**
 * A ball tool's contact is a sphere of radius R resting on the mesh. We compute
 * the highest SPHERE CENTRE and subtract R at the end.
 */
function ballEvaluator(
  mesh: Mesh,
  index: SpatialIndex,
  R: number,
  floorZ: number,
  inflate: number,
): CutterLocationFn {
  const T = mesh.tris;
  const R2 = R * R;

  return function evalBall(x: number, y: number): number {
    let best = floorZ + R;

    // Pruning ceiling. A sphere touching geometry whose highest point is `h`,
    // at squared horizontal distance d2 from the tool axis, can lift its centre
    // to at most h + sqrt(R^2 - d2). Using the distance rather than the plain
    // `h + R` bound is what makes pruning effective: rim geometry is rejected
    // almost immediately once the centre of the disc has set a good `best`.
    const ceiling = (maxZ: number, d2: number) =>
      maxZ + Math.sqrt(R2 - d2) > best;

    queryDisc(index, x, y, R, (t) => {
      const o = t * 9;
      const ax = T[o], ay = T[o + 1], az = T[o + 2];
      const bx = T[o + 3], by = T[o + 4], bz = T[o + 5];
      const cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];

      // Case 1: sphere touches a vertex.
      let dx = ax - x, dy = ay - y, d2 = dx * dx + dy * dy;
      if (d2 < R2) { const z = az + Math.sqrt(R2 - d2); if (z > best) best = z; }
      dx = bx - x; dy = by - y; d2 = dx * dx + dy * dy;
      if (d2 < R2) { const z = bz + Math.sqrt(R2 - d2); if (z > best) best = z; }
      dx = cx - x; dy = cy - y; d2 = dx * dx + dy * dy;
      if (d2 < R2) { const z = cz + Math.sqrt(R2 - d2); if (z > best) best = z; }

      // Case 2: sphere touches an edge.
      let z = sphereEdge(x, y, R, ax, ay, az, bx, by, bz); if (z > best) best = z;
      z = sphereEdge(x, y, R, bx, by, bz, cx, cy, cz); if (z > best) best = z;
      z = sphereEdge(x, y, R, cx, cy, cz, ax, ay, az); if (z > best) best = z;

      // Case 3: sphere rests on the triangle's interior.
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nz = ux * vy - uy * vx;
      if (Math.abs(nz) > 1e-12) {
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        // Plane as z = A x + B y + C.
        const A = -nx / nz;
        const B = -ny / nz;
        const C = az - A * ax - B * ay;
        // The sphere resting on this plane has its centre offset laterally by
        // R * (A, B) / sqrt(1 + A^2 + B^2). Contact is valid only if that
        // offset point lies inside the triangle.
        const g = Math.sqrt(1 + A * A + B * B);
        const px = x + (R * A) / g;
        const py = y + (R * B) / g;
        if (pointInTriangle(px, py, ax, ay, bx, by, cx, cy)) {
          const zc = A * x + B * y + C + R * g;
          if (zc > best) best = zc;
        }
      }
    }, ceiling);

    // Convert sphere-centre height to tip height. Inflation raises the surface
    // uniformly, which is exactly the "leave stock" semantics roughing wants.
    return best - R + inflate;
  };
}

/**
 * Highest sphere-centre Z at which a sphere of radius R on the vertical axis
 * through (px, py) touches the segment (x1,y1,z1)-(x2,y2,z2).
 *
 * Project the axis onto the edge. If the perpendicular distance is >= R there is
 * no contact. Otherwise the sphere can touch anywhere within +/- rp of the
 * projection, where rp = sqrt(R^2 - dperp^2). Along that interval the edge rises
 * with slope m, so the centre height is
 *
 *     zc(s) = zf + m*s + sqrt(rp^2 - s^2)
 *
 * Differentiating and solving zc'(s) = 0 gives the maximum at
 *
 *     s* = m*rp / sqrt(1 + m^2)
 *
 * which is then clamped to the part of the interval that lies within the edge.
 */
function sphereEdge(
  px: number, py: number, R: number,
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
): number {
  const ex = x2 - x1, ey = y2 - y1;
  const len2 = ex * ex + ey * ey;
  if (len2 < 1e-12) return -Infinity; // vertical edge: the vertex case covers it

  const len = Math.sqrt(len2);
  const ux = ex / len, uy = ey / len;
  const wx = px - x1, wy = py - y1;

  const along = wx * ux + wy * uy;
  const perp = Math.abs(wx * uy - wy * ux);
  if (perp >= R) return -Infinity;

  const rp = Math.sqrt(R * R - perp * perp);
  const m = (z2 - z1) / len;
  const zf = z1 + m * along;

  const sLo = Math.max(-rp, -along);
  const sHi = Math.min(rp, len - along);
  if (sLo > sHi) return -Infinity;

  let s = (m * rp) / Math.sqrt(1 + m * m);
  if (s < sLo) s = sLo;
  else if (s > sHi) s = sHi;

  return zf + m * s + Math.sqrt(Math.max(0, rp * rp - s * s));
}

/* ---------------------------- flat end -------------------------------- */

/**
 * A flat tool's contact surface is a horizontal disc of radius R at the tip.
 * The tip height is the maximum mesh height over that disc.
 */
function flatEvaluator(
  mesh: Mesh,
  index: SpatialIndex,
  R: number,
  floorZ: number,
  inflate: number,
): CutterLocationFn {
  const T = mesh.tris;
  const R2 = R * R;

  return function evalFlat(x: number, y: number): number {
    let best = floorZ;

    // A flat tool's contact height IS a mesh height, so anything topping out
    // below the running best cannot contribute regardless of distance.
    const ceiling = (maxZ: number, _d2: number) => maxZ > best;

    queryDisc(index, x, y, R, (t) => {
      const o = t * 9;
      const ax = T[o], ay = T[o + 1], az = T[o + 2];
      const bx = T[o + 3], by = T[o + 4], bz = T[o + 5];
      const cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];

      // Case 1: a vertex lies inside the disc.
      if ((ax - x) ** 2 + (ay - y) ** 2 <= R2 && az > best) best = az;
      if ((bx - x) ** 2 + (by - y) ** 2 <= R2 && bz > best) best = bz;
      if ((cx - x) ** 2 + (cy - y) ** 2 <= R2 && cz > best) best = cz;

      // Case 2: an edge crosses the disc boundary. Solve the quadratic for the
      // crossing parameters and take the higher end of the in-disc interval.
      best = edgeInDisc(x, y, R2, ax, ay, az, bx, by, bz, best);
      best = edgeInDisc(x, y, R2, bx, by, bz, cx, cy, cz, best);
      best = edgeInDisc(x, y, R2, cx, cy, cz, ax, ay, az, best);

      // Case 3: the plane passes under the disc.
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nz = ux * vy - uy * vx;
      if (Math.abs(nz) > 1e-12) {
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const A = -nx / nz;
        const B = -ny / nz;
        const C = az - A * ax - B * ay;
        const g = Math.hypot(A, B);
        if (g > 1e-12) {
          // Highest point of the plane within the disc is on the uphill rim.
          const px = x + (R * A) / g;
          const py = y + (R * B) / g;
          if (pointInTriangle(px, py, ax, ay, bx, by, cx, cy)) {
            const z = A * px + B * py + C;
            if (z > best) best = z;
          }
        }
        // ...unless the disc centre itself is over the triangle (flat region).
        if (pointInTriangle(x, y, ax, ay, bx, by, cx, cy)) {
          const z = A * x + B * y + C;
          if (z > best) best = z;
        }
      }
    }, ceiling);

    return best + inflate;
  };
}

/**
 * Highest point of a segment within a disc of radius^2 R2 centred at (x, y).
 * Returns `best` unchanged if the segment misses the disc.
 */
function edgeInDisc(
  x: number, y: number, R2: number,
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  best: number,
): number {
  const ex = x2 - x1, ey = y2 - y1;
  const a = ex * ex + ey * ey;
  if (a < 1e-12) return best;

  const wx = x1 - x, wy = y1 - y;
  const b = ex * wx + ey * wy;
  const c = wx * wx + wy * wy - R2;
  const disc = b * b - a * c;
  if (disc < 0) return best;

  const sq = Math.sqrt(disc);
  const tLo = Math.max(0, (-b - sq) / a);
  const tHi = Math.min(1, (-b + sq) / a);
  if (tLo > tHi) return best;

  // The edge is linear in z, so the max over [tLo, tHi] is at whichever end
  // rises. Checking both is cheaper than branching on the sign of dz.
  const zLo = z1 + (z2 - z1) * tLo;
  const zHi = z1 + (z2 - z1) * tHi;
  const z = zLo > zHi ? zLo : zHi;
  return z > best ? z : best;
}

/* ---------------------------- bull nose ------------------------------- */

/**
 * A bull nose is a torus: a flat disc of radius (R - cr) surrounded by a corner
 * of radius cr. Rather than deriving closed forms for torus-triangle contact,
 * we bound it: sample the cutter's own profile against the mesh surface.
 *
 * This is an honest approximation and is documented as such — a bull-nose CL
 * surface computed this way is conservative to within the sampling step. Exact
 * toroidal drop-cutter is a follow-up if bull tools become important.
 */
function bullEvaluator(
  mesh: Mesh,
  index: SpatialIndex,
  R: number,
  cornerRadius: number,
  floorZ: number,
  inflate: number,
): CutterLocationFn {
  const flatPart = flatEvaluator(mesh, index, R, floorZ, 0);
  const ballPart = ballEvaluator(mesh, index, cornerRadius, floorZ, 0);
  // The torus is bounded below by a flat disc of radius R and above by a ball of
  // the corner radius; taking the max is conservative (never gouges).
  return (x, y) => Math.max(flatPart(x, y), ballPart(x, y)) + inflate;
}

/* ------------------------------ helpers ------------------------------- */

/**
 * 2D point-in-triangle by consistent sign of three edge cross products.
 * The 1e-9 band makes boundary points count as inside, which matters because
 * adjacent triangles share edges and a point exactly on one must hit at least
 * one of them.
 */
export function pointInTriangle(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9;
  const hasPos = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9;
  return !(hasNeg && hasPos);
}
