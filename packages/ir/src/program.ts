/**
 * @cam/ir/program — certified compilation stages.
 *
 * The prototype enforced "no G-code without validation" with a runtime check
 * (`gcode: hasErrors ? [] : gcode`). That is a convention a future refactor can
 * silently break. Here the stages are distinct TYPES, and `ValidatedProgram`
 * carries a non-exported unique symbol so nothing outside @cam/compiler can
 * synthesise one without an explicit, greppable double cast.
 *
 * This is an API-level proof that the pipeline ran — not a proof of machine
 * safety. What was actually checked, and to what resolution, is the job of the
 * SafetyCertificate.
 *
 * Design doc: Part IV.8, ADR-003.
 */

import type { Mm } from "@cam/units";
import type { FrameId } from "@cam/math";
import type { CanonicalProgram } from "./commands.js";
import type { Diagnostic } from "./provenance.js";

/**
 * A program lowered against a specific machine profile: arcs resolved to
 * capabilities, traverses expanded into concrete motion, feeds clamped.
 * Not yet checked.
 */
export interface MachineProgram<F extends FrameId = FrameId> extends CanonicalProgram<F> {
  readonly machineId: string;
  /** Diagnostics raised during lowering (e.g. "arc linearized"). */
  readonly loweringDiagnostics: readonly Diagnostic[];
}

/* --------------------------- error budgets ---------------------------- */

export interface ErrorContribution {
  readonly stage: string;
  readonly geometric: Mm;
  readonly rationale: string;
}

export interface ErrorBudget {
  readonly contributions: readonly ErrorContribution[];
  /** Conservative sum — we do not assume the contributions are independent. */
  readonly totalGeometric: Mm;
}

/* -------------------------- safety certificate ------------------------ */

export type CheckStatus =
  | { readonly kind: "verified-exact" }
  | { readonly kind: "verified-to-resolution"; readonly spatial: Mm; readonly numerical: Mm }
  | { readonly kind: "not-checked"; readonly reason: string }
  | { readonly kind: "unverifiable"; readonly reason: string };

export interface SafetyCertificate {
  readonly travel: CheckStatus;
  readonly spindle: CheckStatus;
  readonly feedLimits: CheckStatus;
  readonly interlocks: CheckStatus;
  readonly gouge: CheckStatus;
  readonly rapidCrash: CheckStatus;
  readonly fixture: CheckStatus;
  readonly holder: CheckStatus;
  readonly errorBudget: ErrorBudget;
  readonly warnings: readonly Diagnostic[];
}

/* ------------------------ the certified stage ------------------------- */

declare const validatedBrand: unique symbol;

/**
 * A machine program that has passed validation.
 *
 * Only `@cam/compiler`'s `validate()` can construct one. Postprocessors accept
 * nothing else.
 */
export interface ValidatedProgram<F extends FrameId = FrameId> extends MachineProgram<F> {
  readonly [validatedBrand]: true;
  readonly certificate: SafetyCertificate;
}

/**
 * INTERNAL. Exported only so `@cam/compiler` can mint the brand; it is not part
 * of the public surface and calling it elsewhere defeats ADR-003.
 *
 * @internal
 */
export function unsafeCertify<F extends FrameId>(
  program: MachineProgram<F>,
  certificate: SafetyCertificate,
): ValidatedProgram<F> {
  return { ...program, certificate } as ValidatedProgram<F>;
}

export type ValidationResult<F extends FrameId = FrameId> =
  | { readonly ok: true; readonly program: ValidatedProgram<F> }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/* --------------------------- render buffers --------------------------- */

/** Move classification, parallel to `positions`. Kept as a byte for compactness. */
export const MoveKind = {
  Traverse: 0,
  Plunge: 1,
  Rough: 2,
  Finish: 3,
  Ramp: 4,
  Probe: 5,
} as const;

export type MoveKindValue = (typeof MoveKind)[keyof typeof MoveKind];

/**
 * Flattened, transferable representation for rendering and playback.
 *
 * This is deliberately a separate artifact from the program: `Path` objects with
 * `Point3` members are the right AUTHORING representation and the wrong
 * TRANSPORT representation. Workers post these across with zero copy.
 */
export interface RenderBuffers {
  /** xyz-interleaved, length = 3 * count. */
  readonly positions: Float32Array;
  /** One MoveKind per point, length = count. */
  readonly kinds: Uint8Array;
  /** Cumulative seconds at each point, length = count. */
  readonly times: Float64Array;
  /** Index of the emitted G-code line for each point, or -1. */
  readonly gcodeLines: Int32Array;
  readonly count: number;
  readonly totalSeconds: number;
  readonly minZ: number;
  readonly maxZ: number;
}
