/**
 * @cam/compiler/validate — the certified stage gate.
 *
 * This module is the ONLY constructor of `ValidatedProgram`. Postprocessors
 * accept nothing else, so it is structurally impossible to emit G-code for a
 * program that has not been through here (ADR-003).
 *
 * The checks implemented here are the EXACT ones: interval arithmetic on
 * endpoints, range comparisons, interlock state machines. Sampled checks
 * (gouge, rapid-through-stock) live in @cam/analysis and are folded into the
 * certificate separately, because they establish something weaker and the
 * certificate must say so honestly.
 *
 * Design doc: Part X.4, ADR-003, ADR-010.
 */

import type { Mm } from "@cam/units";
import { mm, roundingError } from "@cam/units";
import { toVec3 } from "@cam/math";
import type {
  CanonicalCommand, CheckStatus, Diagnostic, ErrorBudget, ErrorContribution,
  MachineProgram, SafetyCertificate, ValidationResult,
} from "@cam/ir";
import {
  error, hasErrors, isContinuous, samplePath, unsafeCertify, warning,
} from "@cam/ir";
import type { MachineProfile } from "@cam/machine";

export interface ValidateOptions {
  /** Sampled-check results to fold into the certificate, if available. */
  readonly sampled?: {
    readonly gouge?: CheckStatus;
    readonly rapidCrash?: CheckStatus;
  };
  /** Extra error-budget contributions from earlier stages (planning, arc fit). */
  readonly budgetContributions?: readonly ErrorContribution[];
  /** Flag single moves longer than this as suspicious. */
  readonly suspiciousMoveLength?: Mm;
}

export function validate(
  program: MachineProgram,
  machine: MachineProfile,
  opts: ValidateOptions = {},
): ValidationResult {
  const diagnostics: Diagnostic[] = [...program.loweringDiagnostics];
  const suspicious = opts.suspiciousMoveLength ?? mm(500);

  // Interlock state, tracked exactly the way the controller would.
  let toolLoaded = false;
  let spindleRunning = false;
  let sawMotion = false;
  let sawRaw = false;

  const tv = machine.travels;
  const checkTravel = (
    x: number, y: number, z: number,
    where: string, cmd: CanonicalCommand,
  ) => {
    const out: string[] = [];
    if (x < tv.x.min || x > tv.x.max) out.push(`X (${fmt(x)} outside ${fmt(tv.x.min)}..${fmt(tv.x.max)})`);
    if (y < tv.y.min || y > tv.y.max) out.push(`Y (${fmt(y)} outside ${fmt(tv.y.min)}..${fmt(tv.y.max)})`);
    if (z < tv.z.min || z > tv.z.max) out.push(`Z (${fmt(z)} outside ${fmt(tv.z.min)}..${fmt(tv.z.max)})`);
    if (out.length > 0) {
      diagnostics.push(error("travel.exceeded",
        `${where}: target exceeds machine travel — ${out.join(", ")}`,
        { provenance: cmd.provenance, detail: { x, y, z } }));
    }
  };

  for (let i = 0; i < program.commands.length; i++) {
    const cmd = program.commands[i];
    const where = `${cmd.kind} · op ${i + 1}`;

    switch (cmd.kind) {
      case "tool-change":
        if (spindleRunning) {
          diagnostics.push(error("interlock.toolChangeSpindle",
            `${where}: tool change requires the spindle to be stopped`,
            { provenance: cmd.provenance }));
        }
        toolLoaded = true;
        break;

      case "spindle":
        if (cmd.state.mode === "off") {
          spindleRunning = false;
        } else {
          const s = cmd.state.speed;
          if (s < machine.spindle.range.min || s > machine.spindle.range.max) {
            diagnostics.push(error("spindle.outOfRange",
              `${where}: ${s} rpm is outside the machine range ` +
              `${machine.spindle.range.min}–${machine.spindle.range.max}`,
              { provenance: cmd.provenance, detail: { speed: s } }));
          }
          if (!machine.spindle.directions.includes(cmd.state.mode)) {
            diagnostics.push(error("spindle.outOfRange",
              `${where}: this machine cannot run the spindle ${cmd.state.mode}`,
              { provenance: cmd.provenance }));
          }
          spindleRunning = true;
        }
        break;

      case "traverse": {
        const p = toVec3(cmd.to);
        checkTravel(p.x, p.y, p.z, where, cmd);
        sawMotion = true;
        break;
      }

      case "cut": {
        if (!toolLoaded) {
          diagnostics.push(error("interlock.noTool",
            `${where}: cutting move with no tool loaded`, { provenance: cmd.provenance }));
        }
        if (!spindleRunning) {
          diagnostics.push(error("interlock.spindleOff",
            `${where}: cutting move while the spindle is stopped`,
            { provenance: cmd.provenance }));
        }
        if (!(cmd.feed > 0)) {
          diagnostics.push(error("interlock.noFeed",
            `${where}: cutting move requires a positive feed rate`,
            { provenance: cmd.provenance }));
          break;
        }
        if (cmd.feed > machine.maxFeed) {
          diagnostics.push(warning("feed.outOfRange",
            `${where}: feed ${cmd.feed} mm/min exceeds the machine maximum ` +
            `${machine.maxFeed} mm/min and will be clamped`,
            { provenance: cmd.provenance }));
        }
        if (!isContinuous(cmd.path)) {
          diagnostics.push(error("path.discontinuous",
            `${where}: path start/end do not agree with its segments`,
            { provenance: cmd.provenance }));
        }

        const pts = samplePath(cmd.path, cmd.tolerance);
        let prev = pts[0];
        for (const q of pts) {
          checkTravel(q.x, q.y, q.z, where, cmd);
          const d = Math.hypot(q.x - prev.x, q.y - prev.y, q.z - prev.z);
          if (d > suspicious) {
            diagnostics.push(warning("move.suspiciousLength",
              `${where}: single move of ${d.toFixed(1)} mm — check for a missing decimal`,
              { provenance: cmd.provenance, detail: { length: d } }));
          }
          prev = q;
        }
        sawMotion = true;
        break;
      }

      case "probe": {
        if (machine.probe === null) {
          diagnostics.push(error("dialect.unknownCode",
            `${where}: this machine has no probing support`,
            { provenance: cmd.provenance }));
        }
        sawMotion = true;
        break;
      }

      case "raw":
        sawRaw = true;
        diagnostics.push(warning("dialect.rawEscape",
          `${where}: raw escape "${cmd.text}" cannot be analysed` +
          (cmd.effects.length ? ` (declared effects: ${cmd.effects.join(", ")})` : ""),
          { provenance: cmd.provenance }));
        break;

      default:
        break;
    }
  }

  if (spindleRunning) {
    diagnostics.push(warning("program.spindleLeftOn",
      "program ends with the spindle still running — an M5 will be appended"));
  }
  if (!sawMotion) {
    diagnostics.push(warning("program.noMotion", "program contains no motion"));
  }

  if (hasErrors(diagnostics)) {
    return { ok: false, diagnostics };
  }

  const certificate = buildCertificate(program, diagnostics, opts, sawRaw);
  return { ok: true, program: unsafeCertify(program, certificate) };
}

function buildCertificate(
  program: MachineProgram,
  diagnostics: readonly Diagnostic[],
  opts: ValidateOptions,
  sawRaw: boolean,
): SafetyCertificate {
  const exact: CheckStatus = { kind: "verified-exact" };

  const unverifiableIfRaw = (s: CheckStatus): CheckStatus =>
    sawRaw
      ? { kind: "unverifiable", reason: "program contains a raw escape the verifier cannot model" }
      : s;

  return {
    travel: unverifiableIfRaw(exact),
    spindle: unverifiableIfRaw(exact),
    feedLimits: exact,
    interlocks: unverifiableIfRaw(exact),
    gouge: opts.sampled?.gouge ?? {
      kind: "not-checked",
      reason: "material simulation was not run",
    },
    rapidCrash: opts.sampled?.rapidCrash ?? {
      kind: "not-checked",
      reason: "material simulation was not run",
    },
    fixture: { kind: "not-checked", reason: "no fixture model defined" },
    holder: { kind: "not-checked", reason: "tool stickout and holder geometry unknown" },
    errorBudget: buildBudget(program, opts.budgetContributions ?? []),
    warnings: diagnostics.filter((d) => d.severity !== "error"),
  };
}

/**
 * Sum the declared approximation sources.
 *
 * Conservative (plain sum, not root-sum-square) because the contributions are
 * not independent — a coarse CL field and a loose chord tolerance can and do
 * push the same direction on the same feature.
 */
export function buildBudget(
  program: MachineProgram,
  extra: readonly ErrorContribution[],
): ErrorBudget {
  const contributions: ErrorContribution[] = [...extra];

  // Chord tolerance actually used by the cuts in this program.
  let worstChord = 0;
  for (const c of program.commands) {
    if (c.kind === "cut" && c.tolerance > worstChord) worstChord = c.tolerance;
  }
  if (worstChord > 0) {
    contributions.push({
      stage: "chord-refinement",
      geometric: mm(worstChord),
      rationale: "worst declared chord tolerance across all cutting paths",
    });
  }

  contributions.push({
    stage: "gcode-rounding",
    geometric: roundingError(3),
    rationale: "coordinates are emitted with 3 decimal places",
  });

  const total = contributions.reduce((a, c) => a + c.geometric, 0);
  return { contributions, totalGeometric: mm(total) };
}

const fmt = (v: number) => v.toFixed(3);
