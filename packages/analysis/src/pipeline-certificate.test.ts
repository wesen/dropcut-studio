/**
 * The full honest pipeline:
 *
 *   plan -> strategy -> canonical -> lower -> validate (exact)
 *        -> emit -> simulate -> recertify
 *
 * The point of these tests is that the certificate tells the TRUTH about a real
 * compile: exact checks are exact, sampled checks report their resolution, and
 * unmodelled checks stay visibly unchecked.
 */

import { describe, expect, it } from "vitest";
import { mm, mmPerMin, ratio } from "@cam/units";
import type { Tool } from "@cam/machine";
import { getMachine } from "@cam/machine";
import { PRESETS, tessellate } from "@cam/geometry";
import type { ManufacturingPlan } from "@cam/planner";
import { runPlan } from "@cam/planner";
import { dispatchStrategy } from "@cam/strategies";
import { lower, recertify, validate } from "@cam/compiler";
import { emitRs274 } from "@cam/post-rs274";
import type { CheckMove } from "./checks.js";
import { runSampledChecks } from "./checks.js";
import { formatCertificate, isFullyVerified } from "./certificate.js";
import { estimateTime } from "./time.js";

const BALL3: Tool = {
  id: "ball3", number: 1, name: "3mm ball",
  geometry: { type: "ball", diameter: mm(3) },
};

const DOME = tessellate({ ...PRESETS.dome, n: 90 }, "dome");

const PLAN: ManufacturingPlan = {
  setup: {
    stock: { x: mm(36), y: mm(36), z: mm(16), originX: mm(-18), originY: mm(-18), topZ: mm(15) },
    clearance: mm(20),
    workOffset: "G54",
    floorZ: mm(0),
  },
  operations: [{
    kind: "finish-surface",
    id: "finish#1",
    toolId: BALL3.id,
    feed: mmPerMin(900),
    strategy: { kind: "raster", direction: "X", scallop: mm(0.08) },
    chordTolerance: mm(0.02),
    margin: mm(1),
  }],
  tools: { [BALL3.id]: BALL3 },
};

/** Run the whole pipeline, including simulation and recertification. */
function fullCompile(plan = PLAN, machineId = "linuxcnc") {
  const machine = getMachine(machineId);
  const run = runPlan(plan, { mesh: DOME, strategies: dispatchStrategy });
  const lowered = lower(run.program, machine);
  const first = validate(lowered, machine);
  if (!first.ok) throw new Error(first.diagnostics.map((d) => d.message).join("; "));

  const emitted = emitRs274(first.program, machine);

  const moves: CheckMove[] = emitted.motions.map((m) => ({
    kind: m.kind,
    from: m.from,
    to: m.to,
    tool: BALL3.geometry,
    gcodeLine: m.gcodeLine,
  }));

  const checks = runSampledChecks(moves, {
    stock: {
      width: plan.setup.stock.x, depth: plan.setup.stock.y, height: plan.setup.stock.z,
      originX: plan.setup.stock.originX, originY: plan.setup.stock.originY,
      topZ: plan.setup.stock.topZ,
    },
    safeZ: 16,
    resolution: 120,
  });

  const final = recertify(first.program, {
    spatialResolution: mm(checks.resolution),
    numericalTolerance: mm(0.02),
    diagnostics: checks.diagnostics,
  });

  return { machine, run, emitted, checks, program: final };
}

describe("full pipeline certificate", () => {
  const result = fullCompile();

  it("produces G-code", () => {
    expect(result.emitted.document.lines.length).toBeGreaterThan(500);
    expect(result.emitted.motions.length).toBeGreaterThan(500);
  });

  it("reports exact checks as exact", () => {
    const c = result.program.certificate;
    expect(c.travel.kind).toBe("verified-exact");
    expect(c.spindle.kind).toBe("verified-exact");
    expect(c.interlocks.kind).toBe("verified-exact");
  });

  it("reports sampled checks with the resolution actually used", () => {
    const c = result.program.certificate;
    expect(c.gouge.kind).toBe("verified-to-resolution");
    if (c.gouge.kind === "verified-to-resolution") {
      expect(c.gouge.spatial).toBeCloseTo(result.checks.resolution, 9);
      expect(c.gouge.spatial).toBeGreaterThan(0);
      expect(c.gouge.numerical).toBe(0.02);
    }
  });

  it("keeps fixture and holder visibly unchecked", () => {
    const c = result.program.certificate;
    expect(c.fixture.kind).toBe("not-checked");
    expect(c.holder.kind).toBe("not-checked");
    expect(formatCertificate(c)).toMatch(/SKIP\s+fixture collision/);
  });

  it("carries an error budget that accounts for chord tolerance and rounding", () => {
    const b = result.program.certificate.errorBudget;
    const stages = b.contributions.map((c) => c.stage);
    expect(stages).toContain("chord-refinement");
    expect(stages).toContain("gcode-rounding");
    expect(b.totalGeometric).toBeGreaterThan(0.02);
    expect(b.totalGeometric).toBeLessThan(0.05);
  });

  it("finds no rapid crashes for a well-formed finishing program", () => {
    expect(result.checks.worstRapidCrash).toBe(0);
    expect(result.checks.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("passes the modelled checks overall", () => {
    expect(isFullyVerified(result.program.certificate)).toBe(true);
  });

  it("estimates a run time with its model labelled", () => {
    const est = estimateTime(
      result.emitted.motions.map((m) => ({
        kind: m.kind,
        length: Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y, m.to.z - m.from.z),
        feed: m.feed,
      })),
      result.machine.rapidRate,
    );
    expect(est.total).toBeGreaterThan(0);
    expect(est.cutLength).toBeGreaterThan(100);
    expect(est.model).toBe("length-over-feed");
  });
});

describe("certificate honesty under a raw escape", () => {
  it("marks analysable checks unverifiable and refuses to upgrade them", () => {
    const planWithRaw: ManufacturingPlan = PLAN;
    const machine = getMachine("linuxcnc");
    const run = runPlan(planWithRaw, { mesh: DOME, strategies: dispatchStrategy });

    // Splice in a raw escape, as `job.raw()` would.
    const withRaw = {
      ...run.program,
      commands: [
        ...run.program.commands,
        {
          kind: "raw" as const,
          text: "M64 P0",
          dialect: "linuxcnc",
          effects: ["digital-output"],
          provenance: { operationId: "raw#1" },
        },
      ],
    };

    const lowered = lower(withRaw, machine);
    const first = validate(lowered, machine);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(first.program.certificate.travel.kind).toBe("unverifiable");

    // Simulation evidence must NOT wash away the unverifiable verdict — the
    // simulator cannot model what the escape does either.
    const upgraded = recertify(first.program, {
      spatialResolution: mm(0.1),
      numericalTolerance: mm(0.01),
      diagnostics: [],
    });
    expect(upgraded.certificate.travel.kind).toBe("unverifiable");
    expect(isFullyVerified(upgraded.certificate)).toBe(false);
  });
});

describe("certificate detects a genuinely unsafe program", () => {
  it("flags a rapid that ploughs through stock", () => {
    // Hand-built moves: a rapid straight through the middle of the block.
    const checks = runSampledChecks([
      { kind: "rapid", tool: BALL3.geometry, gcodeLine: 3,
        from: { x: -15, y: 0, z: 5 }, to: { x: 15, y: 0, z: 5 } },
    ], {
      stock: { width: 36, depth: 36, height: 16, originX: -18, originY: -18, topZ: 15 },
      safeZ: 16,
      resolution: 100,
    });

    expect(checks.diagnostics.some((d) => d.code === "rapid.throughStock")).toBe(true);
    expect(checks.worstRapidCrash).toBeGreaterThan(5);
  });
});
