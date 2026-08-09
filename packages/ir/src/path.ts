/**
 * @cam/ir/path — toolpaths as a category.
 *
 * A path goes from a start pose to an end pose. Two paths compose only if the
 * first's end equals the second's start. Encoding that removes a whole class of
 * discontinuity bug: the prototypes concatenated float arrays and hoped.
 *
 * Arcs carry GEOMETRY — centre, axis, sweep — not G-code's I/J/K offsets and not
 * an ambient plane. Which plane an arc lies in is derived from its axis at post
 * time, so the same arc can be emitted as G17/G18/G19 or linearized away
 * depending on what the target controller can do.
 *
 * Design doc: Part IV.3.
 */

import type { Mm, Radians } from "@cam/units";
import { mm } from "@cam/units";
import type { FrameId, Point3, UnitVec3, Vec3 } from "@cam/math";
import {
  cross, distance, dot, fromVec3, length, point, samePoint, sub, toVec3, vec3,
} from "@cam/math";

/** Tolerance for "these two endpoints are the same point". */
export const JOIN_EPS = 1e-7;

export interface LineSegment<F extends FrameId = FrameId> {
  readonly kind: "line";
  readonly to: Point3<F>;
}

export interface ArcSegment<F extends FrameId = FrameId> {
  readonly kind: "arc";
  readonly to: Point3<F>;
  readonly center: Point3<F>;
  /** Right-handed rotation axis. Sweep is positive about this axis. */
  readonly axis: UnitVec3;
  readonly sweep: Radians;
}

/**
 * Bulk sampled geometry, xyz-interleaved.
 *
 * Strategies like constant-scallop naturally produce thousands of points and
 * boxing each as a LineSegment would be wasteful in both memory and GC churn.
 * Semantically identical to a run of line segments.
 */
export interface PolySegment<F extends FrameId = FrameId> {
  readonly kind: "poly";
  readonly pts: Float64Array;
  readonly frame: F;
}

export type Segment<F extends FrameId = FrameId> =
  | LineSegment<F>
  | ArcSegment<F>
  | PolySegment<F>;

export interface Path<F extends FrameId = FrameId> {
  readonly frame: F;
  readonly start: Point3<F>;
  readonly end: Point3<F>;
  readonly segments: readonly Segment<F>[];
}

/* ----------------------------- construction ---------------------------- */

export function emptyPath<F extends FrameId>(at: Point3<F>): Path<F> {
  return { frame: at.frame, start: at, end: at, segments: [] };
}

/** Terminal point of a segment, given where it starts. */
export function segmentEnd<F extends FrameId>(seg: Segment<F>, from: Point3<F>): Point3<F> {
  if (seg.kind === "poly") {
    const n = seg.pts.length;
    if (n < 3) return from;
    return point(seg.pts[n - 3], seg.pts[n - 2], seg.pts[n - 1], seg.frame);
  }
  return seg.to;
}

/**
 * Builder that maintains the start/end invariant by construction.
 *
 * Using a builder rather than raw object literals means a path can never be
 * created with an `end` that disagrees with its last segment.
 */
export class PathBuilder<F extends FrameId> {
  private readonly segs: Segment<F>[] = [];
  private cursor: Point3<F>;

  constructor(private readonly origin: Point3<F>) {
    this.cursor = origin;
  }

  get current(): Point3<F> {
    return this.cursor;
  }

  lineTo(to: Point3<F>): this {
    if (to.frame !== this.origin.frame) {
      throw new Error(`lineTo: frame mismatch "${to.frame}" vs "${this.origin.frame}"`);
    }
    if (samePoint(to, this.cursor, JOIN_EPS)) return this; // degenerate, drop it
    this.segs.push({ kind: "line", to });
    this.cursor = to;
    return this;
  }

  arcTo(to: Point3<F>, center: Point3<F>, axis: UnitVec3, sweep: Radians): this {
    this.segs.push({ kind: "arc", to, center, axis, sweep });
    this.cursor = to;
    return this;
  }

  /** Append raw xyz-interleaved points. The first point is NOT re-emitted. */
  polyTo(pts: Float64Array): this {
    if (pts.length < 3) return this;
    if (pts.length % 3 !== 0) throw new Error("polyTo: point array length must be a multiple of 3");
    const seg: PolySegment<F> = { kind: "poly", pts, frame: this.origin.frame };
    this.segs.push(seg);
    this.cursor = segmentEnd(seg, this.cursor);
    return this;
  }

  build(): Path<F> {
    return {
      frame: this.origin.frame,
      start: this.origin,
      end: this.cursor,
      segments: this.segs.slice(),
    };
  }

  get isEmpty(): boolean {
    return this.segs.length === 0;
  }
}

export const pathFrom = <F extends FrameId>(at: Point3<F>): PathBuilder<F> => new PathBuilder(at);

/**
 * Category composition. Throws if the paths do not meet — this is the point of
 * the type, and silently inserting a connecting move would hide a planner bug.
 */
export function concat<F extends FrameId>(a: Path<F>, b: Path<F>): Path<F> {
  if (!samePoint(a.end, b.start, JOIN_EPS)) {
    throw new Error(
      `concat: paths do not meet — a ends at (${a.end.x}, ${a.end.y}, ${a.end.z}) ` +
        `but b starts at (${b.start.x}, ${b.start.y}, ${b.start.z})`,
    );
  }
  return {
    frame: a.frame,
    start: a.start,
    end: b.end,
    segments: [...a.segments, ...b.segments],
  };
}

export function concatAll<F extends FrameId>(paths: readonly Path<F>[]): Path<F> {
  if (paths.length === 0) throw new Error("concatAll: needs at least one path");
  return paths.reduce(concat);
}

/** True when every consecutive segment joins exactly. Used in tests and checks. */
export function isContinuous<F extends FrameId>(p: Path<F>, eps = JOIN_EPS): boolean {
  let cur = p.start;
  for (const seg of p.segments) {
    if (seg.kind === "arc" || seg.kind === "line") {
      // Nothing to check on entry; the segment defines its own end.
    }
    cur = segmentEnd(seg, cur);
  }
  return samePoint(cur, p.end, eps);
}

/* ------------------------------- geometry ------------------------------ */

/** Radius of an arc, measured from its start point. */
export function arcRadius<F extends FrameId>(seg: ArcSegment<F>, from: Point3<F>): number {
  return distance(toVec3(from), toVec3(seg.center));
}

/**
 * Sample an arc into points, excluding the start point.
 *
 * `chordTol` bounds the sagitta of each chord: for a circle of radius R and
 * half-angle t, sagitta = R(1 - cos t). Solving for the step that keeps the
 * sagitta under tolerance gives the segment count below.
 */
export function sampleArc<F extends FrameId>(
  seg: ArcSegment<F>,
  from: Point3<F>,
  chordTol = 0.01,
): Point3<F>[] {
  const c = toVec3(seg.center);
  const s = toVec3(from);
  const e = toVec3(seg.to);
  const radial = sub(s, c);
  const R = length(radial);
  if (R < 1e-9) return [seg.to];

  const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - chordTol / R)));
  const n = Math.max(2, Math.ceil(Math.abs(seg.sweep) / Math.max(maxStep, 1e-3)));

  // Orthonormal basis in the arc's plane: u along the start radius, v = axis x u.
  const axis = seg.axis;
  const u = vec3(radial.x / R, radial.y / R, radial.z / R);
  const v = cross(axis, u);
  // Component along the axis (for helical arcs, where start and end differ in height).
  const startAxial = dot(sub(s, c), axis);
  const endAxial = dot(sub(e, c), axis);

  const out: Point3<F>[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const a = seg.sweep * t;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const axial = startAxial + (endAxial - startAxial) * t;
    const p: Vec3 = vec3(
      c.x + R * (u.x * ca + v.x * sa) + axis.x * (axial - startAxial),
      c.y + R * (u.y * ca + v.y * sa) + axis.y * (axial - startAxial),
      c.z + R * (u.z * ca + v.z * sa) + axis.z * (axial - startAxial),
    );
    out.push(fromVec3(p, seg.to.frame));
  }
  // Snap the last sample onto the declared endpoint so paths join exactly.
  out[out.length - 1] = seg.to;
  return out;
}

/** Flatten a path into a polyline, including the start point. */
export function samplePath<F extends FrameId>(p: Path<F>, chordTol = 0.01): Point3<F>[] {
  const out: Point3<F>[] = [p.start];
  let cur = p.start;
  for (const seg of p.segments) {
    if (seg.kind === "line") {
      out.push(seg.to);
      cur = seg.to;
    } else if (seg.kind === "arc") {
      const pts = sampleArc(seg, cur, chordTol);
      out.push(...pts);
      cur = seg.to;
    } else {
      for (let i = 0; i < seg.pts.length; i += 3) {
        out.push(point(seg.pts[i], seg.pts[i + 1], seg.pts[i + 2], seg.frame));
      }
      cur = segmentEnd(seg, cur);
    }
  }
  return out;
}

/** Total 3D arc length of a path. */
export function pathLength<F extends FrameId>(p: Path<F>, chordTol = 0.01): Mm {
  const pts = samplePath(p, chordTol);
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += distance(toVec3(pts[i - 1]), toVec3(pts[i]));
  return mm(L);
}

/**
 * Which axis-aligned plane an arc lies in, or null if it is oblique.
 * Used by the postprocessor to pick G17/G18/G19 — the IR itself never knows.
 */
export function arcPlane(axis: UnitVec3): "XY" | "XZ" | "YZ" | null {
  const ax = Math.abs(axis.x);
  const ay = Math.abs(axis.y);
  const az = Math.abs(axis.z);
  const T = 1e-6;
  if (az > 1 - T && ax < T && ay < T) return "XY";
  if (ay > 1 - T && ax < T && az < T) return "XZ";
  if (ax > 1 - T && ay < T && az < T) return "YZ";
  return null;
}
