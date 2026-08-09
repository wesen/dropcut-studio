/**
 * The Makera backend, checked against the shape of a real Makera Studio export.
 *
 * The point of these tests is not byte-identity with Makera's own output — we
 * are not reverse-engineering their toolpaths. It is that ONE canonical program
 * compiled for TWO machines produces correctly different encodings, driven
 * entirely by capability data.
 */

import { describe, expect, it } from "vitest";
import { mm, mmPerMin, rad, rpm } from "@cam/units";
import { point, vec3 } from "@cam/math";
import type { CanonicalProgram } from "@cam/ir";
import { pathFrom, provenance, SYNTHETIC } from "@cam/ir";
import type { Tool } from "@cam/machine";
import { getMachine } from "@cam/machine";
import { lower, validate } from "@cam/compiler";
import { emitRs274 } from "@cam/post-rs274";
import { parseGcode } from "@cam/gcode-parser";
import { emitMakera } from "./index.js";

const TOOL_REF = { id: "t1", number: 1 };

const TOOLS: Tool[] = [
  {
    id: "t1", number: 1, name: "3.175mm flat",
    geometry: { type: "flat", diameter: mm(3.175) }, fluteLength: mm(12),
  },
  {
    id: "t2", number: 2, name: "30deg engraver",
    geometry: { type: "vbit", diameter: mm(3.175), tipDiameter: mm(0.3), includedAngle: 30 as never },
  },
];

/** One program with a straight cut and a half-circle, used for both targets. */
function program(): CanonicalProgram {
  const start = point(40, 20, -1, "work");
  const prov = provenance("pocket#1", { strategyName: "rect-pocket" });
  const path = pathFrom(start)
    .lineTo(point(60, 20, -1, "work"))
    .arcTo(point(60, 40, -1, "work"), point(60, 30, -1, "work"), vec3(0, 0, 1), rad(Math.PI))
    .build();

  return {
    setup: {
      stock: { x: mm(100), y: mm(100), z: mm(1.3), originX: mm(0), originY: mm(0), topZ: mm(0) },
      clearance: mm(5),
      workOffset: "G54",
    },
    commands: [
      { kind: "tool-change", tool: TOOL_REF, provenance: prov },
      { kind: "spindle", state: { mode: "cw", speed: rpm(12000) }, provenance: prov },
      {
        kind: "traverse", to: start,
        clearance: { safeZ: mm(5), allowCoordinated: true }, provenance: prov,
      },
      {
        kind: "cut", path, feed: mmPerMin(800), tolerance: mm(0.01),
        purpose: "finish", tool: TOOL_REF, provenance: prov,
      },
      { kind: "spindle", state: { mode: "off" }, provenance: SYNTHETIC },
    ],
    tools: new Map([[TOOL_REF.id, TOOL_REF]]),
  };
}

function compileFor(machineId: string) {
  const machine = getMachine(machineId);
  const lowered = lower(program(), machine);
  const r = validate(lowered, machine);
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join("; "));
  return { machine, validated: r.program, lowered };
}

describe("Makera backend", () => {
  const { machine, validated } = compileFor("makera-z1");
  const out = emitMakera(validated, machine, {
    tools: TOOLS,
    materialName: "Bicolor Stock",
    estimatedSeconds: 1800,
    operations: [{ number: 1, toolNumber: 1, name: "[T1]2D Contour" }],
  });
  const text = out.document.text;

  it("emits the structured ;@MKR| header", () => {
    expect(text).toContain(";@MKR|BEGIN");
    expect(text).toContain(";@MKR|SCHEMA|v=1.0.0");
    expect(text).toContain(";@MKR|MACHINE|id=Z1|name=MAKERA Z1");
    expect(text).toContain(";@MKR|UNIT|value=mm");
    expect(text).toContain(";@MKR|END");
  });

  it("describes the stock and origin the way Makera Studio does", () => {
    expect(text).toMatch(/;@MKR\|STOCK\|id=cuboid\|length=100\|width=100\|height=1\.3/);
    expect(text).toMatch(/;@MKR\|ORIGIN\|id=0\|type_name=topFrontLeft/);
  });

  it("emits a tool table with cutter geometry", () => {
    expect(text).toMatch(/;@MKR\|TOOL\|number=1\|.*type=Flat End\|diameter=3\.175/);
    expect(text).toMatch(/;@MKR\|TOOL\|number=2\|.*type=Engraving\|.*tipdiameter=0\.3\|.*halfAngle=15/);
  });

  it("emits per-operation TOOLPATH_START markers", () => {
    expect(text).toContain(";@MKR|TOOLPATH_START|toolpath_number=1");
  });

  it("uses the G90 G21 preamble and M02 program end", () => {
    expect(text).toMatch(/^;@MKR\|BEGIN/m);
    expect(text).toContain("G90 G21");
    expect(text.trimEnd().split("\n").some((l) => l.trim() === "M02")).toBe(true);
    expect(text).not.toContain("M30");
  });

  it("emits no arcs, because the profile says the controller has none", () => {
    expect(/\bG[23]\b/.test(text)).toBe(false);
  });

  it("round-trips: the linearized half-circle still traces the circle", () => {
    const parsed = parseGcode(text, { rapidRate: machine.rapidRate });
    const onArc = parsed.segments
      .flatMap((s) => s.points ?? [s.from, s.to])
      .filter((p) => Math.abs(p.z + 1) < 1e-6 && p.x >= 59.9);
    expect(onArc.length).toBeGreaterThan(5);
    for (const p of onArc) {
      expect(Math.hypot(p.x - 60, p.y - 30)).toBeLessThanOrEqual(10 + 0.02);
    }
  });

  it("emits only codes the Makera profile supports", () => {
    const parsed = parseGcode(text, {
      supportedG: machine.supportedG,
      supportedM: machine.supportedM,
    });
    const unsupported = parsed.diagnostics.filter((d) => d.code === "dialect.unknownCode"
      && d.severity === "warning");
    expect(unsupported).toHaveLength(0);
  });
});

describe("one program, two machines", () => {
  it("differs exactly where the capabilities differ", () => {
    const mk = compileFor("makera-z1");
    const lc = compileFor("linuxcnc");

    const makeraText = emitMakera(mk.validated, mk.machine, { tools: TOOLS }).document.text;
    const linuxText = emitRs274(lc.validated, lc.machine).document.text;

    // Arcs: LinuxCNC keeps them, Makera does not.
    expect(/\bG[23]\b/.test(linuxText)).toBe(true);
    expect(/\bG[23]\b/.test(makeraText)).toBe(false);

    // Program end differs.
    expect(linuxText).toContain("M30");
    expect(makeraText).toContain("M02");

    // Header: only Makera carries structured metadata.
    expect(makeraText).toContain(";@MKR|BEGIN");
    expect(linuxText).not.toContain(";@MKR|");

    // The lowering diagnostic explains WHY the arcs went away.
    expect(mk.lowered.loweringDiagnostics.some((d) => d.code === "dialect.arcLinearized")).toBe(true);
    expect(lc.lowered.loweringDiagnostics.some((d) => d.code === "dialect.arcLinearized")).toBe(false);
  });

  it("linearization is the only geometric difference, within tolerance", () => {
    const mk = compileFor("makera-z1");
    const lc = compileFor("linuxcnc");
    const a = parseGcode(emitMakera(mk.validated, mk.machine, {}).document.text);
    const b = parseGcode(emitRs274(lc.validated, lc.machine).document.text);

    // Same endpoints, even though the sampling in between differs.
    const lastOf = (r: typeof a) => r.segments[r.segments.length - 1].to;
    expect(lastOf(a).x).toBeCloseTo(lastOf(b).x, 3);
    expect(lastOf(a).y).toBeCloseTo(lastOf(b).y, 3);
    expect(lastOf(a).z).toBeCloseTo(lastOf(b).z, 3);
  });
});
