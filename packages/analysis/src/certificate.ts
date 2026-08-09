/**
 * @cam/analysis/certificate — say what was actually verified.
 *
 * A boolean `safe: true` invites trust the evidence does not support. In a
 * domain where the failure mode is a broken tool or a scrapped part, the tool
 * should state WHAT it checked and TO WHAT RESOLUTION, and should list what it
 * did not check at all. Unchecked items then become a visible backlog rather
 * than an invisible gap.
 *
 * This is ADR-010, and it is the reason `CheckStatus` is a four-way union rather
 * than a boolean.
 *
 * Design doc: Part X.2, X.3.
 */

import type { Mm } from "@cam/units";
import { mm } from "@cam/units";
import type {
  CheckStatus, Diagnostic, ErrorBudget, ErrorContribution, SafetyCertificate,
} from "@cam/ir";
import { warning } from "@cam/ir";

export interface CertificateInputs {
  /** Present when the material simulation ran. */
  readonly simulation?: {
    readonly spatialResolution: Mm;
    readonly numericalTolerance: Mm;
    readonly gougeDepth: number;
    readonly rapidCrashDepth: number;
  };
  /** True if the program contains a raw escape the verifier cannot model. */
  readonly hasRawEscape: boolean;
  readonly budget: ErrorBudget;
  readonly warnings: readonly Diagnostic[];
}

export function buildCertificate(inputs: CertificateInputs): SafetyCertificate {
  const exact: CheckStatus = { kind: "verified-exact" };

  const unverifiable = (s: CheckStatus): CheckStatus =>
    inputs.hasRawEscape
      ? {
          kind: "unverifiable",
          reason: "program contains a raw escape whose effects the verifier cannot model",
        }
      : s;

  const sampled: CheckStatus = inputs.simulation
    ? {
        kind: "verified-to-resolution",
        spatial: inputs.simulation.spatialResolution,
        numerical: inputs.simulation.numericalTolerance,
      }
    : { kind: "not-checked", reason: "material simulation was not run" };

  return {
    travel: unverifiable(exact),
    spindle: unverifiable(exact),
    feedLimits: exact,
    interlocks: unverifiable(exact),
    gouge: sampled,
    rapidCrash: sampled,
    fixture: { kind: "not-checked", reason: "no fixture model has been defined" },
    holder: {
      kind: "not-checked",
      reason: "tool stickout and holder geometry are unknown",
    },
    errorBudget: inputs.budget,
    warnings: inputs.warnings,
  };
}

/**
 * Sum approximation sources conservatively.
 *
 * Plain sum, NOT root-sum-square: the contributions are not independent. A
 * coarse CL field and a loose chord tolerance can push the same direction on the
 * same feature, and a safety figure should assume they do.
 */
export function buildErrorBudget(contributions: readonly ErrorContribution[]): ErrorBudget {
  const total = contributions.reduce((a, c) => a + c.geometric, 0);
  return { contributions: [...contributions], totalGeometric: mm(total) };
}

/**
 * Warn when a requested finish is not achievable given the budget.
 *
 * Asking for a 0.005 mm scallop while arc fitting runs at 0.010 mm tolerance is
 * self-defeating, and without an explicit budget nothing would ever say so.
 */
export function checkBudgetAgainstRequest(
  budget: ErrorBudget,
  requestedFinish: number,
): Diagnostic[] {
  if (requestedFinish <= 0) return [];
  if (budget.totalGeometric <= requestedFinish) return [];

  const worst = [...budget.contributions].sort((a, b) => b.geometric - a.geometric)[0];
  return [warning("tolerance.budgetExceeded",
    `requested finish of ${requestedFinish.toFixed(4)} mm is below the pipeline's total ` +
    `geometric error budget of ${budget.totalGeometric.toFixed(4)} mm` +
    (worst ? ` (dominated by ${worst.stage} at ${worst.geometric.toFixed(4)} mm)` : "") +
    " — the finish will be limited by the budget, not by the request",
    { detail: { requested: requestedFinish, budget: budget.totalGeometric } })];
}

/** Human-readable certificate, as the UI renders it. */
export function formatCertificate(cert: SafetyCertificate): string {
  const rows: [string, CheckStatus][] = [
    ["travel limits", cert.travel],
    ["spindle range", cert.spindle],
    ["feed limits", cert.feedLimits],
    ["interlocks", cert.interlocks],
    ["gouge", cert.gouge],
    ["rapid-through-stock", cert.rapidCrash],
    ["fixture collision", cert.fixture],
    ["holder collision", cert.holder],
  ];

  const lines = rows.map(([label, status]) => {
    const glyph = status.kind === "verified-exact" || status.kind === "verified-to-resolution"
      ? "PASS" : status.kind === "not-checked" ? "SKIP" : "UNKN";
    return `  ${glyph}  ${label.padEnd(22)}${describeStatus(status)}`;
  });

  const budget = cert.errorBudget;
  const parts = budget.contributions
    .map((c) => `${c.stage} ${c.geometric.toFixed(4)}`)
    .join(" · ");

  return [
    "SAFETY CERTIFICATE",
    ...lines,
    `  error budget           ${budget.totalGeometric.toFixed(4)} mm` +
      (parts ? `  (${parts})` : ""),
    cert.warnings.length > 0 ? `  ${cert.warnings.length} warning(s)` : "  no warnings",
  ].join("\n");
}

function describeStatus(s: CheckStatus): string {
  switch (s.kind) {
    case "verified-exact":
      return "exact";
    case "verified-to-resolution":
      return `verified to ${s.spatial.toFixed(3)} mm grid, ${s.numerical.toFixed(3)} mm tolerance`;
    case "not-checked":
      return `not checked — ${s.reason}`;
    case "unverifiable":
      return `unverifiable — ${s.reason}`;
  }
}

/** True only if nothing is unverifiable and every sampled check actually ran. */
export function isFullyVerified(cert: SafetyCertificate): boolean {
  const statuses = [
    cert.travel, cert.spindle, cert.feedLimits, cert.interlocks,
    cert.gouge, cert.rapidCrash,
  ];
  return statuses.every(
    (s) => s.kind === "verified-exact" || s.kind === "verified-to-resolution",
  );
}
