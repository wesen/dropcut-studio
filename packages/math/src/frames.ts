/**
 * @cam/math/frames — frame-tagged points and rigid transforms.
 *
 * A `Point3<"work">` and a `Point3<"machine">` are different types, so
 * subtracting one from the other is a compile error rather than a crashed
 * machine. This is the single highest-value type distinction in the system:
 * the prototypes established a part frame implicitly (mesh centred in XY, minZ
 * dropped to 0) and every downstream function silently depended on it.
 *
 * Transforms are elements of SE(3) — rotation plus translation. A 3-axis mill
 * only needs translations today, but designing around SE(3) means 4/5-axis
 * support later does not require replacing the abstraction.
 *
 * Frames and their transforms form a *groupoid*: composition is associative and
 * every transform is invertible. Those laws are property-tested.
 *
 * Design doc: Part IV.2.
 */

import type { Mm } from "@cam/units";
import { mm } from "@cam/units";
import type { Vec3 } from "./vec.js";
import { vec3 } from "./vec.js";

/**
 * Frame identifiers. Open-ended via the string fallback so callers can mint
 * fixture-specific frames (e.g. "fixture:G55") without editing this union.
 */
export type FrameId =
  | "machine"
  | "work"
  | "part"
  | "stock"
  | "mesh"
  | (string & {});

export interface Point3<F extends FrameId = FrameId> {
  readonly x: Mm;
  readonly y: Mm;
  readonly z: Mm;
  readonly frame: F;
}

export function point<F extends FrameId>(x: number, y: number, z: number, frame: F): Point3<F> {
  return { x: mm(x), y: mm(y), z: mm(z), frame };
}

/** Drop the frame tag. Use when handing coordinates to frame-agnostic maths. */
export const toVec3 = (p: Point3): Vec3 => vec3(p.x, p.y, p.z);

/** Attach a frame tag to a raw vector. The caller asserts the frame is correct. */
export const fromVec3 = <F extends FrameId>(v: Vec3, frame: F): Point3<F> =>
  point(v.x, v.y, v.z, frame);

export function samePoint(a: Point3, b: Point3, eps = 1e-9): boolean {
  return (
    a.frame === b.frame &&
    Math.abs(a.x - b.x) <= eps &&
    Math.abs(a.y - b.y) <= eps &&
    Math.abs(a.z - b.z) <= eps
  );
}

/* ---------------------------- transforms ------------------------------ */

/**
 * A rigid transform, stored as a 3x3 rotation in row-major order plus a
 * translation. Full 4x4 matrices buy nothing here — the bottom row of an SE(3)
 * matrix is always [0 0 0 1].
 */
export interface Transform<A extends FrameId = FrameId, B extends FrameId = FrameId> {
  readonly from: A;
  readonly to: B;
  /** Row-major 3x3 rotation: [r00, r01, r02, r10, r11, r12, r20, r21, r22]. */
  readonly r: readonly [number, number, number, number, number, number, number, number, number];
  readonly t: Vec3;
}

const IDENTITY_R = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;

export function identity<F extends FrameId>(frame: F): Transform<F, F> {
  return { from: frame, to: frame, r: IDENTITY_R, t: vec3(0, 0, 0) };
}

/** Pure translation — the common case for work offsets and part placement. */
export function translation<A extends FrameId, B extends FrameId>(
  from: A,
  to: B,
  t: Vec3,
): Transform<A, B> {
  return { from, to, r: IDENTITY_R, t };
}

/** Rotation about +Z by `angle` radians, with an optional translation. */
export function rotationZ<A extends FrameId, B extends FrameId>(
  from: A,
  to: B,
  angle: number,
  t: Vec3 = vec3(0, 0, 0),
): Transform<A, B> {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { from, to, r: [c, -s, 0, s, c, 0, 0, 0, 1], t };
}

/**
 * Apply a transform to a point. The point's frame must match `tf.from`.
 *
 * `NoInfer` on the point is essential: without it TypeScript infers `A` from
 * BOTH arguments and happily widens to a union, so passing a part-frame point to
 * a work-frame transform would type-check. The whole value of frame tagging is
 * that this is an error.
 */
export function apply<A extends FrameId, B extends FrameId>(
  tf: Transform<A, B>,
  p: Point3<NoInfer<A>>,
): Point3<B> {
  if (p.frame !== tf.from) {
    throw new Error(`apply: point is in frame "${p.frame}" but transform expects "${tf.from}"`);
  }
  const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = tf.r;
  return point(
    r00 * p.x + r01 * p.y + r02 * p.z + tf.t.x,
    r10 * p.x + r11 * p.y + r12 * p.z + tf.t.y,
    r20 * p.x + r21 * p.y + r22 * p.z + tf.t.z,
    tf.to,
  );
}

/**
 * Compose two transforms: `A -> B` then `B -> C` gives `A -> C`.
 *
 * Note the argument order matches reading order (first the AB step, then BC),
 * which is the opposite of the usual `g . f` mathematical convention. That is a
 * deliberate ergonomics choice; the associativity law holds either way.
 */
export function compose<A extends FrameId, B extends FrameId, C extends FrameId>(
  ab: Transform<A, B>,
  bc: Transform<NoInfer<B>, C>,
): Transform<A, C> {
  if (ab.to !== bc.from) {
    throw new Error(`compose: cannot chain "${ab.from}->${ab.to}" with "${bc.from}->${bc.to}"`);
  }
  const a = ab.r;
  const b = bc.r;
  const r: [number, number, number, number, number, number, number, number, number] = [
    b[0] * a[0] + b[1] * a[3] + b[2] * a[6],
    b[0] * a[1] + b[1] * a[4] + b[2] * a[7],
    b[0] * a[2] + b[1] * a[5] + b[2] * a[8],
    b[3] * a[0] + b[4] * a[3] + b[5] * a[6],
    b[3] * a[1] + b[4] * a[4] + b[5] * a[7],
    b[3] * a[2] + b[4] * a[5] + b[5] * a[8],
    b[6] * a[0] + b[7] * a[3] + b[8] * a[6],
    b[6] * a[1] + b[7] * a[4] + b[8] * a[7],
    b[6] * a[2] + b[7] * a[5] + b[8] * a[8],
  ];
  // Translation of the composite: rotate ab's translation by bc, then add bc's.
  const t = vec3(
    b[0] * ab.t.x + b[1] * ab.t.y + b[2] * ab.t.z + bc.t.x,
    b[3] * ab.t.x + b[4] * ab.t.y + b[5] * ab.t.z + bc.t.y,
    b[6] * ab.t.x + b[7] * ab.t.y + b[8] * ab.t.z + bc.t.z,
  );
  return { from: ab.from, to: bc.to, r, t };
}

/**
 * Invert a rigid transform. For SE(3) the inverse is the transpose of the
 * rotation with the translation rotated back and negated — no general matrix
 * inversion needed, which is why restricting to rigid motions is worth it.
 */
export function invert<A extends FrameId, B extends FrameId>(
  tf: Transform<A, B>,
): Transform<B, A> {
  const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = tf.r;
  // Transpose.
  const r: [number, number, number, number, number, number, number, number, number] = [
    r00, r10, r20,
    r01, r11, r21,
    r02, r12, r22,
  ];
  const t = vec3(
    -(r[0] * tf.t.x + r[1] * tf.t.y + r[2] * tf.t.z),
    -(r[3] * tf.t.x + r[4] * tf.t.y + r[5] * tf.t.z),
    -(r[6] * tf.t.x + r[7] * tf.t.y + r[8] * tf.t.z),
  );
  return { from: tf.to, to: tf.from, r, t };
}
