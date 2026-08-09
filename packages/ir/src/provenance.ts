/**
 * @cam/ir/provenance — where a command came from, and what went wrong.
 *
 * Every lowering pass must carry provenance forward. Without it a diagnostic can
 * only say "exceeds X travel"; with it, it can say "finishSurface #2, script
 * line 34, path 41, segment 307 exceeds X travel by 1.42 mm" — which is the
 * difference between a usable tool and a frustrating one.
 *
 * Design doc: Part IV.7.
 */

export type OperationId = string;

export interface SourceLocation {
  readonly line: number;
  readonly column: number;
}

export interface Provenance {
  readonly operationId: OperationId;
  readonly strategyName?: string;
  readonly pathIndex?: number;
  readonly segmentIndex?: number;
  /** Where in the user's script this originated, when it can be determined. */
  readonly script?: SourceLocation;
}

/** Provenance for machinery that has no user-visible source (defaults, prologue). */
export const SYNTHETIC: Provenance = { operationId: "<synthetic>" };

export function provenance(operationId: OperationId, extra: Partial<Provenance> = {}): Provenance {
  return { operationId, ...extra };
}

/** Narrow an existing provenance to a specific path/segment within the operation. */
export function withinPath(p: Provenance, pathIndex: number, segmentIndex?: number): Provenance {
  return segmentIndex === undefined
    ? { ...p, pathIndex }
    : { ...p, pathIndex, segmentIndex };
}

export type Severity = "error" | "warning" | "info";

/**
 * Stable diagnostic codes. Stable because the UI, the tests and eventually the
 * docs all key off them; the human-readable message may be reworded freely.
 */
export type DiagnosticCode =
  // interlocks
  | "interlock.noTool"
  | "interlock.spindleOff"
  | "interlock.noFeed"
  | "interlock.toolChangeSpindle"
  // machine limits
  | "travel.exceeded"
  | "spindle.outOfRange"
  | "feed.outOfRange"
  // geometry
  | "arc.radiusMismatch"
  | "arc.unsupportedPlane"
  | "path.discontinuous"
  | "move.suspiciousLength"
  // stock and safety
  | "rapid.belowSafeZ"
  | "rapid.throughStock"
  | "stock.spoilboard"
  | "gouge.detected"
  // program structure
  | "program.spindleLeftOn"
  | "program.noMotion"
  // dialect
  | "dialect.unknownCode"
  | "dialect.arcLinearized"
  | "dialect.rawEscape"
  // script surface
  | "units.bareNumber"
  | "units.lateSwitch"
  | "script.error"
  | "entry.degraded"
  | "tolerance.budgetExceeded";

export interface Diagnostic {
  readonly severity: Severity;
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly provenance?: Provenance;
  /** Populated after emission, when the diagnostic maps to an output line. */
  readonly gcodeLine?: number;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export const error = (
  code: DiagnosticCode,
  message: string,
  extra: Partial<Diagnostic> = {},
): Diagnostic => ({ severity: "error", code, message, ...extra });

export const warning = (
  code: DiagnosticCode,
  message: string,
  extra: Partial<Diagnostic> = {},
): Diagnostic => ({ severity: "warning", code, message, ...extra });

export const info = (
  code: DiagnosticCode,
  message: string,
  extra: Partial<Diagnostic> = {},
): Diagnostic => ({ severity: "info", code, message, ...extra });

export const hasErrors = (ds: readonly Diagnostic[]): boolean =>
  ds.some((d) => d.severity === "error");

export function countBySeverity(ds: readonly Diagnostic[]): Record<Severity, number> {
  const out: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const d of ds) out[d.severity]++;
  return out;
}

/** Render a provenance chain the way the UI shows it. */
export function describeProvenance(p: Provenance | undefined): string {
  if (!p) return "";
  const bits: string[] = [p.operationId];
  if (p.strategyName) bits.push(`(${p.strategyName})`);
  if (p.script) bits.push(`script ${p.script.line}:${p.script.column}`);
  if (p.pathIndex !== undefined) bits.push(`path ${p.pathIndex}`);
  if (p.segmentIndex !== undefined) bits.push(`segment ${p.segmentIndex}`);
  return bits.join(" · ");
}
