/**
 * @cam/planner/entry — getting into the material.
 *
 * Plunging straight down is hard on tools: the centre of an end mill has zero
 * surface speed, so it rubs rather than cuts. The preference order is therefore
 * helix, then ramp, then plunge as a last resort.
 *
 * Each option is only used if it FITS. A helix needs room to orbit; a ramp needs
 * room to travel. When entry degrades because the pocket is too tight, we emit
 * an `entry.degraded` diagnostic — the prototype degraded silently, which meant
 * a user could get plunge entries throughout a job and never know why their
 * tools were dying.
 *
 * Design doc: Part XII.3 (planner/entry).
 */

import { mm } from "@cam/units";
import { point } from "@cam/math";
import type { Diagnostic, Path, Provenance } from "@cam/ir";
import { info, pathFrom } from "@cam/ir";

export type EntryMode = "auto" | "ramp" | "plunge";

export interface EntryRequest {
  /** Where the cut begins, at final depth. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Height to start descending from. */
  readonly fromZ: number;
  /** Unit direction of the first cutting move, for ramp orientation. */
  readonly dirX: number;
  readonly dirY: number;
  /** Distance available along that direction before hitting material. */
  readonly available: number;
  readonly toolRadius: number;
  readonly mode: EntryMode;
  readonly maxRampAngle: number;
  /** Tests whether the tool may occupy (x, y) at height z. */
  readonly clear: (x: number, y: number, z: number) => boolean;
  readonly provenance: Provenance;
}

export interface EntryResult {
  readonly path: Path<"work">;
  readonly kind: "helix" | "ramp" | "plunge";
  readonly diagnostics: readonly Diagnostic[];
}

export function planEntry(req: EntryRequest): EntryResult {
  const diagnostics: Diagnostic[] = [];
  const angle = (Math.max(0.5, req.maxRampAngle) * Math.PI) / 180;

  if (req.mode === "auto") {
    const helix = tryHelix(req, angle);
    if (helix) return { path: helix, kind: "helix", diagnostics };
  }

  if (req.mode === "auto" || req.mode === "ramp") {
    const ramp = tryRamp(req, angle);
    if (ramp) {
      if (req.mode === "auto") {
        diagnostics.push(info("entry.degraded",
          "no room to helix; using a ramp entry instead",
          { provenance: req.provenance }));
      }
      return { path: ramp, kind: "ramp", diagnostics };
    }
  }

  if (req.mode !== "plunge") {
    diagnostics.push(info("entry.degraded",
      `no room to ${req.mode === "auto" ? "helix or ramp" : "ramp"}; ` +
      "plunging straight down, which is hard on the tool",
      { provenance: req.provenance }));
  }

  return {
    path: pathFrom(point(req.x, req.y, req.fromZ, "work"))
      .lineTo(point(req.x, req.y, req.z, "work"))
      .build(),
    kind: "plunge",
    diagnostics,
  };
}

/**
 * Helical entry: orbit at radius R/2 while descending, then one flat revolution
 * at the target depth so the floor is clean before the cut proper begins.
 *
 * The orbit is validated at 12 sample angles against `clear`. Twelve is enough
 * to catch a wall intruding into the circle without making the check expensive.
 */
function tryHelix(req: EntryRequest, angle: number): Path<"work"> | null {
  const rh = Math.max(0.25, req.toolRadius * 0.5);
  if (req.available <= 2 * rh + 0.2) return null;

  // Centre the orbit one radius along the cut direction, so the helix ends
  // pointing the right way.
  const cx = req.x + rh * req.dirX;
  const cy = req.y + rh * req.dirY;
  const nx = -req.dirY;
  const ny = req.dirX;

  const at = (theta: number) => ({
    x: cx - rh * Math.cos(theta) * req.dirX + rh * Math.sin(theta) * nx,
    y: cy - rh * Math.cos(theta) * req.dirY + rh * Math.sin(theta) * ny,
  });

  for (let k = 0; k < 12; k++) {
    const p = at((k / 12) * 2 * Math.PI);
    if (!req.clear(p.x, p.y, req.z)) return null;
  }

  // Descent per radian of orbit.
  const pitch = rh * Math.tan(angle);
  const builder = pathFrom(point(req.x, req.y, req.fromZ, "work"));

  let theta = 0;
  let z = req.fromZ;
  const stepTheta = Math.PI / 8;
  const guard = 100_000;
  let iterations = 0;

  while (z > req.z + 1e-9 && iterations++ < guard) {
    theta += stepTheta;
    z = Math.max(req.z, req.fromZ - theta * pitch);
    const p = at(theta);
    builder.lineTo(point(p.x, p.y, z, "work"));
  }

  // Complete the revolution at depth, ending back at the entry point.
  const endTheta = Math.ceil(theta / (2 * Math.PI)) * 2 * Math.PI;
  while (theta < endTheta - 1e-9 && iterations++ < guard) {
    theta = Math.min(endTheta, theta + stepTheta);
    const p = at(theta);
    builder.lineTo(point(p.x, p.y, req.z, "work"));
  }

  builder.lineTo(point(req.x, req.y, req.z, "work"));
  return builder.isEmpty ? null : builder.build();
}

/**
 * Zig-zag ramp along the cut direction: descend on the way out, descend again on
 * the way back, until at depth. Always finishes at the entry point.
 */
function tryRamp(req: EntryRequest, angle: number): Path<"work"> | null {
  const length = Math.min(
    Math.max(2 * req.toolRadius, 2),
    Math.max(0, req.available * 0.9),
  );
  if (length < 0.8) return null;

  const drop = length * Math.tan(angle);
  const builder = pathFrom(point(req.x, req.y, req.fromZ, "work"));

  let z = req.fromZ;
  let atFar = false;
  let iterations = 0;

  while (z > req.z + 1e-9 && iterations++ < 100_000) {
    z = Math.max(req.z, z - drop);
    atFar = !atFar;
    builder.lineTo(point(
      req.x + (atFar ? length * req.dirX : 0),
      req.y + (atFar ? length * req.dirY : 0),
      z,
      "work",
    ));
  }

  // Always return to the nominal start so the following cut begins where the
  // strategy expects it to.
  if (atFar) builder.lineTo(point(req.x, req.y, req.z, "work"));

  return builder.isEmpty ? null : builder.build();
}

/** Ramp length needed to descend `depth` at `angleDeg`. Used for feasibility. */
export const rampLengthFor = (depth: number, angleDeg: number) =>
  mm(depth / Math.tan((Math.max(0.5, angleDeg) * Math.PI) / 180));
