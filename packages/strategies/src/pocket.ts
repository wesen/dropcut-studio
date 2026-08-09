/**
 * 2.5D face and rectangular pocket.
 *
 * These are the strategies the scripting DSL reaches for most, because most
 * real work is prismatic. They are pure geometry — no CL field, no mesh — so
 * they are fast and exactly predictable.
 *
 * NOTE ON DEFECT D1. The IDE prototype computed its stepover from a hard-coded
 * `const dia = 4`, with a comment claiming the real tool would be substituted
 * "at lowering". No such substitution existed anywhere in the file, so the
 * stepover was wrong for every tool that was not 4 mm — with a 2 mm cutter the
 * passes were twice too far apart and left uncut ridges. Here the tool comes
 * from the PlanningContext and the diameter is always the real one.
 */

import { mm } from "@cam/units";
import type { Box2 } from "@cam/math";
import { point } from "@cam/math";
import type { Path } from "@cam/ir";
import { pathFrom } from "@cam/ir";
import { radiusOf } from "@cam/machine";
import type { PlanningContext, ToolpathSet } from "@cam/planner";

export interface FaceParams {
  readonly area: Box2;
  readonly z: number;
  /** Fraction of tool diameter. */
  readonly stepover: number;
}

/**
 * Face a rectangular area at a single Z.
 *
 * Passes run along X and step in Y. The tool starts and ends one radius OUTSIDE
 * the area in X so the cut is clean at the edges rather than leaving a scallop
 * where the cutter turned around.
 */
export function planFace(ctx: PlanningContext, params: FaceParams): ToolpathSet {
  const g = ctx.tool.geometry;
  const R = radiusOf(g);
  const step = Math.max(0.1, params.stepover * g.diameter); // D1: real diameter
  const { area, z } = params;

  const xa = area.minX - R;
  const xb = area.maxX + R;
  const height = area.maxY - area.minY;
  const rows = Math.max(1, Math.ceil(height / step));
  const rowStep = height / rows;

  const xyz: number[] = [];
  let startX = xa;
  const startY = area.minY;

  for (let j = 0; j <= rows; j++) {
    const y = area.minY + j * rowStep;
    const forward = j % 2 === 0;
    const from = forward ? xa : xb;
    const to = forward ? xb : xa;
    if (j === 0) startX = from;
    else xyz.push(from, y, z); // step across to the new row
    xyz.push(to, y, z);
  }

  const path = pathFrom(point(startX, startY, z, "work"))
    .polyTo(Float64Array.from(xyz))
    .build();

  return {
    paths: [path],
    purpose: "finish",
    description: `face ${(area.maxX - area.minX).toFixed(1)}x${height.toFixed(1)} at z${z} ` +
      `(${rows + 1} passes, ${step.toFixed(2)} mm stepover)`,
    stepover: mm(step),
  };
}

export interface PocketParams {
  readonly area: Box2;
  readonly depth: number;
  readonly stepdown: number;
  readonly stepover: number;
}

/**
 * Clear a rectangular pocket with concentric rings, inside-out, one ring set per
 * depth level.
 *
 * Inside-out (rather than outside-in) means the cutter is never fully engaged on
 * both sides: each ring cuts into material only on its outer edge. It also means
 * the plunge happens at the centre, in open air cleared by the previous level.
 */
export function planRectPocket(ctx: PlanningContext, params: PocketParams): ToolpathSet {
  const g = ctx.tool.geometry;
  const R = radiusOf(g);
  const step = Math.max(0.1, params.stepover * g.diameter); // D1: real diameter
  const { area, depth, stepdown } = params;

  const cx = (area.minX + area.maxX) / 2;
  const cy = (area.minY + area.maxY) / 2;
  // The tool centre can only reach within R of each wall.
  const halfW = (area.maxX - area.minX) / 2 - R;
  const halfH = (area.maxY - area.minY) / 2 - R;

  if (halfW <= 0 || halfH <= 0) {
    throw new Error(
      `pocket ${(area.maxX - area.minX).toFixed(1)}x${(area.maxY - area.minY).toFixed(1)} mm ` +
      `is too small for a ${g.diameter} mm tool`,
    );
  }

  const topZ = ctx.setup.stock.topZ;
  const levels: number[] = [];
  for (let z = topZ - stepdown; z > topZ - depth - 1e-9; z -= stepdown) {
    levels.push(Math.max(z, topZ - depth));
  }
  if (levels.length === 0) levels.push(topZ - depth);

  const paths: Path<"work">[] = [];

  for (const z of levels) {
    const xyz: number[] = [];
    // Start at the centre; each ring is a rectangle grown by one stepover.
    let k = 1;
    for (;;) {
      const a = Math.min(k * step, halfW);
      const b = Math.min(k * step, halfH);
      xyz.push(cx + a, cy + b, z);
      xyz.push(cx - a, cy + b, z);
      xyz.push(cx - a, cy - b, z);
      xyz.push(cx + a, cy - b, z);
      xyz.push(cx + a, cy + b, z);
      if (a >= halfW - 1e-9 && b >= halfH - 1e-9) break;
      k++;
      // Safety: a pathological stepover must not spin forever.
      if (k > 100_000) break;
    }

    paths.push(
      pathFrom(point(cx, cy, z, "work"))
        .polyTo(Float64Array.from(xyz))
        .build(),
    );
  }

  return {
    paths,
    purpose: "rough",
    description:
      `pocket ${(area.maxX - area.minX).toFixed(1)}x${(area.maxY - area.minY).toFixed(1)} ` +
      `depth ${depth} in ${levels.length} levels, ${step.toFixed(2)} mm stepover`,
    stepover: mm(step),
  };
}

export interface DrillParams {
  readonly points: readonly { x: number; y: number }[];
  readonly depth: number;
  readonly peck?: number;
}

/** Straight or peck drilling at a list of points. */
export function planDrill(ctx: PlanningContext, params: DrillParams): ToolpathSet {
  const topZ = ctx.setup.stock.topZ;
  const bottom = topZ - params.depth;
  const paths: Path<"work">[] = [];

  for (const p of params.points) {
    const xyz: number[] = [];
    if (params.peck && params.peck > 0) {
      // Peck: descend in bites, retracting to the surface to clear chips.
      let z: number = topZ;
      while (z > bottom + 1e-9) {
        z = Math.max(bottom, z - params.peck);
        xyz.push(p.x, p.y, z);
        if (z > bottom + 1e-9) xyz.push(p.x, p.y, topZ);
      }
    } else {
      xyz.push(p.x, p.y, bottom);
    }
    xyz.push(p.x, p.y, topZ);

    paths.push(
      pathFrom(point(p.x, p.y, topZ, "work"))
        .polyTo(Float64Array.from(xyz))
        .build(),
    );
  }

  return {
    paths,
    purpose: "plunge",
    description: `drill ${params.points.length} holes to depth ${params.depth}` +
      (params.peck ? ` (peck ${params.peck} mm)` : ""),
    stepover: mm(0),
  };
}
