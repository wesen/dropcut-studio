/**
 * @cam/post-makera — the Makera Z1 backend.
 *
 * Proof that the dialect abstraction actually works: this file contains no
 * emitter logic at all. It is a configuration record plus a header generator.
 * Everything that differs from generic RS-274 — the structured comment header,
 * the per-operation markers, `M02` instead of `M30`, and the absence of arcs —
 * is either an option or a capability in the machine profile.
 *
 * The header grammar was reverse-engineered from a real Makera Studio export
 * (original/MakeraBadge.nc); see design doc Part XI.3.
 */

import type { ValidatedProgram } from "@cam/ir";
import type { MachineProfile } from "@cam/machine";
import { describeTool } from "@cam/machine";
import type { Tool } from "@cam/machine";
import type { EmitResult, Rs274Options } from "@cam/post-rs274";
import { emitRs274 } from "@cam/post-rs274";

export interface MakeraOptions {
  /** Tool table to emit in the header. Keyed by T-number. */
  readonly tools?: readonly Tool[];
  readonly materialName?: string;
  /** Estimated run time in seconds, for the `TIME` record. */
  readonly estimatedSeconds?: number;
  readonly camName?: string;
  readonly camVersion?: string;
  /** Named operations, in program order, for the `TOOLPATH` manifest. */
  readonly operations?: readonly { number: number; toolNumber: number; name: string }[];
}

const MKR = ";@MKR";

/** `;@MKR|KEY|k=v|k=v` */
const record = (key: string, fields: Record<string, string | number> = {}): string => {
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
  return parts.length === 0 ? `${MKR}|${key}` : `${MKR}|${key}|${parts.join("|")}`;
};

function toolRecord(t: Tool): string {
  const g = t.geometry;
  const typeName =
    g.type === "flat" ? "Flat End"
      : g.type === "ball" ? "Ball End"
      : g.type === "bull" ? "Bull Nose"
      : "Engraving";
  const tipDiameter = g.type === "vbit" ? g.tipDiameter : g.diameter;
  const cornerRadius = g.type === "bull" ? g.cornerRadius : 0;
  const halfAngle = g.type === "vbit" ? g.includedAngle / 2 : 0;

  return record("TOOL", {
    number: t.number,
    name: t.name || describeTool(t),
    type: typeName,
    diameter: g.diameter,
    tipdiameter: tipDiameter,
    cornerradius: cornerRadius,
    halfAngle,
    ...(t.fluteLength !== undefined ? { flutelength: t.fluteLength } : {}),
  });
}

export function makeraHeader(
  program: ValidatedProgram,
  opts: MakeraOptions,
  machine: MachineProfile,
): string[] {
  const s = program.setup.stock;
  const lines: string[] = [
    record("BEGIN"),
    record("SCHEMA", { v: "1.0.0" }),
    record("MACHINE", { id: "Z1", name: machine.name }),
  ];

  if (opts.materialName) lines.push(record("MATERIAL", { name3: opts.materialName }));

  lines.push(
    record("STOCK", { id: "cuboid", length: s.x, width: s.y, height: s.z, diameter: 1 }),
    record("ORIGIN", {
      id: 0, type_name: "topFrontLeft",
      x: s.originX, y: s.originY, z: s.topZ,
    }),
    record("CAM", {
      id: opts.camName ?? "DropcutStudio",
      name: opts.camName ?? "DropcutStudio",
      v: opts.camVersion ?? "0.1.0",
    }),
    record("UNIT", { value: "mm" }),
  );

  for (const t of opts.tools ?? []) lines.push(toolRecord(t));

  if (opts.estimatedSeconds !== undefined) {
    lines.push(record("TIME", { seconds: Math.round(opts.estimatedSeconds) }));
  }

  for (const op of opts.operations ?? []) {
    lines.push(record("TOOLPATH", {
      number: op.number, tool_number: op.toolNumber, name: op.name,
    }));
  }

  lines.push(record("END"), "");
  return lines;
}

export function emitMakera(
  program: ValidatedProgram,
  machine: MachineProfile,
  opts: MakeraOptions = {},
): EmitResult {
  let opIndex = 0;
  const seen = new Set<string>();

  const rs274: Rs274Options = {
    header: (p) => makeraHeader(p, opts, machine),
    // Observed in the real export: `G90 G21` only, no G94/G17.
    preamble: ["G90 G21"],
    programEnd: "M02",
    commentStyle: "semicolon",
    operationMarker: (operationId) => {
      if (seen.has(operationId)) return null;
      seen.add(operationId);
      opIndex++;
      return record("TOOLPATH_START", { toolpath_number: opIndex });
    },
  };

  return emitRs274(program, machine, rs274);
}
