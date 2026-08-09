/**
 * @cam/compiler/lower — canonical IR to machine IR.
 *
 * Lowering resolves everything that depends on WHICH machine we are targeting,
 * driven entirely by the capability record. There is no machine-specific
 * branching here; adding a controller means adding a profile.
 *
 * Currently lowering does two things:
 *  - linearizes arcs the machine cannot interpolate (a Makera target has no
 *    arcs at all, so fitted arcs are sampled straight back out)
 *  - clamps feeds to the machine maximum, with a diagnostic
 *
 * Traverse decomposition is deliberately NOT done here: it is the
 * postprocessor's job, because whether a traverse becomes one block or three is
 * an encoding question, not a semantic one.
 *
 * Design doc: Part XI.3.
 */

import type { Mm } from "@cam/units";
import { mm } from "@cam/units";
import type { CanonicalCommand, CanonicalProgram, CutCmd, Diagnostic, MachineProgram, Path, Segment } from "@cam/ir";
import { arcPlane, info, sampleArc, warning } from "@cam/ir";
import type { MachineProfile } from "@cam/machine";
import { supportsArcPlane } from "@cam/machine";

export function lower(
  program: CanonicalProgram,
  machine: MachineProfile,
): MachineProgram {
  const diagnostics: Diagnostic[] = [];
  const commands: CanonicalCommand[] = [];
  let linearizedArcs = 0;

  for (const cmd of program.commands) {
    if (cmd.kind !== "cut") {
      commands.push(cmd);
      continue;
    }

    let next: CutCmd = cmd;

    if (cmd.feed > machine.maxFeed) {
      diagnostics.push(warning("feed.outOfRange",
        `feed ${cmd.feed} mm/min clamped to the machine maximum ${machine.maxFeed} mm/min`,
        { provenance: cmd.provenance }));
      next = { ...next, feed: machine.maxFeed };
    }

    const { path, linearized } = lowerArcs(next.path, machine, next.tolerance);
    linearizedArcs += linearized;
    if (linearized > 0) next = { ...next, path };

    commands.push(next);
  }

  if (linearizedArcs > 0) {
    diagnostics.push(info("dialect.arcLinearized",
      `${linearizedArcs} arc(s) linearized — ${machine.name} cannot interpolate them`,
      { detail: { count: linearizedArcs } }));
  }

  return {
    ...program,
    commands,
    machineId: machine.id,
    loweringDiagnostics: diagnostics,
  };
}

/**
 * Replace arcs the machine cannot express with sampled polylines.
 *
 * This is the payoff of keeping arcs geometric in the IR: linearization is a
 * local, capability-driven rewrite rather than a lossy step backwards through a
 * G-code-flavoured representation.
 */
export function lowerArcs(
  path: Path,
  machine: MachineProfile,
  tolerance: Mm,
): { path: Path; linearized: number } {
  let linearized = 0;
  const segments: Segment[] = [];
  let cursor = path.start;

  for (const seg of path.segments) {
    if (seg.kind !== "arc") {
      segments.push(seg);
      cursor = seg.kind === "line" ? seg.to : lastOfPoly(seg, cursor);
      continue;
    }

    const plane = arcPlane(seg.axis);
    const expressible = plane !== null && supportsArcPlane(machine, plane);

    if (expressible) {
      segments.push(seg);
    } else {
      const pts = sampleArc(seg, cursor, tolerance);
      const flat = new Float64Array(pts.length * 3);
      for (let i = 0; i < pts.length; i++) {
        flat[i * 3] = pts[i].x;
        flat[i * 3 + 1] = pts[i].y;
        flat[i * 3 + 2] = pts[i].z;
      }
      segments.push({ kind: "poly", pts: flat, frame: path.frame });
      linearized++;
    }
    cursor = seg.to;
  }

  if (linearized === 0) return { path, linearized: 0 };
  return { path: { ...path, segments }, linearized };
}

function lastOfPoly(seg: Extract<Segment, { kind: "poly" }>, fallback: Path["start"]) {
  const n = seg.pts.length;
  if (n < 3) return fallback;
  return { x: seg.pts[n - 3] as Mm, y: seg.pts[n - 2] as Mm, z: seg.pts[n - 1] as Mm,
    frame: seg.frame };
}

/** Estimated arc-fit contribution to the error budget, for the certificate. */
export const arcFitContribution = (tolerance: number) => ({
  stage: "arc-fit",
  geometric: mm(tolerance),
  rationale: "arcs are fitted to within this deviation of the source polyline",
});
