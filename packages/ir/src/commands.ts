/**
 * @cam/ir/commands — the canonical machining IR.
 *
 * NON-MODAL BY CONSTRUCTION. Every cut carries its own feed; every spindle
 * command carries its own speed; every arc carries its own geometry. Nothing
 * inherits anything from a previous command.
 *
 * This is the central design commitment (ADR-002). G-code's modal state is the
 * primary source of machining bugs — a bare `X70` means something different
 * depending on lines that may be thousands of blocks earlier. By refusing
 * modality in the source language, any command can be inspected, reordered,
 * filtered or transformed in isolation, and modality re-enters only as a
 * compression pass in the postprocessor where it is one testable function.
 *
 * Note there is no `G0` here. A `Traverse` states an INTENT — get there safely —
 * and the postprocessor decides whether that becomes one coordinated rapid or a
 * retract/move/descend sequence, based on machine capabilities.
 *
 * Design doc: Part IV.4.
 */

import type { Mm, MmPerMin, Rpm, Seconds } from "@cam/units";
import type { FrameId, Point3, UnitVec3 } from "@cam/math";
import type { Path } from "./path.js";
import type { Provenance } from "./provenance.js";

export type ToolId = string;

export interface ToolRef {
  readonly id: ToolId;
  /** T-word. Resolved from the tool table at plan time. */
  readonly number: number;
}

/** What a cutting move is FOR. Drives colouring, statistics and feed defaults. */
export type CuttingPurpose =
  | "rough"
  | "finish"
  | "plunge"
  | "ramp"
  | "lead-in"
  | "lead-out";

/**
 * How to reach a point safely. The postprocessor turns this into motion.
 * `allowCoordinated` is false when the controller's rapids are not guaranteed
 * to follow a straight line, in which case the move must be decomposed.
 */
export interface ClearanceRequirement {
  readonly safeZ: Mm;
  readonly allowCoordinated: boolean;
}

export interface ToolChangeCmd {
  readonly kind: "tool-change";
  readonly tool: ToolRef;
  readonly provenance: Provenance;
}

export type SpindleState =
  | { readonly mode: "off" }
  | { readonly mode: "cw" | "ccw"; readonly speed: Rpm };

export interface SpindleCmd {
  readonly kind: "spindle";
  readonly state: SpindleState;
  readonly provenance: Provenance;
}

export interface CoolantCmd {
  readonly kind: "coolant";
  readonly state: "off" | "flood" | "mist";
  readonly provenance: Provenance;
}

export interface TraverseCmd<F extends FrameId = FrameId> {
  readonly kind: "traverse";
  readonly to: Point3<F>;
  readonly clearance: ClearanceRequirement;
  readonly provenance: Provenance;
}

export interface CutCmd<F extends FrameId = FrameId> {
  readonly kind: "cut";
  readonly path: Path<F>;
  /** Always present. Never inherited from a previous command. */
  readonly feed: MmPerMin;
  /** The chord tolerance this path was built to — feeds the error budget. */
  readonly tolerance: Mm;
  readonly purpose: CuttingPurpose;
  readonly tool: ToolRef;
  readonly provenance: Provenance;
}

export interface ProbeCmd<F extends FrameId = FrameId> {
  readonly kind: "probe";
  readonly direction: UnitVec3;
  readonly maxTravel: Mm;
  readonly feed: MmPerMin;
  readonly onFailure: "abort" | "continue";
  /** Name to bind the measured point to, for later reference. */
  readonly bind: string;
  readonly from: Point3<F>;
  readonly provenance: Provenance;
}

export interface DwellCmd {
  readonly kind: "dwell";
  readonly duration: Seconds;
  readonly provenance: Provenance;
}

export interface PauseCmd {
  readonly kind: "pause";
  readonly message?: string;
  readonly provenance: Provenance;
}

export interface CommentCmd {
  readonly kind: "comment";
  readonly text: string;
  readonly provenance: Provenance;
}

/**
 * Explicitly unanalysable escape hatch. Its presence downgrades the safety
 * certificate to "unverifiable" — the verifier cannot reason about what the
 * controller will do with it. Deliberately awkward to use.
 */
export interface RawCmd {
  readonly kind: "raw";
  readonly text: string;
  readonly dialect: string;
  readonly effects: readonly string[];
  readonly provenance: Provenance;
}

export type CanonicalCommand<F extends FrameId = FrameId> =
  | ToolChangeCmd
  | SpindleCmd
  | CoolantCmd
  | TraverseCmd<F>
  | CutCmd<F>
  | ProbeCmd<F>
  | DwellCmd
  | PauseCmd
  | CommentCmd
  | RawCmd;

/** A command that moves the tool. */
export type MotionCommand<F extends FrameId = FrameId> =
  | TraverseCmd<F>
  | CutCmd<F>
  | ProbeCmd<F>;

export function isMotion<F extends FrameId>(c: CanonicalCommand<F>): c is MotionCommand<F> {
  return c.kind === "traverse" || c.kind === "cut" || c.kind === "probe";
}

export interface Stock {
  readonly x: Mm;
  readonly y: Mm;
  readonly z: Mm;
  /** Position of the stock's minimum corner in the work frame. */
  readonly originX: Mm;
  readonly originY: Mm;
  /** Z of the stock's top face in the work frame. Usually 0. */
  readonly topZ: Mm;
}

export interface Setup {
  readonly stock: Stock;
  readonly clearance: Mm;
  readonly workOffset: string;
}

/**
 * A machine-independent program: canonical commands plus the setup they assume.
 * This is the "narrow waist" every other subsystem agrees on.
 */
export interface CanonicalProgram<F extends FrameId = FrameId> {
  readonly setup: Setup;
  readonly commands: readonly CanonicalCommand<F>[];
  readonly tools: ReadonlyMap<ToolId, ToolRef>;
}
