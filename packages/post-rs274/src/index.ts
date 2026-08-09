/**
 * @cam/post-rs274 — the generic RS-274 backend.
 *
 * Takes a ValidatedProgram and produces G-code. Everything dialect-specific
 * lives in `Rs274Options`, so the Makera and LinuxCNC backends are configuration
 * plus a header/footer hook rather than forked emitters.
 *
 * The emitter produces FULLY EXPLICIT blocks — every axis word, every feed, on
 * every line. Redundancy is then removed by `compress()` in @cam/compiler. That
 * split is what makes the round-trip property test meaningful: the pre-
 * compression blocks are the ground truth, and compression must preserve them.
 */

import type { Mm } from "@cam/units";
import type { FrameId, Point3, Vec3 } from "@cam/math";
import { distance, toVec3, vec3 } from "@cam/math";
import type {
  ArcSegment, CanonicalCommand, CutCmd, Provenance, TraverseCmd, ValidatedProgram,
} from "@cam/ir";
import { arcPlane, sampleArc, SYNTHETIC } from "@cam/ir";
import type { GCodeBlock, GCodeDocument, MotionWord, PlaneWord } from "@cam/compiler";
import { compress, toDocument } from "@cam/compiler";
import type { MachineProfile } from "@cam/machine";
import { supportsArcPlane } from "@cam/machine";

export interface Rs274Options {
  /** Emitted before any motion. Defaults to the usual mm/absolute/XY preamble. */
  readonly preamble?: readonly string[];
  /** Program-end code. `M30` is the norm; Makera uses `M02`. */
  readonly programEnd?: string;
  readonly commentStyle?: "parens" | "semicolon";
  readonly decimals?: number;
  /** Extra lines at the very top (structured headers, thumbnails, etc.). */
  readonly header?: (p: ValidatedProgram) => readonly string[];
  /** Extra lines at the very bottom. */
  readonly footer?: (p: ValidatedProgram) => readonly string[];
  /** Emit `;@…|TOOLPATH_START|…` style markers between operations. */
  readonly operationMarker?: (operationId: string, index: number) => string | null;
  readonly compressOutput?: boolean;
}

/**
 * One entry of the motion timeline. Emission builds this alongside the blocks
 * so the UI can map a G-code line to a position in time and back.
 */
export interface EmittedMotion {
  readonly kind: "rapid" | "cut";
  readonly from: Vec3;
  readonly to: Vec3;
  readonly feed: number;
  readonly seconds: number;
  readonly gcodeLine: number;
  /**
   * T-number in effect for this motion.
   *
   * Downstream simulation needs to know which cutter was in the spindle, and
   * reconstructing that by re-walking the command stream in parallel is both
   * fiddly and easy to get subtly wrong. The emitter already tracks it, so it
   * publishes it.
   */
  readonly toolNumber: number | null;
  readonly provenance: Provenance;
}

export interface EmitResult {
  readonly document: GCodeDocument;
  readonly motions: readonly EmittedMotion[];
  readonly totalSeconds: number;
  /** Blocks before modal compression — the ground truth for round-trip tests. */
  readonly rawBlocks: readonly GCodeBlock[];
}

export function emitRs274(
  program: ValidatedProgram,
  machine: MachineProfile,
  opts: Rs274Options = {},
): EmitResult {
  const decimals = opts.decimals ?? 3;
  const commentStyle = opts.commentStyle ?? "parens";
  const blocks: GCodeBlock[] = [];
  const motions: EmittedMotion[] = [];

  let cur: Vec3 = vec3(0, 0, program.setup.clearance);
  let seconds = 0;
  let lastOperationId: string | null = null;
  let activeToolNumber: number | null = null;

  const push = (b: GCodeBlock) => blocks.push(b);

  // Header lines are structured metadata, not prose: pass them through byte for
  // byte rather than routing them through comment formatting.
  for (const line of opts.header?.(program) ?? []) push({ verbatim: line, provenance: SYNTHETIC });

  for (const text of opts.preamble ?? ["G21", "G90", "G94", "G17"]) {
    push(rawLine(text));
  }

  /** Record one straight move: timeline entry + block. */
  const linear = (
    to: Vec3,
    mode: MotionWord,
    feed: number,
    prov: Provenance,
  ) => {
    const L = distance(cur, to);
    if (L < 1e-9) return;
    const rate = mode === "G0" ? machine.rapidRate : feed;
    const dt = (L / Math.max(rate, 1e-6)) * 60;
    const motionIndex = motions.length;

    push({
      motion: mode,
      axes: { X: to.x, Y: to.y, Z: to.z },
      ...(mode === "G0" ? {} : { feed }),
      provenance: prov,
      motionIndex,
    });

    motions.push({
      kind: mode === "G0" ? "rapid" : "cut",
      from: cur,
      to,
      feed: mode === "G0" ? machine.rapidRate : feed,
      seconds: dt,
      gcodeLine: blocks.length - 1,
      toolNumber: activeToolNumber,
      provenance: prov,
    });
    seconds += dt;
    cur = to;
  };

  const arc = (
    seg: ArcSegment,
    from: Point3<FrameId>,
    plane: "XY" | "XZ" | "YZ",
    feed: number,
    prov: Provenance,
  ) => {
    const to = toVec3(seg.to);
    const c = toVec3(seg.center);
    // Sweep sign is right-handed about the arc axis. Whether that reads as G2 or
    // G3 depends on whether the plane's normal points along the axis or against
    // it — which is exactly the sign subtlety the prototype handled with three
    // separate hard-coded branches.
    const axisComponent = plane === "XY" ? seg.axis.z : plane === "XZ" ? seg.axis.y : seg.axis.x;
    const ccw = seg.sweep * axisComponent > 0;
    const mode: MotionWord = ccw ? "G3" : "G2";
    const planeWord: PlaneWord = plane === "XY" ? "G17" : plane === "XZ" ? "G18" : "G19";

    const f = toVec3(from);
    const offsets: Partial<Record<"I" | "J" | "K", number>> =
      plane === "XY" ? { I: c.x - f.x, J: c.y - f.y }
        : plane === "XZ" ? { I: c.x - f.x, K: c.z - f.z }
        : { J: c.y - f.y, K: c.z - f.z };

    // Arc length for timing: radius times sweep, plus any helical rise.
    const R = distance(f, c);
    const planarLen = Math.abs(seg.sweep) * R;
    const L = Math.hypot(planarLen, axialRise(plane, f, to));
    const dt = (L / Math.max(feed, 1e-6)) * 60;
    const motionIndex = motions.length;

    push({
      plane: planeWord,
      motion: mode,
      axes: { X: to.x, Y: to.y, Z: to.z, ...offsets },
      feed,
      provenance: prov,
      motionIndex,
    });

    motions.push({
      kind: "cut", from: cur, to, feed, seconds: dt,
      gcodeLine: blocks.length - 1, toolNumber: activeToolNumber, provenance: prov,
    });
    seconds += dt;
    cur = to;
  };

  for (const cmd of program.commands) {
    const opId = cmd.provenance?.operationId;
    if (opts.operationMarker && opId && opId !== lastOperationId && opId !== "<synthetic>") {
      const marker = opts.operationMarker(opId, blocks.length);
      if (marker) push({ verbatim: marker, provenance: SYNTHETIC });
      lastOperationId = opId;
    }
    emitCommand(cmd);
  }

  push(rawLine(opts.programEnd ?? "M30"));
  for (const line of opts.footer?.(program) ?? []) push({ verbatim: line, provenance: SYNTHETIC });

  const finalBlocks = (opts.compressOutput ?? true) ? compress(blocks) : blocks;
  const document = toDocument(finalBlocks, machine.dialect, { decimals, commentStyle });

  return { document, motions, totalSeconds: seconds, rawBlocks: blocks };

  /* ------------------------------------------------------------------ */

  function emitCommand(cmd: CanonicalCommand): void {
    switch (cmd.kind) {
      case "comment":
        push({ comment: cmd.text, provenance: cmd.provenance });
        break;

      case "tool-change":
        activeToolNumber = cmd.tool.number;
        push({ tool: cmd.tool.number, misc: ["M6"], provenance: cmd.provenance });
        break;

      case "spindle":
        if (cmd.state.mode === "off") {
          push({ spindleCode: "M5", provenance: cmd.provenance });
        } else {
          push({
            spindleSpeed: cmd.state.speed,
            spindleCode: cmd.state.mode === "cw" ? "M3" : "M4",
            provenance: cmd.provenance,
          });
        }
        break;

      case "coolant":
        push({
          misc: [cmd.state === "off" ? "M9" : cmd.state === "flood" ? "M8" : "M7"],
          provenance: cmd.provenance,
        });
        break;

      case "traverse":
        emitTraverse(cmd);
        break;

      case "cut":
        emitCut(cmd);
        break;

      case "dwell":
        push({ misc: [`G4 P${cmd.duration}`], provenance: cmd.provenance });
        seconds += cmd.duration;
        break;

      case "pause":
        push({ misc: ["M0"], comment: cmd.message, provenance: cmd.provenance });
        break;

      case "probe": {
        const word = machine.probe?.kind === "g31" ? "G31" : "G38.2";
        const t = cmd.maxTravel;
        push({
          misc: [
            `${word} X${(cmd.direction.x * t).toFixed(decimals)}` +
            ` Y${(cmd.direction.y * t).toFixed(decimals)}` +
            ` Z${(cmd.direction.z * t).toFixed(decimals)}` +
            ` F${cmd.feed}`,
          ],
          provenance: cmd.provenance,
        });
        break;
      }

      case "raw":
        push({ misc: [cmd.text], provenance: cmd.provenance });
        break;
    }
  }

  /**
   * A traverse is an INTENT, not a G0. On a machine whose rapids are not
   * coordinated we must decompose it into retract / move / descend, because the
   * path between endpoints is otherwise unspecified and could plough through
   * the part.
   */
  function emitTraverse(cmd: TraverseCmd): void {
    const target = toVec3(cmd.to);
    const movesInXY =
      Math.abs(target.x - cur.x) > 1e-9 || Math.abs(target.y - cur.y) > 1e-9;

    if (!movesInXY) {
      linear(target, "G0", machine.rapidRate, cmd.provenance);
      return;
    }

    if (cmd.clearance.allowCoordinated && machine.rapidSemantics === "coordinated") {
      linear(target, "G0", machine.rapidRate, cmd.provenance);
      return;
    }

    const safe = Math.max(cmd.clearance.safeZ, cur.z, target.z);
    if (Math.abs(cur.z - safe) > 1e-9) {
      linear(vec3(cur.x, cur.y, safe), "G0", machine.rapidRate, cmd.provenance);
    }
    linear(vec3(target.x, target.y, safe), "G0", machine.rapidRate, cmd.provenance);
    if (Math.abs(target.z - safe) > 1e-9) {
      linear(target, "G0", machine.rapidRate, cmd.provenance);
    }
  }

  function emitCut(cmd: CutCmd): void {
    const feed = Math.min(cmd.feed, machine.maxFeed);
    let from = cmd.path.start;

    // If the cut does not start where the tool is, close the gap at feed rate.
    // The planner should have inserted a traverse; doing it silently here would
    // hide that bug, so we only handle the sub-epsilon case.
    if (distance(cur, toVec3(from)) > 1e-6) {
      linear(toVec3(from), "G1", feed, cmd.provenance);
    }

    for (const seg of cmd.path.segments) {
      if (seg.kind === "line") {
        linear(toVec3(seg.to), "G1", feed, cmd.provenance);
        from = seg.to;
      } else if (seg.kind === "arc") {
        const plane = arcPlane(seg.axis);
        if (plane && supportsArcPlane(machine, plane)) {
          arc(seg, from, plane, feed, cmd.provenance);
        } else {
          // Capability-driven linearization: the machine cannot express this
          // arc, so sample it. See ADR / DESIGN-01 §27-28.
          for (const p of sampleArc(seg, from, cmd.tolerance)) {
            linear(toVec3(p), "G1", feed, cmd.provenance);
          }
        }
        from = seg.to;
      } else {
        for (let i = 0; i < seg.pts.length; i += 3) {
          linear(vec3(seg.pts[i], seg.pts[i + 1], seg.pts[i + 2]), "G1", feed, cmd.provenance);
        }
        const n = seg.pts.length;
        if (n >= 3) {
          from = { x: seg.pts[n - 3] as Mm, y: seg.pts[n - 2] as Mm, z: seg.pts[n - 1] as Mm,
            frame: seg.frame };
        }
      }
    }
  }
}

function axialRise(plane: "XY" | "XZ" | "YZ", a: Vec3, b: Vec3): number {
  return plane === "XY" ? b.z - a.z : plane === "XZ" ? b.y - a.y : b.x - a.x;
}

/** Wrap a literal line as a block. Comments are detected and routed properly. */
function rawLine(text: string): GCodeBlock {
  const t = text.trim();
  if (t.startsWith(";") || (t.startsWith("(") && t.endsWith(")"))) {
    return { comment: t.replace(/^[;(]\s?/, "").replace(/\)$/, ""), provenance: SYNTHETIC };
  }
  return { misc: [t], provenance: SYNTHETIC };
}
