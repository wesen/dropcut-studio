/**
 * @cam/geometry/spatial-index — uniform grid over triangle XY bounds.
 *
 * The drop-cutter kernel asks "which triangles are within R of (x, y)?" millions
 * of times per job. A uniform grid answers that in near-constant time for the
 * near-uniform triangle distributions that tessellated surfaces produce, and it
 * builds an order of magnitude faster than a BVH.
 *
 * A triangle spanning several cells is inserted into all of them, so a query can
 * see the same triangle more than once. Deduplication uses a GENERATION STAMP
 * rather than a Set: bump a counter per query, mark each visited triangle with
 * it, skip anything already marked. No allocation per query, which matters when
 * there are millions of them.
 */

import type { Mesh } from "./mesh.js";

export interface SpatialIndex {
  readonly cellSize: number;
  readonly nx: number;
  readonly ny: number;
  readonly minX: number;
  readonly minY: number;
  /** Flat CSR-style storage: cellStart[k]..cellStart[k+1] indexes into cellItems. */
  readonly cellStart: Int32Array;
  readonly cellItems: Int32Array;
  /** Per-triangle XY bounds, 4 per triangle: minX, maxX, minY, maxY. */
  readonly triBounds: Float64Array;
  /**
   * Per-triangle maximum Z, and per-cell maximum Z.
   *
   * These exist purely for drop-cutter pruning. A query maintains a running
   * "best height so far"; any triangle (or whole cell) whose ceiling cannot
   * beat that best can be skipped without touching its geometry. On a dense
   * mesh this is the difference between scanning ~1,400 triangles per query and
   * scanning a few dozen.
   */
  readonly triMaxZ: Float64Array;
  readonly cellMaxZ: Float64Array;
  /** Scratch: last query generation that touched each triangle. */
  readonly stamp: Int32Array;
  generation: number;
}

/**
 * Build the index.
 *
 * Cell size is roughly half the query radius. Cells much larger than that make
 * per-cell Z pruning useless (one tall triangle keeps the whole cell alive);
 * cells much smaller multiply the per-cell loop overhead. Half the radius means
 * a query spans about a 5x5 neighbourhood with useful pruning granularity.
 *
 * Storage is two flat arrays rather than an array-of-arrays. It costs a counting
 * pass but avoids tens of thousands of small array allocations, which on a
 * 100k-triangle mesh is the difference between 300 ms and 3 s.
 */
export function buildIndex(mesh: Mesh, queryRadius: number): SpatialIndex {
  const { tris, triangleCount, bounds } = mesh;
  const spanX = Math.max(1e-6, bounds.maxX - bounds.minX);
  const spanY = Math.max(1e-6, bounds.maxY - bounds.minY);
  const cellSize = Math.max(queryRadius / 2, Math.hypot(spanX, spanY) / 512, 0.15);
  const nx = Math.max(1, Math.ceil(spanX / cellSize));
  const ny = Math.max(1, Math.ceil(spanY / cellSize));
  const cellCount = nx * ny;

  const triBounds = new Float64Array(triangleCount * 4);
  const triMaxZ = new Float64Array(triangleCount);
  const cellMaxZ = new Float64Array(cellCount).fill(-Infinity);
  const counts = new Int32Array(cellCount + 1);

  // Pass 1: per-triangle bounds and per-cell occupancy counts.
  for (let t = 0; t < triangleCount; t++) {
    const o = t * 9;
    const x0 = Math.min(tris[o], tris[o + 3], tris[o + 6]);
    const x1 = Math.max(tris[o], tris[o + 3], tris[o + 6]);
    const y0 = Math.min(tris[o + 1], tris[o + 4], tris[o + 7]);
    const y1 = Math.max(tris[o + 1], tris[o + 4], tris[o + 7]);
    triBounds[t * 4] = x0;
    triBounds[t * 4 + 1] = x1;
    triBounds[t * 4 + 2] = y0;
    triBounds[t * 4 + 3] = y1;

    const zMax = Math.max(tris[o + 2], tris[o + 5], tris[o + 8]);
    triMaxZ[t] = zMax;

    const i0 = clamp(Math.floor((x0 - bounds.minX) / cellSize), 0, nx - 1);
    const i1 = clamp(Math.floor((x1 - bounds.minX) / cellSize), 0, nx - 1);
    const j0 = clamp(Math.floor((y0 - bounds.minY) / cellSize), 0, ny - 1);
    const j1 = clamp(Math.floor((y1 - bounds.minY) / cellSize), 0, ny - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        counts[k + 1]++;
        if (zMax > cellMaxZ[k]) cellMaxZ[k] = zMax;
      }
    }
  }

  // Prefix sum into cell start offsets.
  const cellStart = new Int32Array(cellCount + 1);
  for (let k = 0; k < cellCount; k++) cellStart[k + 1] = cellStart[k] + counts[k + 1];

  // Pass 2: scatter triangle indices into their cells.
  const cellItems = new Int32Array(cellStart[cellCount]);
  const cursor = cellStart.slice(0, cellCount);
  for (let t = 0; t < triangleCount; t++) {
    const i0 = clamp(Math.floor((triBounds[t * 4] - bounds.minX) / cellSize), 0, nx - 1);
    const i1 = clamp(Math.floor((triBounds[t * 4 + 1] - bounds.minX) / cellSize), 0, nx - 1);
    const j0 = clamp(Math.floor((triBounds[t * 4 + 2] - bounds.minY) / cellSize), 0, ny - 1);
    const j1 = clamp(Math.floor((triBounds[t * 4 + 3] - bounds.minY) / cellSize), 0, ny - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) cellItems[cursor[j * nx + i]++] = t;
    }
  }

  return {
    cellSize, nx, ny,
    minX: bounds.minX, minY: bounds.minY,
    cellStart, cellItems, triBounds, triMaxZ, cellMaxZ,
    stamp: new Int32Array(triangleCount).fill(-1),
    generation: 0,
  };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Visit every triangle whose XY bounds come within `radius` of (x, y).
 *
 * The callback form avoids materialising a candidate array per query. `visit`
 * is monomorphic and gets inlined by V8 in the drop-cutter's hot loop.
 *
 * `ceiling`, when supplied, decides whether a candidate can possibly beat the
 * caller's running best. It receives the candidate's maximum Z and the SQUARED
 * horizontal distance from the query point to its bounding box. The distance
 * matters: a ball tool touching geometry `d` away can only lift its centre to
 * `maxZ + sqrt(R^2 - d^2)`, which is a far tighter bound than `maxZ + R` for
 * anything but the very centre of the disc.
 *
 * Cells are visited nearest-first so a good `best` is established early and
 * prunes the rest of the neighbourhood.
 */
export function queryDisc(
  ix: SpatialIndex,
  x: number,
  y: number,
  radius: number,
  visit: (triangleIndex: number) => void,
  ceiling?: (maxZ: number, distSq: number) => boolean,
): void {
  const gen = ++ix.generation;
  const { cellSize, nx, ny, minX, minY, cellStart, cellItems, triBounds, triMaxZ,
    cellMaxZ, stamp } = ix;

  const i0 = clamp(Math.floor((x - radius - minX) / cellSize), 0, nx - 1);
  const i1 = clamp(Math.floor((x + radius - minX) / cellSize), 0, nx - 1);
  const j0 = clamp(Math.floor((y - radius - minY) / cellSize), 0, ny - 1);
  const j1 = clamp(Math.floor((y + radius - minY) / cellSize), 0, ny - 1);

  const r2 = radius * radius;
  const ci = clamp(Math.floor((x - minX) / cellSize), i0, i1);
  const cj = clamp(Math.floor((y - minY) / cellSize), j0, j1);

  // Nearest-first: walk outwards in Chebyshev rings from the cell containing the
  // query point. The centre cell almost always holds the contact, so `best`
  // becomes tight immediately and the outer rings are mostly pruned.
  const maxRing = Math.max(ci - i0, i1 - ci, cj - j0, j1 - cj);
  for (let ring = 0; ring <= maxRing; ring++) {
    const jLo = Math.max(j0, cj - ring);
    const jHi = Math.min(j1, cj + ring);
    for (let j = jLo; j <= jHi; j++) {
      const onJEdge = j === cj - ring || j === cj + ring;
      const iLo = Math.max(i0, ci - ring);
      const iHi = Math.min(i1, ci + ring);
      for (let i = iLo; i <= iHi; i++) {
        // Interior cells belong to a smaller ring and were already visited.
        if (!onJEdge && i !== ci - ring && i !== ci + ring) continue;

        const k = j * nx + i;
        if (ceiling !== undefined) {
          // Closest possible approach to this cell, for the cell-level bound.
          const cellDx = Math.max(0, Math.max(minX + i * cellSize - x,
            x - (minX + (i + 1) * cellSize)));
          const cellDy = Math.max(0, Math.max(minY + j * cellSize - y,
            y - (minY + (j + 1) * cellSize)));
          const cellD2 = cellDx * cellDx + cellDy * cellDy;
          if (cellD2 > r2 || !ceiling(cellMaxZ[k], cellD2)) continue;
        }

        const end = cellStart[k + 1];
        for (let s = cellStart[k]; s < end; s++) {
          const t = cellItems[s];
          if (stamp[t] === gen) continue;
          stamp[t] = gen;

          const b = t * 4;
          const dx = Math.max(0, Math.max(triBounds[b] - x, x - triBounds[b + 1]));
          const dy = Math.max(0, Math.max(triBounds[b + 2] - y, y - triBounds[b + 3]));
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          if (ceiling !== undefined && !ceiling(triMaxZ[t], d2)) continue;

          visit(t);
        }
      }
    }
  }
}
