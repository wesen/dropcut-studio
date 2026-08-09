/**
 * @cam/math/vec — plain 3-vectors and boxes.
 *
 * Deliberately not branded and deliberately mutable-free: these are the raw
 * numeric workhorses. Frame-tagged points live in `frames.ts` and wrap these.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A Vec3 asserted to have unit length. Construct via `normalize`. */
export type UnitVec3 = Vec3 & { readonly __unit?: true };

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const ZERO: Vec3 = vec3(0, 0, 0);
export const X_AXIS: UnitVec3 = vec3(1, 0, 0);
export const Y_AXIS: UnitVec3 = vec3(0, 1, 0);
export const Z_AXIS: UnitVec3 = vec3(0, 0, 1);

export const add = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number): Vec3 => vec3(a.x * s, a.y * s, a.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const lengthXY = (a: Vec3): number => Math.hypot(a.x, a.y);
export const distance = (a: Vec3, b: Vec3): number => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
export const distanceXY = (a: Vec3, b: Vec3): number => Math.hypot(b.x - a.x, b.y - a.y);

export function normalize(a: Vec3): UnitVec3 {
  const L = length(a);
  if (L < 1e-12) throw new Error("normalize: zero-length vector");
  return vec3(a.x / L, a.y / L, a.z / L);
}

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 =>
  vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

export function nearlyEqual(a: Vec3, b: Vec3, eps = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.z - b.z) <= eps;
}

/* ------------------------------- boxes -------------------------------- */

export interface Box2 {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface Box3 extends Box2 {
  readonly minZ: number;
  readonly maxZ: number;
}

export const box2 = (minX: number, minY: number, maxX: number, maxY: number): Box2 => ({
  minX, minY, maxX, maxY,
});

export const box3 = (
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): Box3 => ({ minX, minY, minZ, maxX, maxY, maxZ });

export const EMPTY_BOX3: Box3 = box3(
  Infinity, Infinity, Infinity,
  -Infinity, -Infinity, -Infinity,
);

export function expandBox3(b: Box3, p: Vec3): Box3 {
  return box3(
    Math.min(b.minX, p.x), Math.min(b.minY, p.y), Math.min(b.minZ, p.z),
    Math.max(b.maxX, p.x), Math.max(b.maxY, p.y), Math.max(b.maxZ, p.z),
  );
}

export function padBox2(b: Box2, m: number): Box2 {
  return box2(b.minX - m, b.minY - m, b.maxX + m, b.maxY + m);
}

export const boxSizeX = (b: Box2): number => b.maxX - b.minX;
export const boxSizeY = (b: Box2): number => b.maxY - b.minY;
export const boxSizeZ = (b: Box3): number => b.maxZ - b.minZ;

export const isEmptyBox3 = (b: Box3): boolean => b.minX > b.maxX;
