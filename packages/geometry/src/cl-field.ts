/**
 * @cam/geometry/cl-field — a sampled cutter-location surface.
 *
 * Sampling the drop-cutter evaluator onto a regular grid gives two fields:
 *
 *   F  the CL height, i.e. the surface the tool tip must follow
 *   G  |grad F|, the local slope magnitude
 *
 * G is what separates SHALLOW from STEEP regions, and it drives both the hybrid
 * strategy's region split and the constant-scallop speed function. Building the
 * field once and sharing it is important: it costs seconds, and two of the three
 * finishing strategies need it.
 *
 * Design doc: Part IX.2.
 */

import type { Box2 } from "@cam/math";
import type { CutterLocationFn } from "./drop-cutter.js";

export interface CLField {
  /** Cell counts; the sample arrays are (nx+1) x (ny+1). */
  readonly nx: number;
  readonly ny: number;
  readonly spacing: number;
  readonly x0: number;
  readonly y0: number;
  /** CL heights, row-major, stride nx+1. */
  readonly F: Float64Array;
  /** |grad F| at each node. */
  readonly G: Float64Array;
}

export interface BuildFieldOptions {
  readonly signal?: { readonly aborted: boolean };
  /** Called with 0..1 after each row block. */
  readonly onProgress?: (fraction: number) => void;
}

/**
 * Sample the CL surface over `bounds` at `spacing`.
 *
 * Synchronous and CPU-bound by design — this runs in a worker, so it must not
 * be littered with `await` yields the way the single-threaded prototype was.
 * Cancellation is cooperative via `signal`, checked once per row.
 */
export function buildCLField(
  evaluate: CutterLocationFn,
  bounds: Box2,
  spacing: number,
  opts: BuildFieldOptions = {},
): CLField | null {
  const nx = Math.max(4, Math.ceil((bounds.maxX - bounds.minX) / spacing));
  const ny = Math.max(4, Math.ceil((bounds.maxY - bounds.minY) / spacing));
  const stride = nx + 1;

  const F = new Float64Array(stride * (ny + 1));

  for (let j = 0; j <= ny; j++) {
    const y = bounds.minY + j * spacing;
    const row = j * stride;
    for (let i = 0; i <= nx; i++) {
      F[row + i] = evaluate(bounds.minX + i * spacing, y);
    }
    if ((j & 7) === 7) {
      if (opts.signal?.aborted) return null;
      opts.onProgress?.(j / ny);
    }
  }

  return {
    nx, ny, spacing,
    x0: bounds.minX, y0: bounds.minY,
    F,
    G: gradientMagnitude(F, nx, ny, spacing),
  };
}

/**
 * |grad F| by central differences, one-sided at the boundary.
 *
 * The boundary values are slightly underestimated. That is harmless here because
 * fields are always built with a margin around the part, so the boundary sits
 * over flat floor where the gradient is zero anyway.
 */
export function gradientMagnitude(
  F: Float64Array,
  nx: number,
  ny: number,
  spacing: number,
): Float64Array {
  const stride = nx + 1;
  const G = new Float64Array(F.length);
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const ip = Math.min(nx, i + 1);
      const im = Math.max(0, i - 1);
      const jp = Math.min(ny, j + 1);
      const jm = Math.max(0, j - 1);
      const gx = (F[j * stride + ip] - F[j * stride + im]) / ((ip - im) * spacing);
      const gy = (F[jp * stride + i] - F[jm * stride + i]) / ((jp - jm) * spacing);
      G[j * stride + i] = Math.hypot(gx, gy);
    }
  }
  return G;
}

/** Bilinear sample of a field array. Clamps to the grid. */
export function sampleField(field: CLField, A: Float64Array, x: number, y: number): number {
  const { nx, ny, spacing, x0, y0 } = field;
  let u = (x - x0) / spacing;
  let v = (y - y0) / spacing;
  u = u < 0 ? 0 : u > nx - 1e-6 ? nx - 1e-6 : u;
  v = v < 0 ? 0 : v > ny - 1e-6 ? ny - 1e-6 : v;

  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const stride = nx + 1;

  const a = A[j * stride + i];
  const b = A[j * stride + i + 1];
  const c = A[(j + 1) * stride + i];
  const d = A[(j + 1) * stride + i + 1];

  return a * (1 - fu) * (1 - fv) + b * fu * (1 - fv) + c * (1 - fu) * fv + d * fu * fv;
}

export const sampleHeight = (f: CLField, x: number, y: number) => sampleField(f, f.F, x, y);
export const sampleSlope = (f: CLField, x: number, y: number) => sampleField(f, f.G, x, y);

export function fieldMax(A: Float64Array): number {
  let m = -Infinity;
  for (let i = 0; i < A.length; i++) if (A[i] > m) m = A[i];
  return m;
}

export function fieldMin(A: Float64Array): number {
  let m = Infinity;
  for (let i = 0; i < A.length; i++) if (A[i] < m) m = A[i];
  return m;
}
