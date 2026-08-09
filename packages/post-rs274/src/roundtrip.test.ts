/**
 * The round-trip property test.
 *
 * This is the single most valuable test in the suite. The central architectural
 * bet (ADR-002) is that a NON-MODAL IR can be compressed into MODAL G-code
 * without losing anything. That is only a real claim if we can parse the text
 * back and recover the same motion. Because we own a parser, we can.
 *
 * It catches the entire class of "the modal compressor dropped a word it should
 * have kept" — which is exactly the bug that would silently produce a scrapped
 * part rather than an exception.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { mm, mmPerMin, rad, rpm } from "@cam/units";
import { point, vec3 } from "@cam/math";
import type { CanonicalCommand, CanonicalProgram } from "@cam/ir";
import { pathFrom, SYNTHETIC } from "@cam/ir";
import { getMachine, linuxcnc, makeraZ1, xyz3018 } from "@cam/machine";
import { compress, formatProgram, lower, validate } from "@cam/compiler";
import { motionPolyline, parseGcode } from "@cam/gcode-parser";
import { emitRs274 } from "./index.js";

const TOOL = { id: "t1", number: 1 };

const SETUP = {
  stock: { x: mm(80), y: mm(60), z: mm(12), originX: mm(0), originY: mm(0), topZ: mm(0) },
  clearance: mm(6),
  workOffset: "G54",
};

/** Coordinates well inside every profile's travel so validation always passes. */
const coord = () => fc.double({ min: 5, max: 150, noNaN: true, noDefaultInfinity: true })
  .map((v) => Math.round(v * 1000) / 1000);
const depth = () => fc.double({ min: -20, max: -0.1, noNaN: true, noDefaultInfinity: true })
  .map((v) => Math.round(v * 1000) / 1000);
const feed = () => fc.integer({ min: 50, max: 2000 });

type Step =
  | { t: "traverse"; x: number; y: number; z: number }
  | { t: "cut"; pts: [number, number, number][]; f: number };

const arbStep: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    t: fc.constant("traverse" as const),
    x: coord(), y: coord(), z: fc.double({ min: 1, max: 30, noNaN: true })
      .map((v) => Math.round(v * 1000) / 1000),
  }),
  fc.record({
    t: fc.constant("cut" as const),
    pts: fc.array(fc.tuple(coord(), coord(), depth()), { minLength: 1, maxLength: 5 }),
    f: feed(),
  }),
);

/** Build a canonical program from a script of steps. */
function buildProgram(steps: readonly Step[]): CanonicalProgram {
  const commands: CanonicalCommand[] = [
    { kind: "tool-change", tool: TOOL, provenance: SYNTHETIC },
    { kind: "spindle", state: { mode: "cw", speed: rpm(12000) }, provenance: SYNTHETIC },
  ];

  let cur = point(0, 0, SETUP.clearance, "work");

  for (const s of steps) {
    if (s.t === "traverse") {
      const to = point(s.x, s.y, s.z, "work");
      commands.push({
        kind: "traverse", to,
        clearance: { safeZ: SETUP.clearance, allowCoordinated: true },
        provenance: SYNTHETIC,
      });
      cur = to;
    } else {
      const b = pathFrom(cur);
      for (const [x, y, z] of s.pts) b.lineTo(point(x, y, z, "work"));
      if (b.isEmpty) continue;
      const path = b.build();
      commands.push({
        kind: "cut", path, feed: mmPerMin(s.f), tolerance: mm(0.01),
        purpose: "finish", tool: TOOL, provenance: SYNTHETIC,
      });
      cur = path.end;
    }
  }

  commands.push({ kind: "spindle", state: { mode: "off" }, provenance: SYNTHETIC });
  return { setup: SETUP, commands, tools: new Map([[TOOL.id, TOOL]]) };
}

function emitFor(machineId: string, steps: readonly Step[]) {
  const machine = getMachine(machineId);
  const canonical = buildProgram(steps);
  const lowered = lower(canonical, machine);
  const result = validate(lowered, machine);
  if (!result.ok) {
    throw new Error("validation failed: " + result.diagnostics.map((d) => d.message).join("; "));
  }
  return { machine, ...emitRs274(result.program, machine) };
}

/**
 * Compare two motion polylines. Tolerance is the G-code text quantum
 * (3 decimals -> +/-0.0005) plus a little slack for arc discretisation.
 */
function polylinesMatch(a: readonly { x: number; y: number; z: number }[],
                        b: readonly { x: number; y: number; z: number }[],
                        eps = 1e-3): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i].x - b[i].x) > eps) return false;
    if (Math.abs(a[i].y - b[i].y) > eps) return false;
    if (Math.abs(a[i].z - b[i].z) > eps) return false;
  }
  return true;
}

describe("modal round trip", () => {
  it("compressed output parses back to the same motion as uncompressed output", () => {
    fc.assert(
      fc.property(fc.array(arbStep, { minLength: 1, maxLength: 8 }), (steps) => {
        const { rawBlocks, document } = emitFor("xyz-3018", steps);

        const uncompressed = formatProgram(rawBlocks, { decimals: 3 });
        const compressed = document.text;

        const a = motionPolyline(parseGcode(uncompressed));
        const b = motionPolyline(parseGcode(compressed));

        expect(polylinesMatch(a, b)).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it("holds for every machine profile", () => {
    for (const id of ["xyz-3018", "makera-z1", "linuxcnc"]) {
      fc.assert(
        fc.property(fc.array(arbStep, { minLength: 1, maxLength: 5 }), (steps) => {
          // Makera's travel is 0..200; keep inside it for all profiles.
          const clamped = steps.map((s) =>
            s.t === "traverse"
              ? { ...s, x: Math.min(s.x, 190), y: Math.min(s.y, 190), z: Math.min(s.z, 15) }
              : { ...s, pts: s.pts.map(([x, y, z]) =>
                  [Math.min(x, 190), Math.min(y, 190), z] as [number, number, number]) },
          );
          const { rawBlocks, document } = emitFor(id, clamped);
          const a = motionPolyline(parseGcode(formatProgram(rawBlocks, { decimals: 3 })));
          const b = motionPolyline(parseGcode(document.text));
          expect(polylinesMatch(a, b)).toBe(true);
        }),
        { numRuns: 120 },
      );
    }
  });

  it("compression genuinely removes words (otherwise the test is vacuous)", () => {
    const steps: Step[] = [
      { t: "traverse", x: 10, y: 10, z: 5 },
      { t: "cut", pts: [[20, 10, -1], [30, 10, -1], [40, 10, -1]], f: 600 },
    ];
    const { rawBlocks, document } = emitFor("xyz-3018", steps);
    const uncompressed = formatProgram(rawBlocks, { decimals: 3 });
    expect(document.text.length).toBeLessThan(uncompressed.length);
    // Y and Z are constant across the cut, so they should appear once, not thrice.
    const cutLines = document.text.split("\n").filter((l) => l.startsWith("G1") || /^X\d/.test(l));
    expect(cutLines.some((l) => !l.includes("Y") && !l.includes("Z"))).toBe(true);
  });
});

describe("arc round trip", () => {
  const arcProgram = (): CanonicalProgram => {
    const start = point(40, 20, -2, "work");
    const path = pathFrom(start)
      .arcTo(point(20, 20, -2, "work"), point(30, 20, -2, "work"), vec3(0, 0, 1), rad(Math.PI))
      .arcTo(point(40, 20, -2, "work"), point(30, 20, -2, "work"), vec3(0, 0, 1), rad(Math.PI))
      .build();
    return {
      setup: SETUP,
      commands: [
        { kind: "tool-change", tool: TOOL, provenance: SYNTHETIC },
        { kind: "spindle", state: { mode: "cw", speed: rpm(12000) }, provenance: SYNTHETIC },
        {
          kind: "traverse", to: start,
          clearance: { safeZ: SETUP.clearance, allowCoordinated: true },
          provenance: SYNTHETIC,
        },
        {
          kind: "cut", path, feed: mmPerMin(500), tolerance: mm(0.005),
          purpose: "finish", tool: TOOL, provenance: SYNTHETIC,
        },
        { kind: "spindle", state: { mode: "off" }, provenance: SYNTHETIC },
      ],
      tools: new Map([[TOOL.id, TOOL]]),
    };
  };

  function emitArcs(machineId: string) {
    const machine = getMachine(machineId);
    const lowered = lower(arcProgram(), machine);
    const r = validate(lowered, machine);
    if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join("; "));
    return { machine, lowered, ...emitRs274(r.program, machine) };
  }

  it("a full circle survives emission as G2/G3 on a machine that supports arcs", () => {
    const { document } = emitArcs("xyz-3018");
    expect(/G[23]\b/.test(document.text)).toBe(true);

    const parsed = parseGcode(document.text);
    // Every sampled arc point must sit on the circle of radius 10 about (30,20).
    for (const seg of parsed.segments.filter((s) => s.points !== null)) {
      for (const p of seg.points!) {
        expect(Math.abs(Math.hypot(p.x - 30, p.y - 20) - 10)).toBeLessThan(0.01);
      }
    }
  });

  it("the same program emits NO arcs for the Makera profile", () => {
    const { document, lowered } = emitArcs("makera-z1");
    expect(/\bG[23]\b/.test(document.text)).toBe(false);
    expect(lowered.loweringDiagnostics.some((d) => d.code === "dialect.arcLinearized")).toBe(true);
  });

  it("linearized arcs still trace the circle within the chord tolerance", () => {
    const { document } = emitArcs("makera-z1");
    const pts = motionPolyline(parseGcode(document.text));
    // Points at the cut depth are the arc; ignore the approach moves.
    const onArc = pts.filter((p) => Math.abs(p.z + 2) < 1e-6);
    expect(onArc.length).toBeGreaterThan(20);
    for (const p of onArc) {
      expect(Math.abs(Math.hypot(p.x - 30, p.y - 20) - 10)).toBeLessThan(0.02);
    }
  });
});

describe("machine profile differences are data-driven", () => {
  it("Makera and XYZ-3018 differ only where their capabilities differ", () => {
    expect(makeraZ1.interpolation.arcXY).toBe(false);
    expect(xyz3018.interpolation.arcXY).toBe(true);
    expect(linuxcnc.rapidSemantics).toBe("coordinated");
    expect(xyz3018.rapidSemantics).toBe("axis-independent");
  });

  it("axis-independent rapids decompose a traverse into separate moves", () => {
    const steps: Step[] = [{ t: "traverse", x: 50, y: 50, z: 2 }];
    const indep = emitFor("xyz-3018", steps);
    const coord = emitFor("linuxcnc", steps);
    // Count BLOCKS, not text occurrences of "G0" — compression correctly drops
    // the repeated modal motion word, so the second rapid has no G0 in its text.
    const rapids = (bs: readonly { motion?: string }[]) =>
      bs.filter((b) => b.motion === "G0").length;
    expect(rapids(indep.rawBlocks)).toBe(2); // move at safe Z, then descend
    expect(rapids(coord.rawBlocks)).toBe(1); // one coordinated rapid
  });
});

describe("compress()", () => {
  it("never drops arc offset words, which are relative to the current point", () => {
    const blocks = [
      { motion: "G2" as const, axes: { X: 10, Y: 0, I: 5, J: 0 }, feed: 500 },
      { motion: "G2" as const, axes: { X: 20, Y: 0, I: 5, J: 0 }, feed: 500 },
    ];
    const out = compress(blocks);
    expect(out[1].axes?.I).toBe(5);
    expect(out[1].axes?.J).toBe(0);
    // ...but the repeated feed and motion word ARE dropped.
    expect(out[1].feed).toBeUndefined();
    expect(out[1].motion).toBeUndefined();
  });

  it("keeps a restated S word when an M3 is issued", () => {
    const out = compress([
      { spindleSpeed: 12000, spindleCode: "M3" },
      { spindleSpeed: 12000, spindleCode: "M5" },
      { spindleSpeed: 12000, spindleCode: "M3" },
    ]);
    expect(out[0].spindleSpeed).toBe(12000);
    expect(out[1].spindleSpeed).toBeUndefined();
    expect(out[2].spindleSpeed).toBe(12000);
  });

  it("removes blocks that become empty, but keeps comment-only blocks", () => {
    const out = compress([
      { motion: "G1", axes: { X: 1 }, feed: 100 },
      { motion: "G1", axes: { X: 1 }, feed: 100 },
      { comment: "still here" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1].comment).toBe("still here");
  });
});
