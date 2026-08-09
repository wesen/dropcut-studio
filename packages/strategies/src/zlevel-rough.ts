/**
 * Z-level roughing — bulk material removal in flat layers.
 *
 * For each Z level from the top down, find the regions where the tool can
 * descend to that level without hitting the part, then clear each region with
 * alternating scanline passes.
 *
 * Two ideas carry the weight:
 *
 * 1. SURFACE INFLATION. Rather than tracking "stock to leave" as an offset
 *    applied afterwards, we evaluate the CL surface for a tool grown by the
 *    allowance. The resulting surface is offset outward by exactly the
 *    allowance, so anything below it is safe to cut. One parameter, no special
 *    cases, and it composes with everything downstream.
 *
 * 2. UNION-FIND REGION DECOMPOSITION. A Z level can expose several disconnected
 *    pockets. Machining them in scanline order would rapid back and forth
 *    between them constantly. Instead, scanline intervals that overlap between
 *    adjacent rows are unioned, so each connected pocket is identified and
 *    machined in one continuous visit.
 *
 * Design doc: Part IX.4.
 */

import { mm } from "@cam/units";
import { point } from "@cam/math";
import type { Path } from "@cam/ir";
import { pathFrom } from "@cam/ir";
import { radiusOf } from "@cam/machine";
import type { PlanningContext, ToolpathSet } from "@cam/planner";

export interface ZLevelRoughParams {
  readonly stepdown: number;
  /** Fraction of tool diameter. */
  readonly stepover: number;
  readonly stockToLeave: number;
  readonly direction?: "X" | "Y";
}

interface Interval {
  readonly a0: number;
  readonly a1: number;
  id: number;
}

export function planZLevelRough(ctx: PlanningContext, params: ZLevelRoughParams): ToolpathSet {
  const g = ctx.tool.geometry;
  const R = radiusOf(g);
  const step = Math.max(0.1, params.stepover * g.diameter);
  const allowance = params.stockToLeave;

  // The inflated CL surface: anything strictly below it is safe to cut while
  // still leaving `allowance` on the finished part.
  const evaluate = ctx.evaluate(allowance);

  const alongX = (params.direction ?? "X") === "X";
  const b = ctx.bounds;
  const aLo = alongX ? b.minX : b.minY;
  const aHi = alongX ? b.maxX : b.maxY;
  const bLo = alongX ? b.minY : b.minX;
  const bHi = alongX ? b.maxY : b.maxX;
  const toWorld = alongX
    ? (a: number, s: number): [number, number] => [a, s]
    : (a: number, s: number): [number, number] => [s, a];
  const evalAB = alongX
    ? (a: number, s: number) => evaluate(a, s)
    : (a: number, s: number) => evaluate(s, a);

  const topZ = ctx.setup.stock.topZ;
  const bottomZ = ctx.setup.floorZ + allowance;

  const levels: number[] = [];
  for (let z = topZ - params.stepdown; z > bottomZ + 1e-6; z -= params.stepdown) levels.push(z);
  if (topZ > bottomZ + 1e-6) levels.push(bottomZ);

  const rows = Math.max(1, Math.ceil((bHi - bLo) / step));
  const rowStep = (bHi - bLo) / rows;
  // Scanline sampling step. Fine enough to find pocket walls, coarse enough to
  // be affordable; the boundary is then refined by bisection.
  const scanStep = Math.min(Math.max(R / 2, 0.15), 1);

  const paths: Path<"work">[] = [];

  for (let li = 0; li < levels.length; li++) {
    if (ctx.signal?.aborted) break;
    const z = levels[li];

    /* --- find cuttable intervals per row, and union them into regions --- */

    const rowIntervals: Interval[][] = [];
    const parent: number[] = [];
    const find = (x: number): number => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    const union = (p: number, q: number) => { parent[find(p)] = find(q); };
    let nextId = 0;

    for (let j = 0; j <= rows; j++) {
      const s = bLo + j * rowStep;
      const intervals: Interval[] = [];

      let open: number | null = null;
      let prevA = aLo;
      let prevOk = evalAB(aLo, s) <= z + 1e-6;
      if (prevOk) open = aLo;

      for (let a = aLo + scanStep; a <= aHi + 1e-9; a += scanStep) {
        const aa = Math.min(a, aHi);
        const ok = evalAB(aa, s) <= z + 1e-6;
        if (ok !== prevOk) {
          // Bisect to place the wall accurately without sampling the whole row
          // finely. Five halvings gets within scanStep/32.
          let lo = prevA;
          let hi = aa;
          for (let k = 0; k < 5; k++) {
            const mid = (lo + hi) / 2;
            if ((evalAB(mid, s) <= z + 1e-6) === prevOk) lo = mid;
            else hi = mid;
          }
          const edge = (lo + hi) / 2;
          if (ok) open = edge;
          else if (open !== null) {
            if (edge - open > 0.05) intervals.push({ a0: open, a1: edge, id: -1 });
            open = null;
          }
        }
        prevA = aa;
        prevOk = ok;
        if (aa >= aHi) break;
      }
      if (open !== null && aHi - open > 0.05) intervals.push({ a0: open, a1: aHi, id: -1 });

      for (const iv of intervals) {
        iv.id = nextId;
        parent[nextId] = nextId;
        nextId++;
        if (j > 0) {
          for (const prev of rowIntervals[j - 1]) {
            if (iv.a0 <= prev.a1 + 1e-6 && iv.a1 >= prev.a0 - 1e-6) union(iv.id, prev.id);
          }
        }
      }
      rowIntervals.push(intervals);
    }

    /* --- machine each connected region as a boustrophedon --- */

    const regions = new Map<number, { j: number; iv: Interval }[]>();
    for (let j = 0; j <= rows; j++) {
      for (const iv of rowIntervals[j]) {
        const root = find(iv.id);
        const bucket = regions.get(root);
        if (bucket) bucket.push({ j, iv });
        else regions.set(root, [{ j, iv }]);
      }
    }

    // Machine the topmost region first so travel between regions is monotonic.
    const ordered = [...regions.values()].sort((p, q) => p[0].j - q[0].j);

    for (const region of ordered) {
      const byRow = new Map<number, Interval[]>();
      for (const e of region) {
        const bucket = byRow.get(e.j);
        if (bucket) bucket.push(e.iv);
        else byRow.set(e.j, [e.iv]);
      }

      let forward = true;
      const xyz: number[] = [];
      let startX = Number.NaN;
      let startY = Number.NaN;

      for (const j of [...byRow.keys()].sort((p, q) => p - q)) {
        const s = bLo + j * rowStep;
        const ivs = byRow.get(j)!.sort((p, q) => p.a0 - q.a0);
        for (const iv of forward ? ivs : [...ivs].reverse()) {
          const aStart = forward ? iv.a0 : iv.a1;
          const aEnd = forward ? iv.a1 : iv.a0;
          const [sx, sy] = toWorld(aStart, s);
          const [ex, ey] = toWorld(aEnd, s);
          if (Number.isNaN(startX)) { startX = sx; startY = sy; }
          else xyz.push(sx, sy, z);
          xyz.push(ex, ey, z);
        }
        forward = !forward;
      }

      if (xyz.length >= 3 && !Number.isNaN(startX)) {
        paths.push(
          pathFrom(point(startX, startY, z, "work"))
            .polyTo(Float64Array.from(xyz))
            .build(),
        );
      }
    }

    ctx.progress((li + 1) / levels.length);
  }

  return {
    paths,
    purpose: "rough",
    description:
      `z-level rough: ${levels.length} levels at ${params.stepdown} mm stepdown, ` +
      `${paths.length} regions, ${allowance} mm stock left`,
    stepover: mm(step),
  };
}
