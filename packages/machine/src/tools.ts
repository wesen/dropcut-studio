/**
 * @cam/machine/tools — cutter geometry.
 *
 * `profile(g, r)` is the whole abstraction: given a radial distance from the
 * tool axis, how far above the tip is the cutting surface? Everything else —
 * drop-cutter contact, material removal simulation, rendering — is expressed in
 * terms of it, which is what makes those subsystems tool-agnostic.
 *
 * Design doc: Part IV.10.
 */

import type { Degrees, Mm } from "@cam/units";
import { mm } from "@cam/units";

export type ToolGeometry =
  | { readonly type: "flat"; readonly diameter: Mm }
  | { readonly type: "ball"; readonly diameter: Mm }
  | { readonly type: "bull"; readonly diameter: Mm; readonly cornerRadius: Mm }
  | {
      readonly type: "vbit";
      readonly diameter: Mm;
      readonly tipDiameter: Mm;
      readonly includedAngle: Degrees;
    };

export type ToolId = string;

export interface Tool {
  readonly id: ToolId;
  /** T-word used in the emitted program. */
  readonly number: number;
  readonly name: string;
  readonly geometry: ToolGeometry;
  readonly fluteLength?: Mm;
  readonly shankDiameter?: Mm;
  /** Length protruding from the holder. Needed for holder-collision checks. */
  readonly stickout?: Mm;
}

export const radiusOf = (g: ToolGeometry): Mm => mm(g.diameter / 2);

/**
 * Height of the cutter surface above the tool tip at radial distance `r`.
 * Returns null when `r` is outside the cutter.
 *
 * - flat: a disc, so zero everywhere inside the radius.
 * - ball: a sphere tangent to the tip plane, so R - sqrt(R^2 - r^2).
 * - vbit: a cone; below the tip flat the surface is flat, beyond it rises at
 *   the half-angle. A true point (tipDiameter 0) degenerates gracefully.
 * - bull: flat in the middle, torus-rounded within `cornerRadius` of the edge.
 */
export function profile(g: ToolGeometry, r: number): Mm | null {
  const R = Math.max(0.05, g.diameter / 2);
  if (r > R + 1e-9) return null;

  switch (g.type) {
    case "flat":
      return mm(0);

    case "ball":
      return mm(R - Math.sqrt(Math.max(0, R * R - r * r)));

    case "vbit": {
      const tipR = Math.max(0, g.tipDiameter / 2);
      if (r <= tipR) return mm(0);
      // includedAngle is the full cone angle; the wall rises at half of it.
      const halfAngle = (g.includedAngle * Math.PI) / 360;
      const t = Math.tan(halfAngle);
      if (t < 1e-9) return mm(0);
      return mm((r - tipR) / t);
    }

    case "bull": {
      const cr = Math.min(Math.max(0, g.cornerRadius), R);
      const flatR = R - cr;
      if (r <= flatR) return mm(0);
      if (cr < 1e-9) return mm(0);
      const d = r - flatR;
      return mm(cr - Math.sqrt(Math.max(0, cr * cr - d * d)));
    }
  }
}

/** Human-readable description, used in comments and the tool table UI. */
export function describeTool(t: Tool): string {
  const g = t.geometry;
  switch (g.type) {
    case "flat":
      return `${g.diameter}mm flat end mill`;
    case "ball":
      return `${g.diameter}mm ball nose`;
    case "bull":
      return `${g.diameter}mm bull nose, ${g.cornerRadius}mm corner`;
    case "vbit":
      return `${g.diameter}mm V-bit, ${g.includedAngle}deg, ${g.tipDiameter}mm tip`;
  }
}

/**
 * Stepover that produces a given scallop height with a ball nose.
 *
 * Adjacent ball passes leave a cusp between them. Exact relation for cusp
 * height h with tool radius R:  s = 2 * sqrt(2Rh - h^2). This is the exact chord
 * form, not the s ~= sqrt(8Rh) approximation (they agree for h << R).
 *
 * For non-ball tools scallop is not meaningful, so callers must supply a
 * stepover fraction instead.
 */
export function stepoverForScallop(toolRadius: number, scallop: number): Mm {
  const h = Math.max(1e-5, scallop);
  const R = Math.max(1e-5, toolRadius);
  const s = 2 * Math.sqrt(Math.max(1e-9, 2 * R * h - h * h));
  // Cap at 1.8R: beyond that the "adjacent passes" model breaks down entirely.
  return mm(Math.min(Math.max(s, 0.02), 1.8 * R));
}

/** Inverse of `stepoverForScallop`: the cusp left by a given stepover. */
export function scallopForStepover(toolRadius: number, stepover: number): Mm {
  const R = Math.max(1e-5, toolRadius);
  const half = Math.min(stepover / 2, R);
  return mm(R - Math.sqrt(Math.max(0, R * R - half * half)));
}
