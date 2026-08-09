/**
 * @cam/geometry/eikonal — fast sweeping for constant-scallop toolpaths.
 *
 * THE IDEA. We want finishing passes spaced a constant distance apart MEASURED
 * ALONG THE 3D SURFACE, not in the XY plane. That gives uniform scallop height
 * everywhere: on a steep flank, passes must be closer together in XY to stay the
 * same distance apart on the surface.
 *
 * Define a scalar field T whose level sets are the toolpaths. For consecutive
 * level sets to be s0 apart on the surface, T must satisfy the Eikonal equation
 *
 *     |grad T| = sqrt(1 + |grad f|^2) / s0
 *
 * where the numerator is the surface's area element — the factor by which a step
 * in XY stretches when measured on the sloped surface. Steep regions get a
 * larger |grad T|, so its level sets bunch closer together in XY. Exactly right.
 *
 * THE SOLVER. Fast sweeping: initialise T = 0 on the boundary and +inf inside,
 * then relax with the Godunov upwind update, sweeping in all four diagonal
 * directions. Characteristics of the Eikonal equation are straight lines, and
 * four alternating sweep directions cover every possible characteristic
 * direction — which is why a fixed number of sweeps converges and there is no
 * iteration-until-stable loop.
 *
 * Design doc: Part IX.7.
 */

const INF = 1e30;

export interface EikonalOptions {
  /**
   * Number of full four-direction sweep rounds. Two is enough for convex
   * domains; the default of four covers the non-convex cases that arise when a
   * part has islands.
   */
  readonly rounds?: number;
  /** Nodes where T is pinned to 0. Defaults to the domain boundary. */
  readonly seeds?: Uint8Array;
}

/**
 * Solve |grad T| = f on a regular grid.
 *
 * `f` is the right-hand side sampled at each node (the "slowness"), `h` the grid
 * spacing. Returns T with the same layout.
 */
export function solveEikonal(
  f: Float64Array,
  nx: number,
  ny: number,
  h: number,
  opts: EikonalOptions = {},
): Float64Array {
  const stride = nx + 1;
  const T = new Float64Array(stride * (ny + 1)).fill(INF);

  if (opts.seeds) {
    for (let k = 0; k < T.length; k++) if (opts.seeds[k]) T[k] = 0;
  } else {
    // Default seed: the domain boundary. Level sets then advance inwards, which
    // is what a finishing strategy wants — passes march in from the outside.
    for (let i = 0; i <= nx; i++) {
      T[i] = 0;
      T[ny * stride + i] = 0;
    }
    for (let j = 0; j <= ny; j++) {
      T[j * stride] = 0;
      T[j * stride + nx] = 0;
    }
  }

  const rounds = opts.rounds ?? 4;

  /**
   * Godunov upwind update at one node.
   *
   * With a and b the smaller neighbours along x and y, and fh = f*h:
   *   if |a - b| >= fh the characteristic is axis-aligned, so T = min(a,b) + fh
   *   otherwise it arrives diagonally and T solves the quadratic
   *       (T-a)^2 + (T-b)^2 = fh^2
   */
  const update = (i: number, j: number) => {
    const k = j * stride + i;
    const a = Math.min(
      i > 0 ? T[k - 1] : INF,
      i < nx ? T[k + 1] : INF,
    );
    const b = Math.min(
      j > 0 ? T[k - stride] : INF,
      j < ny ? T[k + stride] : INF,
    );
    const fh = f[k] * h;

    let t: number;
    if (Math.abs(a - b) >= fh) {
      t = Math.min(a, b) + fh;
    } else {
      const diff = a - b;
      t = (a + b + Math.sqrt(2 * fh * fh - diff * diff)) / 2;
    }
    if (t < T[k]) T[k] = t;
  };

  for (let r = 0; r < rounds; r++) {
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) update(i, j);
    for (let j = 0; j <= ny; j++) for (let i = nx; i >= 0; i--) update(i, j);
    for (let j = ny; j >= 0; j--) for (let i = 0; i <= nx; i++) update(i, j);
    for (let j = ny; j >= 0; j--) for (let i = nx; i >= 0; i--) update(i, j);
  }

  return T;
}

/**
 * Build the constant-scallop right-hand side from a slope field.
 *
 *     f = sqrt(1 + |grad z|^2) / s0
 *
 * The square root is the surface area element: a step of length ds in XY covers
 * ds*sqrt(1 + slope^2) of actual surface.
 */
export function scallopSlowness(slope: Float64Array, stepover: number): Float64Array {
  const f = new Float64Array(slope.length);
  const inv = 1 / Math.max(stepover, 1e-6);
  for (let k = 0; k < slope.length; k++) {
    f[k] = Math.sqrt(1 + slope[k] * slope[k]) * inv;
  }
  return f;
}

/** Largest finite arrival time — the number of usable level sets. */
export function maxArrival(T: Float64Array): number {
  let m = 0;
  for (let k = 0; k < T.length; k++) {
    if (T[k] < INF * 0.5 && T[k] > m) m = T[k];
  }
  return m;
}
