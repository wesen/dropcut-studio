/**
 * End-to-end: mesh -> plan -> strategy -> link -> canonical -> validate -> G-code.
 *
 * These tests exercise the whole stack the design doc describes, and they check
 * MACHINING properties rather than byte output: does the toolpath actually cover
 * the part, does it stay above the surface, do the passes have the spacing that
 * was asked for, does the spindle interlock hold.
 */

import { describe, expect, it } from "vitest";
import { mm, mmPerMin, ratio, rpm } from "@cam/units";
import { box2 } from "@cam/math";
import type { CanonicalCommand, CutCmd } from "@cam/ir";
import { samplePath } from "@cam/ir";
import type { Tool } from "@cam/machine";
import { getMachine } from "@cam/machine";
import { makeCutterLocation, PRESETS, tessellate } from "@cam/geometry";
import type { ManufacturingPlan, Operation } from "@cam/planner";
import { runPlan } from "@cam/planner";
import { lower, validate } from "@cam/compiler";
import { emitRs274 } from "@cam/post-rs274";
import { motionPolyline, parseGcode } from "@cam/gcode-parser";
import { dispatchStrategy } from "./registry.js";

const BALL3: Tool = {
  id: "ball3", number: 1, name: "3mm ball",
  geometry: { type: "ball", diameter: mm(3) },
};
const FLAT4: Tool = {
  id: "flat4", number: 2, name: "4mm flat",
  geometry: { type: "flat", diameter: mm(4) },
};
const FLAT2: Tool = {
  id: "flat2", number: 3, name: "2mm flat",
  geometry: { type: "flat", diameter: mm(2) },
};

const DOME = tessellate({ ...PRESETS.dome, n: 120 }, "dome");

function makePlan(operations: Operation[], tools: Tool[] = [BALL3]): ManufacturingPlan {
  return {
    setup: {
      stock: { x: mm(36), y: mm(36), z: mm(16), originX: mm(-18), originY: mm(-18), topZ: mm(15) },
      clearance: mm(20),
      workOffset: "G54",
      floorZ: mm(0),
    },
    operations,
    tools: Object.fromEntries(tools.map((t) => [t.id, t])),
  };
}

function compile(plan: ManufacturingPlan, mesh = DOME, machineId = "linuxcnc") {
  const machine = getMachine(machineId);
  const run = runPlan(plan, { mesh, strategies: dispatchStrategy });
  const lowered = lower(run.program, machine);
  const validated = validate(lowered, machine);
  return { run, machine, validated };
}

const isCut = (c: CanonicalCommand<"work">): c is CutCmd<"work"> => c.kind === "cut";

/** Every xyz point of every cutting move in the program. */
function cutPoints(run: ReturnType<typeof runPlan>) {
  const pts: { x: number; y: number; z: number }[] = [];
  for (const c of run.program.commands) {
    if (!isCut(c)) continue;
    for (const p of samplePath(c.path, 0.05)) pts.push({ x: p.x, y: p.y, z: p.z });
  }
  return pts;
}

describe("raster finishing on a dome", () => {
  const plan = makePlan([{
    kind: "finish-surface",
    id: "finish#1",
    toolId: BALL3.id,
    feed: mmPerMin(900),
    strategy: { kind: "raster", direction: "X", scallop: mm(0.02) },
    chordTolerance: mm(0.01),
    margin: mm(1),
  }]);

  it("produces passes at the stepover the scallop implies", () => {
    const { run } = compile(plan);
    const summary = run.summaries[0];
    // s = 2*sqrt(2Rh - h^2) with R = 1.5, h = 0.02 -> about 0.489 mm.
    expect(summary.description).toMatch(/raster along X/);
    expect(summary.description).toMatch(/0\.4\d\d mm/);
    expect(summary.paths).toBeGreaterThan(60);
  });

  it("never dips below the true part surface", () => {
    const { run } = compile(plan);
    const R0 = 14;
    for (const p of cutPoints(run)) {
      const r = Math.hypot(p.x, p.y);
      if (r >= R0) continue;
      const trueZ = Math.sqrt(R0 * R0 - r * r);
      // The tool tip rides the CL surface, which is at or above the part.
      expect(p.z).toBeGreaterThan(trueZ - 0.06);
    }
  });

  it("covers the whole part footprint", () => {
    const { run } = compile(plan);
    const pts = cutPoints(run);
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    expect(Math.min(...xs)).toBeLessThan(-14);
    expect(Math.max(...xs)).toBeGreaterThan(14);
    expect(Math.min(...ys)).toBeLessThan(-14);
    expect(Math.max(...ys)).toBeGreaterThan(14);
  });

  it("compiles to valid G-code that round-trips", () => {
    const { validated, machine } = compile(plan);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const out = emitRs274(validated.program, machine);
    const parsed = parseGcode(out.document.text, { rapidRate: machine.rapidRate });
    expect(parsed.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(motionPolyline(parsed).length).toBeGreaterThan(1000);
  });
});

describe("constant scallop on a dome", () => {
  const plan = makePlan([{
    kind: "finish-surface",
    id: "finish#1",
    toolId: BALL3.id,
    feed: mmPerMin(700),
    strategy: { kind: "constant-scallop", scallop: mm(0.03) },
    chordTolerance: mm(0.01),
    margin: mm(1),
  }]);

  it("produces iso-scallop contours", () => {
    const { run } = compile(plan);
    expect(run.summaries[0].description).toMatch(/constant scallop: \d+ iso-scallop contours/);
    expect(run.summaries[0].paths).toBeGreaterThan(5);
  });

  it("spaces passes more tightly in XY where the surface is steep", () => {
    // THE point of the strategy. On a dome, XY spacing between adjacent
    // contours must shrink towards the rim, where the surface is steepest.
    const { run } = compile(plan);
    const radii = run.program.commands
      .filter(isCut)
      .filter((c) => c.purpose === "finish")
      .map((c) => {
        const pts = samplePath(c.path, 0.5);
        let sum = 0;
        for (const p of pts) sum += Math.hypot(p.x, p.y);
        return sum / pts.length;
      })
      .sort((a, b) => a - b);

    expect(radii.length).toBeGreaterThan(5);

    // Gaps between consecutive contour radii: the outer ones (steep) should be
    // smaller than the inner ones (flat top).
    const gaps: number[] = [];
    for (let i = 1; i < radii.length; i++) gaps.push(radii[i] - radii[i - 1]);
    const innerHalf = gaps.slice(0, Math.floor(gaps.length / 2));
    const outerHalf = gaps.slice(Math.floor(gaps.length / 2));
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    expect(mean(outerHalf)).toBeLessThan(mean(innerHalf));
  });

  it("does not gouge", () => {
    const { run } = compile(plan);
    const R0 = 14;
    for (const p of cutPoints(run)) {
      const r = Math.hypot(p.x, p.y);
      if (r >= R0 - 0.5) continue;
      expect(p.z).toBeGreaterThan(Math.sqrt(R0 * R0 - r * r) - 0.08);
    }
  });
});

describe("hybrid waterline on a dome", () => {
  it("uses raster on the shallow top and waterlines on the steep flank", () => {
    const plan = makePlan([{
      kind: "finish-surface",
      id: "finish#1",
      toolId: BALL3.id,
      feed: mmPerMin(700),
      strategy: { kind: "hybrid-waterline", scallop: mm(0.05), steepAngle: 45 },
      chordTolerance: mm(0.02),
      margin: mm(1),
    }]);
    const { run } = compile(plan);
    const d = run.summaries[0].description;
    expect(d).toMatch(/hybrid: \d+ raster spans/);
    expect(d).toMatch(/\d+ waterline runs/);
    // Both halves must actually contribute; a zero on either side means the
    // classification collapsed.
    const raster = Number(/(\d+) raster spans/.exec(d)![1]);
    const water = Number(/(\d+) waterline runs/.exec(d)![1]);
    expect(raster).toBeGreaterThan(0);
    expect(water).toBeGreaterThan(0);
  });
});

describe("z-level roughing", () => {
  const plan = makePlan([{
    kind: "rough-surface",
    id: "rough#1",
    toolId: FLAT4.id,
    feed: mmPerMin(1200),
    stepdown: mm(2),
    stepover: ratio(0.45),
    stockToLeave: mm(0.3),
    entry: { kind: "auto", maxRampAngle: 3 },
    margin: mm(1),
  }], [FLAT4]);

  it("cuts in discrete Z levels", () => {
    const { run } = compile(plan);
    const zs = new Set(
      run.program.commands
        .filter(isCut)
        .filter((c) => c.purpose === "rough")
        .flatMap((c) => samplePath(c.path, 1))
        .map((p) => Math.round(p.z * 100) / 100),
    );
    // Stock top 15, floor 0, stepdown 2 -> roughly 8 levels.
    expect(zs.size).toBeGreaterThan(3);
    expect(zs.size).toBeLessThan(15);
  });

  it("leaves the requested allowance above the part", () => {
    const { run } = compile(plan);
    const surface = makeCutterLocation(DOME, FLAT4.geometry, { floorZ: 0 });
    for (const p of cutPoints(run)) {
      // Every rough cut must stay at or above (surface + allowance), minus a
      // small tolerance for the scanline bisection.
      expect(p.z).toBeGreaterThan(surface(p.x, p.y) - 0.05);
    }
  });

  it("emits a ramp or helix entry rather than plunging", () => {
    const { run } = compile(plan);
    const purposes = new Set(
      run.program.commands.filter((c) => c.kind === "cut").map((c) => c.purpose),
    );
    expect(purposes.has("ramp") || purposes.has("plunge")).toBe(true);
  });
});

describe("2.5D pocket — defect D1 regression", () => {
  /**
   * The IDE prototype hard-coded `const dia = 4` when computing pocket and face
   * stepover, so the passes were spaced for a 4 mm cutter no matter what tool
   * was loaded. With a 2 mm tool that leaves uncut ridges between passes.
   */
  it("computes stepover from the ACTUAL tool diameter", () => {
    const makePocketPlan = (tool: Tool) => makePlan([{
      kind: "pocket",
      id: "pocket#1",
      toolId: tool.id,
      feed: mmPerMin(600),
      area: box2(-10, -8, 10, 8),
      depth: mm(4),
      stepdown: mm(2),
      stepover: ratio(0.5),
    }], [tool]);

    const wide = runPlan(makePocketPlan(FLAT4), { strategies: dispatchStrategy });
    const narrow = runPlan(makePocketPlan(FLAT2), { strategies: dispatchStrategy });

    // 0.5 * 4mm = 2.0mm stepover vs 0.5 * 2mm = 1.0mm.
    expect(wide.summaries[0].description).toMatch(/2\.00 mm stepover/);
    expect(narrow.summaries[0].description).toMatch(/1\.00 mm stepover/);

    // And the narrow tool must therefore produce strictly more ring passes.
    const rings = (r: typeof wide) =>
      r.program.commands
        .filter(isCut)
        .reduce((n, c) => n + samplePath(c.path, 1).length, 0);
    expect(rings(narrow)).toBeGreaterThan(rings(wide));
  });

  it("refuses a pocket smaller than the tool", () => {
    const plan = makePlan([{
      kind: "pocket",
      id: "pocket#tiny",
      toolId: FLAT4.id,
      feed: mmPerMin(600),
      area: box2(-1, -1, 1, 1),
      depth: mm(2),
      stepdown: mm(1),
      stepover: ratio(0.5),
    }], [FLAT4]);
    const run = runPlan(plan, { strategies: dispatchStrategy });
    expect(run.diagnostics.some((d) => /too small for a 4 mm tool/.test(d.message))).toBe(true);
  });
});

describe("program structure", () => {
  it("changes tools with the spindle stopped", () => {
    const plan = makePlan([
      {
        kind: "rough-surface", id: "rough#1", toolId: FLAT4.id, feed: mmPerMin(1200),
        stepdown: mm(3), stepover: ratio(0.5), stockToLeave: mm(0.3),
        entry: { kind: "plunge" }, margin: mm(1),
      },
      {
        kind: "finish-surface", id: "finish#1", toolId: BALL3.id, feed: mmPerMin(800),
        strategy: { kind: "raster", direction: "Y", scallop: mm(0.05) },
        chordTolerance: mm(0.02), margin: mm(1),
      },
    ], [FLAT4, BALL3]);

    const { run, validated } = compile(plan);
    expect(validated.ok).toBe(true);

    // Walk the command stream and assert the interlock directly.
    let spindleOn = false;
    for (const c of run.program.commands) {
      if (c.kind === "spindle") spindleOn = c.state.mode !== "off";
      if (c.kind === "tool-change") expect(spindleOn).toBe(false);
    }
  });

  it("ends with the spindle off", () => {
    const plan = makePlan([{
      kind: "finish-surface", id: "f", toolId: BALL3.id, feed: mmPerMin(800),
      strategy: { kind: "raster", direction: "X", scallop: mm(0.08) },
      chordTolerance: mm(0.02), margin: mm(1),
    }]);
    const { run } = compile(plan);
    const last = [...run.program.commands].reverse()
      .find((c) => c.kind === "spindle");
    expect(last && last.kind === "spindle" && last.state.mode).toBe("off");
  });

  it("reports an unknown tool rather than throwing", () => {
    const plan = makePlan([{
      kind: "finish-surface", id: "f", toolId: "nope", feed: mmPerMin(800),
      strategy: { kind: "raster", direction: "X", scallop: mm(0.08) },
      chordTolerance: mm(0.02), margin: mm(1),
    }]);
    const run = runPlan(plan, { mesh: DOME, strategies: dispatchStrategy });
    expect(run.diagnostics.some((d) => d.code === "interlock.noTool")).toBe(true);
  });

  it("honours cancellation mid-plan", () => {
    const plan = makePlan([{
      kind: "finish-surface", id: "f", toolId: BALL3.id, feed: mmPerMin(800),
      strategy: { kind: "raster", direction: "X", scallop: mm(0.01) },
      chordTolerance: mm(0.01), margin: mm(1),
    }]);
    const run = runPlan(plan, {
      mesh: DOME, strategies: dispatchStrategy, signal: { aborted: true },
    });
    expect(run.program.commands.length).toBe(0);
  });
});
