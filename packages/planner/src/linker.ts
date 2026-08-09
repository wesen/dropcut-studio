/**
 * @cam/planner/linker — getting from the end of one path to the start of the next.
 *
 * A strategy emits independent paths. Something has to decide, for each gap,
 * whether to STAY DOWN and cut across, or RETRACT and rapid over. That decision
 * is the difference between a job that takes eight minutes and one that takes
 * twenty, and it is a safety question as well: staying down through material
 * that has not been cleared is a broken tool.
 *
 * Keeping this out of the strategies is the main structural fix relative to the
 * prototype, where linking was interleaved with path generation inside
 * `generateJob` and could not be tested or changed independently.
 */

import type { MmPerMin } from "@cam/units";
import { mm } from "@cam/units";
import { point } from "@cam/math";
import type { CanonicalCommand, Path, Provenance, ToolRef } from "@cam/ir";
import { pathFrom } from "@cam/ir";

export interface LinkOptions {
  /** Stay down if the gap is no longer than this. */
  readonly stayDownDistance: number;
  /** Safe height for retract-and-rapid links. */
  readonly clearanceZ: number;
  /** Surface height query, used to test whether a straight link is clear. */
  readonly surfaceAt: (x: number, y: number) => number;
  /** Extra height to keep above the surface when riding across. */
  readonly rideClearance: number;
  readonly feed: MmPerMin;
  readonly toolRadius: number;
  readonly tool: ToolRef;
  readonly provenance: Provenance;
}

export interface LinkDecision {
  readonly kind: "stay-down" | "retract";
  readonly commands: readonly CanonicalCommand<"work">[];
}

/**
 * Decide and emit the link between two points.
 *
 * Stay-down requires BOTH that the gap is short and that the straight line
 * between the points is clear of material. The clearance test samples the
 * surface along the link at roughly half-tool-radius intervals — coarse enough
 * to be cheap, fine enough that a wall cannot hide between samples for any
 * feature the tool could actually fit into.
 */
export function planLink(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  opts: LinkOptions,
): LinkDecision {
  const gap = Math.hypot(to.x - from.x, to.y - from.y);

  if (gap <= opts.stayDownDistance && isStraightLinkClear(from, to, opts)) {
    const path = pathFrom(point(from.x, from.y, from.z, "work"))
      .lineTo(point(to.x, to.y, to.z, "work"))
      .build();
    return {
      kind: "stay-down",
      commands: [{
        kind: "cut",
        path,
        feed: opts.feed,
        tolerance: mm(0.01),
        purpose: "lead-in",
        tool: opts.tool,
        provenance: opts.provenance,
      }],
    };
  }

  // Retract to a height that clears everything between here and there, not just
  // the global clearance plane — on a tall part the global plane can be far
  // above what this particular link needs.
  const localSafe = Math.min(
    opts.clearanceZ,
    maxSurfaceAlong(from, to, opts) + opts.rideClearance,
  );
  const safeZ = Math.max(localSafe, from.z, to.z);

  return {
    kind: "retract",
    commands: [{
      kind: "traverse",
      to: point(to.x, to.y, to.z, "work"),
      clearance: { safeZ: mm(safeZ), allowCoordinated: false },
      provenance: opts.provenance,
    }],
  };
}

function isStraightLinkClear(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  opts: LinkOptions,
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const gap = Math.hypot(dx, dy);
  const steps = Math.max(2, Math.ceil(gap / Math.max(0.2, opts.toolRadius / 2)));

  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const x = from.x + dx * t;
    const y = from.y + dy * t;
    // Linear interpolation of the tool height across the link.
    const toolZ = from.z + (to.z - from.z) * t;
    if (opts.surfaceAt(x, y) > toolZ + 1e-6) return false;
  }
  return true;
}

function maxSurfaceAlong(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  opts: LinkOptions,
): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const gap = Math.hypot(dx, dy);
  const steps = Math.max(2, Math.ceil(gap / Math.max(0.3, opts.toolRadius)));

  let peak = Math.max(from.z, to.z);
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const h = opts.surfaceAt(from.x + dx * t, from.y + dy * t);
    if (h > peak) peak = h;
  }
  return peak;
}

/**
 * Reorder paths greedily so each one starts near where the previous ended.
 *
 * Nearest-neighbour is a crude travelling-salesman heuristic, but on toolpath
 * sets — where paths are already spatially coherent within a level — it removes
 * most of the wasted travel that emission order would otherwise produce.
 *
 * Reversal is considered for open paths: a path is just as machinable backwards,
 * and allowing it roughly halves the average approach distance.
 */
export function orderPaths(
  paths: readonly Path<"work">[],
  startX = 0,
  startY = 0,
): Path<"work">[] {
  if (paths.length <= 1) return [...paths];

  const remaining = paths.map((p, i) => i);
  const out: Path<"work">[] = [];
  let cx = startX;
  let cy = startY;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    let bestReverse = false;

    for (let k = 0; k < remaining.length; k++) {
      const p = paths[remaining[k]];
      const dStart = Math.hypot(p.start.x - cx, p.start.y - cy);
      if (dStart < bestDist) { bestDist = dStart; bestIdx = k; bestReverse = false; }

      // Only open paths may be reversed; a closed loop already starts where it
      // ends, and rotating it is the contour code's job, not ours.
      const isClosed = Math.hypot(p.end.x - p.start.x, p.end.y - p.start.y) < 1e-6;
      if (!isClosed) {
        const dEnd = Math.hypot(p.end.x - cx, p.end.y - cy);
        if (dEnd < bestDist) { bestDist = dEnd; bestIdx = k; bestReverse = true; }
      }
    }

    const chosen = paths[remaining[bestIdx]];
    remaining.splice(bestIdx, 1);
    const final = bestReverse ? reversePath(chosen) : chosen;
    out.push(final);
    cx = final.end.x;
    cy = final.end.y;
  }

  return out;
}

/** Reverse a path. Only poly/line segments are supported; arcs keep their order. */
export function reversePath(p: Path<"work">): Path<"work"> {
  const pts: number[] = [];
  const push = (x: number, y: number, z: number) => pts.push(x, y, z);

  push(p.start.x, p.start.y, p.start.z);
  for (const seg of p.segments) {
    if (seg.kind === "poly") {
      for (let i = 0; i < seg.pts.length; i += 3) push(seg.pts[i], seg.pts[i + 1], seg.pts[i + 2]);
    } else if (seg.kind === "line") {
      push(seg.to.x, seg.to.y, seg.to.z);
    } else {
      // Reversing an arc means negating its sweep and swapping endpoints, which
      // the caller can do; for now leave such paths alone rather than corrupt them.
      return p;
    }
  }

  const n = pts.length / 3;
  const rev = new Float64Array(pts.length);
  for (let i = 0; i < n; i++) {
    rev[i * 3] = pts[(n - 1 - i) * 3];
    rev[i * 3 + 1] = pts[(n - 1 - i) * 3 + 1];
    rev[i * 3 + 2] = pts[(n - 1 - i) * 3 + 2];
  }

  return pathFrom(point(rev[0], rev[1], rev[2], "work"))
    .polyTo(rev.subarray(3))
    .build();
}
