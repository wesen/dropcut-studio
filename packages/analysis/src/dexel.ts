/**
 * @cam/analysis/dexel — heightmap material-removal simulation.
 *
 * ONE simulator with TWO modes, per ADR-009. The prototypes had two separate
 * implementations of the same stamping kernel: a batch verifier that diffed
 * against a target surface, and an incremental one that advanced with playback.
 * Only the driver differs, so they are unified here.
 *
 * The model is a heightmap: the stock is a grid of columns, each storing the
 * current top-of-material Z. Cutting lowers columns. This cannot represent
 * undercuts, which is fine for 3-axis machining where the tool always arrives
 * from above.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. The simulation establishes that at the
 * sampled grid points, at the sampled positions along each move, the tool did
 * not go below the target. It says nothing about what happens between samples.
 * That is why the certificate reports "verified-to-resolution" with the actual
 * numbers rather than a bare boolean (ADR-010).
 *
 * Design doc: Part IX.9, Part X.
 */

import type { ToolGeometry } from "@cam/machine";
import { profile, radiusOf } from "@cam/machine";
import type { Mesh } from "@cam/geometry";
import { pointInTriangle } from "@cam/geometry";

export interface StockDefinition {
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly topZ: number;
}

export interface SimOptions {
  /** Target cells across the longest stock dimension. */
  readonly resolution?: number;
  /** Sampling step along a move, as a fraction of a cell. */
  readonly sampleFraction?: number;
}

/** One straight move to simulate. */
export interface SimMove {
  readonly kind: "rapid" | "cut";
  readonly from: { x: number; y: number; z: number };
  readonly to: { x: number; y: number; z: number };
  readonly tool: ToolGeometry;
  /** Index back into the program, for diagnostics. */
  readonly index: number;
}

/** Precomputed tool footprint: grid offsets plus the cutter height there. */
interface Footprint {
  readonly di: Int32Array;
  readonly dj: Int32Array;
  readonly dz: Float64Array;
  readonly length: number;
}

export class DexelSim {
  readonly nx: number;
  readonly ny: number;
  readonly cellW: number;
  readonly cellD: number;
  readonly heights: Float64Array;
  readonly bottomZ: number;
  /** Render clamp: gouges below this are flattened so the mesh stays finite. */
  readonly renderFloor: number;

  private readonly footprints = new Map<string, Footprint>();
  private readonly sampleFraction: number;

  constructor(readonly stock: StockDefinition, opts: SimOptions = {}) {
    const resolution = opts.resolution ?? 240;
    const longest = Math.max(stock.width, stock.depth, 1);
    this.nx = Math.max(12, Math.round((resolution * stock.width) / longest));
    this.ny = Math.max(12, Math.round((resolution * stock.depth) / longest));
    this.cellW = stock.width / this.nx;
    this.cellD = stock.depth / this.ny;
    this.heights = new Float64Array((this.nx + 1) * (this.ny + 1));
    this.bottomZ = stock.topZ - stock.height;
    this.renderFloor = this.bottomZ - Math.min(2, stock.height * 0.4);
    this.sampleFraction = opts.sampleFraction ?? 0.55;
    this.reset();
  }

  reset(): void {
    this.heights.fill(this.stock.topZ);
  }

  snapshot(): Float64Array {
    return this.heights.slice();
  }

  restore(snap: Float64Array): void {
    this.heights.set(snap);
  }

  /**
   * Stamp the cutter at one position.
   *
   * Returns the maximum depth of material removed (0 if the tool touched
   * nothing). `remove` false makes it a pure query, used for collision testing
   * without mutating the stock.
   */
  stamp(x: number, y: number, tipZ: number, tool: ToolGeometry, remove = true): number {
    const R = radiusOf(tool);
    const lx = x - this.stock.originX;
    const ly = y - this.stock.originY;
    if (lx < -R || lx > this.stock.width + R || ly < -R || ly > this.stock.depth + R) return 0;

    const fp = this.footprintFor(tool);
    const ic = Math.round(lx / this.cellW);
    const jc = Math.round(ly / this.cellD);
    let maxCut = 0;

    for (let k = 0; k < fp.length; k++) {
      const i = ic + fp.di[k];
      const j = jc + fp.dj[k];
      if (i < 0 || i > this.nx || j < 0 || j > this.ny) continue;
      const idx = j * (this.nx + 1) + i;
      const surface = tipZ + fp.dz[k];
      const current = this.heights[idx];
      if (surface < current - 1e-6) {
        const cut = current - surface;
        if (cut > maxCut) maxCut = cut;
        // Clamp for RENDERING only. The returned depth is unclamped, so gouge
        // detection sees the true magnitude.
        if (remove) this.heights[idx] = Math.max(surface, this.renderFloor);
      }
    }
    return maxCut;
  }

  /** Sweep a straight move, stamping along it. Returns the deepest engagement. */
  sweep(move: SimMove, fromFraction = 0, toFraction = 1): number {
    const { from, to } = move;
    const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);

    if (length < 1e-9) {
      return toFraction >= 1 ? this.stamp(to.x, to.y, to.z, move.tool) : 0;
    }

    const step = Math.min(this.cellW, this.cellD) * this.sampleFraction;
    const span = (toFraction - fromFraction) * length;
    const steps = Math.max(1, Math.ceil(span / step));

    let deepest = 0;
    for (let k = 0; k <= steps; k++) {
      const t = fromFraction + ((toFraction - fromFraction) * k) / steps;
      const d = this.stamp(
        from.x + (to.x - from.x) * t,
        from.y + (to.y - from.y) * t,
        from.z + (to.z - from.z) * t,
        move.tool,
      );
      if (d > deepest) deepest = d;
    }
    return deepest;
  }

  /**
   * Tool footprint: the grid offsets a cutter of this geometry covers, and how
   * high the cutter surface sits above the tip at each.
   *
   * Cached per tool: recomputing this per stamp would dominate the simulation.
   */
  private footprintFor(tool: ToolGeometry): Footprint {
    const key = footprintKey(tool);
    const cached = this.footprints.get(key);
    if (cached) return cached;

    const R = radiusOf(tool);
    const ri = Math.ceil(R / this.cellW);
    const rj = Math.ceil(R / this.cellD);

    const di: number[] = [];
    const dj: number[] = [];
    const dz: number[] = [];
    for (let j = -rj; j <= rj; j++) {
      for (let i = -ri; i <= ri; i++) {
        const r = Math.hypot(i * this.cellW, j * this.cellD);
        const h = profile(tool, r);
        if (h === null) continue;
        di.push(i); dj.push(j); dz.push(h);
      }
    }

    const fp: Footprint = {
      di: Int32Array.from(di),
      dj: Int32Array.from(dj),
      dz: Float64Array.from(dz),
      length: di.length,
    };
    this.footprints.set(key, fp);
    return fp;
  }
}

function footprintKey(t: ToolGeometry): string {
  switch (t.type) {
    case "flat": return `flat:${t.diameter}`;
    case "ball": return `ball:${t.diameter}`;
    case "bull": return `bull:${t.diameter}:${t.cornerRadius}`;
    case "vbit": return `vbit:${t.diameter}:${t.tipDiameter}:${t.includedAngle}`;
  }
}

/* ------------------------- deviation analysis -------------------------- */

export interface DeviationResult {
  /** Machined height minus target height, per grid node. */
  readonly deviation: Float64Array;
  readonly minDeviation: number;
  readonly maxDeviation: number;
  /** RMS over nodes where the part actually rises above the floor. */
  readonly rms: number;
  /** Percentage of PART nodes within tolerance. */
  readonly percentInTolerance: number;
  readonly toleranceBand: number;
  readonly gougeDepth: number;
}

/**
 * Rasterise a mesh into a target height field on the simulator's grid.
 *
 * Max-Z per node: for a 3-axis part, the visible surface is the highest triangle
 * over each column.
 */
export function rasteriseTarget(sim: DexelSim, mesh: Mesh, floorZ: number): Float64Array {
  const target = new Float64Array(sim.heights.length).fill(floorZ);
  const T = mesh.tris;

  for (let t = 0; t < mesh.triangleCount; t++) {
    const o = t * 9;
    const ax = T[o], ay = T[o + 1], az = T[o + 2];
    const bx = T[o + 3], by = T[o + 4], bz = T[o + 5];
    const cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nz = ux * vy - uy * vx;
    if (Math.abs(nz) < 1e-12) continue; // vertical triangle contributes nothing
    const nxc = uy * vz - uz * vy;
    const nyc = uz * vx - ux * vz;
    const A = -nxc / nz;
    const B = -nyc / nz;
    const C = az - A * ax - B * ay;

    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - sim.stock.originX) / sim.cellW));
    const i1 = Math.min(sim.nx, Math.ceil((Math.max(ax, bx, cx) - sim.stock.originX) / sim.cellW));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - sim.stock.originY) / sim.cellD));
    const j1 = Math.min(sim.ny, Math.ceil((Math.max(ay, by, cy) - sim.stock.originY) / sim.cellD));

    for (let j = j0; j <= j1; j++) {
      const py = sim.stock.originY + j * sim.cellD;
      for (let i = i0; i <= i1; i++) {
        const px = sim.stock.originX + i * sim.cellW;
        if (!pointInTriangle(px, py, ax, ay, bx, by, cx, cy)) continue;
        const z = A * px + B * py + C;
        const idx = j * (sim.nx + 1) + i;
        if (z > target[idx]) target[idx] = z;
      }
    }
  }
  return target;
}

/**
 * Compare machined stock against the target surface.
 *
 * NOTE (defect D2). The prototype computed "percent in tolerance" over ALL grid
 * nodes including the empty margin around the part, which inflated the figure —
 * a job that machined nothing but had a large margin would still score well.
 * Here the percentage is over PART nodes only, matching how RMS was already
 * (correctly) computed there.
 */
export function analyseDeviation(
  sim: DexelSim,
  target: Float64Array,
  floorZ: number,
  toleranceBand: number,
): DeviationResult {
  const n = sim.heights.length;
  const deviation = new Float64Array(n);

  let minDev = Infinity;
  let maxDev = -Infinity;
  let sumSq = 0;
  let partNodes = 0;
  let inTolerance = 0;

  for (let k = 0; k < n; k++) {
    const d = sim.heights[k] - target[k];
    deviation[k] = d;
    if (d < minDev) minDev = d;
    if (d > maxDev) maxDev = d;

    // A node counts as "part" only where the target rises meaningfully above
    // the floor; everywhere else there is nothing to be in tolerance OF.
    if (target[k] > floorZ + 0.05) {
      partNodes++;
      sumSq += d * d;
      if (d >= -0.02 && d <= toleranceBand) inTolerance++;
    }
  }

  return {
    deviation,
    minDeviation: Number.isFinite(minDev) ? minDev : 0,
    maxDeviation: Number.isFinite(maxDev) ? maxDev : 0,
    rms: partNodes > 0 ? Math.sqrt(sumSq / partNodes) : 0,
    percentInTolerance: partNodes > 0 ? (100 * inTolerance) / partNodes : 100,
    toleranceBand,
    gougeDepth: Number.isFinite(minDev) ? Math.max(0, -minDev) : 0,
  };
}

/** Colour for a deviation value: red gouge, green/teal in-tolerance, blue excess. */
export function deviationColour(d: number, band: number): [number, number, number] {
  if (d < -0.02) {
    const t = Math.min(1, (-d - 0.02) / 0.2);
    return [0.88, 0.3 - 0.12 * t, 0.24 - 0.08 * t];
  }
  if (d <= band) {
    const t = Math.max(0, d) / Math.max(band, 1e-9);
    return [0.22 + 0.4 * t, 0.64 - 0.06 * t, 0.44 + 0.28 * t];
  }
  const t = Math.min(1, (d - band) / 0.5);
  return [0.33 - 0.08 * t, 0.5 - 0.05 * t, 0.72 + 0.2 * t];
}
