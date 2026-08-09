/**
 * @cam/compiler/recertify — fold post-emission evidence into the certificate.
 *
 * Exact checks run before emission (they only need the canonical program).
 * SAMPLED checks need the emitted motion, because that is where traverses have
 * been decomposed into real moves and arcs resolved into geometry. So the honest
 * sequence is:
 *
 *     validate (exact)  ->  emit  ->  simulate  ->  recertify
 *
 * `recertify` produces a NEW ValidatedProgram carrying the upgraded certificate.
 * It cannot upgrade a program that failed validation — there is nothing to
 * upgrade — which is exactly the property the brand exists to enforce.
 */

import type { Mm } from "@cam/units";
import type {
  CheckStatus, Diagnostic, ErrorContribution, SafetyCertificate, ValidatedProgram,
} from "@cam/ir";
import { unsafeCertify } from "@cam/ir";

export interface SampledEvidence {
  readonly spatialResolution: Mm;
  readonly numericalTolerance: Mm;
  /** Diagnostics produced by the sampled checks. */
  readonly diagnostics: readonly Diagnostic[];
  /** Extra error-budget contributions discovered during emission. */
  readonly contributions?: readonly ErrorContribution[];
}

export function recertify(
  program: ValidatedProgram,
  evidence: SampledEvidence,
): ValidatedProgram {
  const sampled: CheckStatus = {
    kind: "verified-to-resolution",
    spatial: evidence.spatialResolution,
    numerical: evidence.numericalTolerance,
  };

  const previous = program.certificate;
  const contributions = [
    ...previous.errorBudget.contributions,
    ...(evidence.contributions ?? []),
  ];
  const total = contributions.reduce((a, c) => a + c.geometric, 0);

  const certificate: SafetyCertificate = {
    ...previous,
    // Only upgrade checks that were previously unrun. An "unverifiable" verdict
    // caused by a raw escape must NOT be washed away by simulation evidence:
    // the simulator cannot model what the escape does either.
    gouge: previous.gouge.kind === "not-checked" ? sampled : previous.gouge,
    rapidCrash: previous.rapidCrash.kind === "not-checked" ? sampled : previous.rapidCrash,
    errorBudget: { contributions, totalGeometric: total as Mm },
    warnings: [...previous.warnings, ...evidence.diagnostics.filter((d) => d.severity !== "error")],
  };

  return unsafeCertify(program, certificate);
}

/** Errors found by sampled checks. These invalidate a previously-passing program. */
export function sampledErrors(evidence: SampledEvidence): readonly Diagnostic[] {
  return evidence.diagnostics.filter((d) => d.severity === "error");
}
