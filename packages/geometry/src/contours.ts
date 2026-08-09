/**
 * @cam/geometry/contours — marching squares with segment chaining.
 *
 * Used twice: to extract constant-Z waterline contours from the CL height field,
 * and to extract iso-scallop contours from the Eikonal arrival-time field.
 *
 * Two details that are easy to get wrong and produce plausible-looking garbage:
 *
 *  1. SADDLE AMBIGUITY. Cases 5 and 10 have two diagonal corners above the level
 *     and two below; the contour can connect either way. Resolving with the
 *     cell-centre average is the standard fix. Getting it wrong makes contours
 *     cross themselves.
 *
 *  2. CHAINING TOLERANCE. Segments are joined by matching endpoints, which means
 *     quantising coordinates to a key. The prototype hid that quantum inside a
 *     string key (`Math.round(x * 256)`); here it is a named constant with an
 *     integer key, so the tolerance is visible and tunable and there is no
 *     string allocation per endpoint.
 *
 * Design doc: Part IX.3.
 */

export interface Polyline {
  /** Interleaved xy pairs. */
  readonly pts: Float64Array;
  readonly closed: boolean;
}

/**
 * Endpoint match tolerance, in millimetres.
 *
 * Marching-squares endpoints that should join are computed from the same edge
 * interpolation in both cells, so they agree to floating-point precision. This
 * only needs to absorb rounding, hence a value far below any geometric feature
 * size. Too large and distinct contours merge; too small and contours fragment.
 */
export const CHAIN_TOLERANCE = 1e-6;

const QUANT = 1 / CHAIN_TOLERANCE;

/** Pack two quantised coordinates into one integer key, avoiding string churn. */
function endpointKey(x: number, y: number): number {
  // 2^26 keeps the product inside the exact-integer range of a double.
  const qx = Math.round(x * QUANT) % 67108864;
  const qy = Math.round(y * QUANT) % 67108864;
  return qx * 67108864 + qy;
}

/**
 * Extract iso-contours of `A` at `level`.
 *
 * `A` is a row-major grid of (nx+1) x (ny+1) samples with the given origin and
 * spacing. Returns chained polylines, closed where the contour forms a loop.
 */
export function marchingSquares(
  A: Float64Array,
  nx: number,
  ny: number,
  x0: number,
  y0: number,
  spacing: number,
  level: number,
): Polyline[] {
  const stride = nx + 1;
  // Flat segment list: x1, y1, x2, y2 per segment.
  const segs: number[] = [];

  /** Interpolate the crossing fraction between two opposite-sign values. */
  const frac = (va: number, vb: number) => va / (va - vb);

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v00 = A[j * stride + i] - level;
      const v10 = A[j * stride + i + 1] - level;
      const v11 = A[(j + 1) * stride + i + 1] - level;
      const v01 = A[(j + 1) * stride + i] - level;

      const code =
        (v00 > 0 ? 1 : 0) | (v10 > 0 ? 2 : 0) | (v11 > 0 ? 4 : 0) | (v01 > 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;

      const cx = x0 + i * spacing;
      const cy = y0 + j * spacing;

      // Crossing points on the four cell edges: 0 bottom, 1 right, 2 top, 3 left.
      const ex = [
        cx + frac(v00, v10) * spacing, cy,
        cx + spacing, cy + frac(v10, v11) * spacing,
        cx + frac(v01, v11) * spacing, cy + spacing,
        cx, cy + frac(v00, v01) * spacing,
      ];
      /**
       * Emit one contour segment, skipping degenerate ones.
       *
       * When a grid node's value lands EXACTLY on the contour level, the edge
       * interpolation puts the crossing precisely on that corner, and two of the
       * cell's edges then produce the same point — a zero-length segment. It
       * carries no geometry and would otherwise chain into a spurious
       * two-identical-point "polyline".
       */
      const emit = (a: number, b: number) => {
        const ax = ex[a * 2], ay = ex[a * 2 + 1];
        const bx = ex[b * 2], by = ex[b * 2 + 1];
        if (Math.abs(ax - bx) < CHAIN_TOLERANCE && Math.abs(ay - by) < CHAIN_TOLERANCE) return;
        segs.push(ax, ay, bx, by);
      };

      switch (code) {
        case 1: case 14: emit(3, 0); break;
        case 2: case 13: emit(0, 1); break;
        case 3: case 12: emit(3, 1); break;
        case 4: case 11: emit(1, 2); break;
        case 6: case 9: emit(0, 2); break;
        case 7: case 8: emit(3, 2); break;
        case 5: {
          // Saddle: resolve with the cell-centre average.
          if ((v00 + v10 + v11 + v01) / 4 > 0) { emit(0, 1); emit(2, 3); }
          else { emit(3, 0); emit(1, 2); }
          break;
        }
        case 10: {
          if ((v00 + v10 + v11 + v01) / 4 > 0) { emit(3, 0); emit(1, 2); }
          else { emit(0, 1); emit(2, 3); }
          break;
        }
        default: break;
      }
    }
  }

  return chain(segs);
}

/**
 * Join segments end-to-end into polylines.
 *
 * Builds a multimap from quantised endpoint to (segment, which end), then walks
 * each unused segment forwards and backwards until it can extend no further.
 */
export function chain(segs: readonly number[]): Polyline[] {
  const count = segs.length / 4;
  if (count === 0) return [];

  const ends = new Map<number, number[]>();
  const record = (key: number, code: number) => {
    const bucket = ends.get(key);
    if (bucket) bucket.push(code);
    else ends.set(key, [code]);
  };
  for (let s = 0; s < count; s++) {
    // Encode (segment, end) as a single integer: s*2 + end.
    record(endpointKey(segs[s * 4], segs[s * 4 + 1]), s * 2);
    record(endpointKey(segs[s * 4 + 2], segs[s * 4 + 3]), s * 2 + 1);
  }

  const used = new Uint8Array(count);
  const out: Polyline[] = [];

  for (let s0 = 0; s0 < count; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;

    // Doubly-ended growth: a deque of xy pairs.
    let pts: number[] = [segs[s0 * 4], segs[s0 * 4 + 1], segs[s0 * 4 + 2], segs[s0 * 4 + 3]];

    for (const forward of [true, false]) {
      for (;;) {
        const n = pts.length / 2;
        const hx = forward ? pts[(n - 1) * 2] : pts[0];
        const hy = forward ? pts[(n - 1) * 2 + 1] : pts[1];
        const bucket = ends.get(endpointKey(hx, hy));
        if (!bucket) break;

        let next = -1;
        for (const code of bucket) {
          if (!used[code >> 1]) { next = code; break; }
        }
        if (next === -1) break;

        const si = next >> 1;
        const end = next & 1;
        used[si] = 1;
        // Append the segment's OTHER end.
        const ox = segs[si * 4 + (1 - end) * 2];
        const oy = segs[si * 4 + (1 - end) * 2 + 1];
        if (forward) pts.push(ox, oy);
        else pts = [ox, oy, ...pts];
      }
    }

    const n = pts.length / 2;
    if (n < 2) continue;
    const closed =
      endpointKey(pts[0], pts[1]) === endpointKey(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]);
    // A "closed" chain of two coincident points is degenerate, not a loop.
    if (closed && n === 2) continue;
    out.push({ pts: Float64Array.from(pts), closed });
  }

  return out;
}

/**
 * Split a polyline into the runs where `keep` holds.
 *
 * Used by the hybrid strategy to trim waterline contours to steep regions only.
 * A loop that survives entirely stays closed; anything else becomes open runs.
 */
export function splitByMask(
  poly: Polyline,
  keep: (x: number, y: number) => boolean,
  minPoints = 2,
): Polyline[] {
  const n = poly.pts.length / 2;
  // A closed polyline repeats its first point at the end; do not double-count it.
  const limit = poly.closed ? n - 1 : n;

  const runs: number[][] = [];
  let current: number[] | null = null;
  let startsAtZero = false;

  for (let i = 0; i < limit; i++) {
    const x = poly.pts[i * 2];
    const y = poly.pts[i * 2 + 1];
    if (keep(x, y)) {
      if (!current) {
        current = [];
        runs.push(current);
        if (i === 0) startsAtZero = true;
      }
      current.push(x, y);
    } else {
      current = null;
    }
  }

  // Entire loop kept: preserve closedness rather than emitting an open copy.
  if (runs.length === 1 && poly.closed && runs[0].length / 2 === limit) {
    const pts = Float64Array.from([...runs[0], runs[0][0], runs[0][1]]);
    return [{ pts, closed: true }];
  }

  // On a CLOSED loop, index 0 and index limit-1 are adjacent, so a run ending at
  // the last point and one starting at the first are really one run that happens
  // to straddle the array seam. Splitting them would cut a contour in half and
  // make the planner lift the tool in the middle of a perfectly good pass.
  if (poly.closed && runs.length > 1 && startsAtZero && current !== null) {
    const first = runs.shift()!;
    runs[runs.length - 1] = [...runs[runs.length - 1], ...first];
  }

  return runs
    .filter((r) => r.length / 2 >= minPoints)
    .map((r) => ({ pts: Float64Array.from(r), closed: false }));
}

/** Total 2D length of a polyline. */
export function polylineLength(p: Polyline): number {
  let L = 0;
  for (let i = 1; i < p.pts.length / 2; i++) {
    L += Math.hypot(p.pts[i * 2] - p.pts[(i - 1) * 2], p.pts[i * 2 + 1] - p.pts[(i - 1) * 2 + 1]);
  }
  return L;
}

/** Reverse a polyline in place-ish (returns a new one). */
export function reversePolyline(p: Polyline): Polyline {
  const n = p.pts.length / 2;
  const out = new Float64Array(p.pts.length);
  for (let i = 0; i < n; i++) {
    out[i * 2] = p.pts[(n - 1 - i) * 2];
    out[i * 2 + 1] = p.pts[(n - 1 - i) * 2 + 1];
  }
  return { pts: out, closed: p.closed };
}
