/**
 * Material simulation, safety checks and certificate honesty.
 *
 * The simulator is tested against analytic answers: a flat pocket cut to a known
 * depth must leave a heightmap equal to that depth, a ball tool must leave a
 * spherical trough of the right radius, and so on.
 */

import { describe, expect, it } from "vitest";
import { mm } from "@cam/units";
import type { ToolGeometry } from "@cam/machine";
import { PRESETS, tessellate } from "@cam/geometry";
import type { CheckMove } from "./checks.js";
import { runSampledChecks } from "./checks.js";
import type { StockDefinition } from "./dexel.js";
import { analyseDeviation, DexelSim, deviationColour, rasteriseTarget } from "./dexel.js";
import {
  buildCertificate, buildErrorBudget, checkBudgetAgainstRequest, formatCertificate,
  isFullyVerified,
} from "./certificate.js";
import { estimateTime, formatDuration } from "./time.js";

const FLAT4: ToolGeometry = { type: "flat", diameter: mm(4) };
const BALL6: ToolGeometry = { type: "ball", diameter: mm(6) };

const STOCK: StockDefinition = {
  width: 40, depth: 40, height: 10,
  originX: -20, originY: -20, topZ: 0,
};

describe("DexelSim", () => {
  it("starts as an untouched block at the stock top", () => {
    const sim = new DexelSim(STOCK, { resolution: 80 });
    expect(sim.heights.every((h) => h === 0)).toBe(true);
  });

  it("a flat tool cuts a flat-bottomed pocket to exactly the commanded depth", () => {
    const sim = new DexelSim(STOCK, { resolution: 200 });
    sim.sweep({
      kind: "cut", tool: FLAT4, index: 0,
      from: { x: -10, y: 0, z: -3 },
      to: { x: 10, y: 0, z: -3 },
    });

    // Directly under the swept line, the floor must be exactly -3.
    const idxAt = (x: number, y: number) =>
      Math.round((y - STOCK.originY) / sim.cellD) * (sim.nx + 1) +
      Math.round((x - STOCK.originX) / sim.cellW);

    for (const x of [-8, -4, 0, 4, 8]) {
      expect(sim.heights[idxAt(x, 0)]).toBeCloseTo(-3, 9);
    }
    // Outside the tool's 2 mm radius, untouched.
    expect(sim.heights[idxAt(0, 5)]).toBeCloseTo(0, 9);
  });

  it("a ball tool leaves a trough of the right profile", () => {
    const sim = new DexelSim(STOCK, { resolution: 300 });
    const R = 3;
    sim.sweep({
      kind: "cut", tool: BALL6, index: 0,
      from: { x: -10, y: 0, z: -2 },
      to: { x: 10, y: 0, z: -2 },
    });

    const idxAt = (x: number, y: number) =>
      Math.round((y - STOCK.originY) / sim.cellD) * (sim.nx + 1) +
      Math.round((x - STOCK.originX) / sim.cellW);

    // At lateral offset d from the axis, the ball surface sits at
    // tipZ + R - sqrt(R^2 - d^2) above the tip.
    for (const d of [0, 1, 2]) {
      const expected = -2 + R - Math.sqrt(R * R - d * d);
      expect(sim.heights[idxAt(0, d)]).toBeCloseTo(expected, 1);
    }
  });

  it("reports engagement depth and can query without removing", () => {
    const sim = new DexelSim(STOCK, { resolution: 100 });
    const probe = sim.stamp(0, 0, -2, FLAT4, false);
    expect(probe).toBeCloseTo(2, 6);
    // Nothing was removed by the query.
    expect(sim.heights.every((h) => h === 0)).toBe(true);

    const real = sim.stamp(0, 0, -2, FLAT4, true);
    expect(real).toBeCloseTo(2, 6);
    expect(sim.heights.some((h) => h < -1)).toBe(true);
  });

  it("clamps gouges for rendering but reports their true depth", () => {
    const sim = new DexelSim(STOCK, { resolution: 60 });
    // Plunge far below the stock bottom (-10).
    const depth = sim.stamp(0, 0, -30, FLAT4, true);
    expect(depth).toBeCloseTo(30, 6);           // true depth, unclamped
    expect(Math.min(...sim.heights)).toBe(sim.renderFloor); // clamped for display
    expect(sim.renderFloor).toBeGreaterThan(-30);
  });

  it("supports snapshot and restore for playback scrubbing", () => {
    const sim = new DexelSim(STOCK, { resolution: 80 });
    sim.stamp(0, 0, -2, FLAT4);
    const snap = sim.snapshot();
    sim.stamp(5, 5, -6, FLAT4);
    expect(sim.heights).not.toEqual(snap);
    sim.restore(snap);
    expect(Array.from(sim.heights)).toEqual(Array.from(snap));
  });

  it("ignores moves entirely outside the stock", () => {
    const sim = new DexelSim(STOCK, { resolution: 60 });
    const cut = sim.sweep({
      kind: "cut", tool: FLAT4, index: 0,
      from: { x: 500, y: 500, z: -5 },
      to: { x: 520, y: 500, z: -5 },
    });
    expect(cut).toBe(0);
    expect(sim.heights.every((h) => h === 0)).toBe(true);
  });
});

describe("deviation analysis", () => {
  const dome = tessellate({ ...PRESETS.dome, n: 100 }, "dome");
  const domeStock: StockDefinition = {
    width: 36, depth: 36, height: 16, originX: -18, originY: -18, topZ: 15,
  };

  it("rasterises the target mesh onto the grid", () => {
    const sim = new DexelSim(domeStock, { resolution: 120 });
    const target = rasteriseTarget(sim, dome, 0);
    const idxAt = (x: number, y: number) =>
      Math.round((y - domeStock.originY) / sim.cellD) * (sim.nx + 1) +
      Math.round((x - domeStock.originX) / sim.cellW);

    // The dome is a hemisphere of radius 14 centred at the origin.
    expect(target[idxAt(0, 0)]).toBeCloseTo(14, 0);
    expect(target[idxAt(10, 0)]).toBeCloseTo(Math.sqrt(196 - 100), 0);
    // Outside the dome, the target is the floor.
    expect(target[idxAt(17, 17)]).toBeCloseTo(0, 6);
  });

  it("reports zero deviation when the stock already matches the target", () => {
    const sim = new DexelSim(domeStock, { resolution: 100 });
    const target = rasteriseTarget(sim, dome, 0);
    sim.heights.set(target);

    const result = analyseDeviation(sim, target, 0, 0.05);
    expect(result.rms).toBeCloseTo(0, 9);
    expect(result.percentInTolerance).toBeCloseTo(100, 6);
    expect(result.gougeDepth).toBeCloseTo(0, 9);
  });

  it("detects a gouge", () => {
    const sim = new DexelSim(domeStock, { resolution: 100 });
    const target = rasteriseTarget(sim, dome, 0);
    sim.heights.set(target);
    // Cut 0.5 mm too deep at the apex.
    const centre = Math.round(18 / sim.cellD) * (sim.nx + 1) + Math.round(18 / sim.cellW);
    sim.heights[centre] -= 0.5;

    const result = analyseDeviation(sim, target, 0, 0.05);
    expect(result.gougeDepth).toBeCloseTo(0.5, 6);
    expect(result.minDeviation).toBeCloseTo(-0.5, 6);
  });

  it("reports excess stock as positive deviation", () => {
    const sim = new DexelSim(domeStock, { resolution: 100 });
    const target = rasteriseTarget(sim, dome, 0);
    // Nothing machined at all: the whole block is excess.
    const result = analyseDeviation(sim, target, 0, 0.05);
    expect(result.maxDeviation).toBeGreaterThan(10);
    expect(result.percentInTolerance).toBeLessThan(5);
  });

  /**
   * Defect D2. The prototype divided the in-tolerance count by ALL grid nodes
   * including the empty margin around the part, so a job that machined nothing
   * still scored well if the margin was large. The percentage must be over PART
   * nodes only.
   */
  it("D2 regression: percentInTolerance counts part nodes, not empty margin", () => {
    // A stock much larger than the part, so the margin dominates the grid.
    const bigStock: StockDefinition = {
      width: 120, depth: 120, height: 16, originX: -60, originY: -60, topZ: 15,
    };
    const sim = new DexelSim(bigStock, { resolution: 160 });
    const target = rasteriseTarget(sim, dome, 0);

    // Machine nothing. Every PART node is wildly out of tolerance; every margin
    // node happens to match the floor. A whole-grid denominator would score this
    // as mostly fine.
    const result = analyseDeviation(sim, target, 0, 0.05);
    expect(result.percentInTolerance).toBeLessThan(5);
  });

  it("colours gouge red, in-tolerance green, excess blue", () => {
    const gouge = deviationColour(-0.1, 0.05);
    const good = deviationColour(0.01, 0.05);
    const excess = deviationColour(0.5, 0.05);
    expect(gouge[0]).toBeGreaterThan(gouge[2]);   // red dominant
    expect(good[1]).toBeGreaterThan(good[0]);     // green dominant
    expect(excess[2]).toBeGreaterThan(excess[0]); // blue dominant
  });
});

describe("sampled safety checks", () => {
  const stock: StockDefinition = {
    width: 90, depth: 60, height: 6, originX: 0, originY: 0, topZ: 0,
  };

  it("detects a rapid ploughing through uncut stock", () => {
    const moves: CheckMove[] = [
      // A rapid at Z = -0.5 straight across the middle of untouched stock.
      { kind: "rapid", tool: FLAT4, gcodeLine: 10,
        from: { x: 10, y: 30, z: -0.5 }, to: { x: 80, y: 30, z: -0.5 } },
    ];
    const result = runSampledChecks(moves, { stock, safeZ: 1 });
    expect(result.diagnostics.some((d) => d.code === "rapid.throughStock")).toBe(true);
    expect(result.worstRapidCrash).toBeGreaterThan(0.4);
  });

  it("does not flag a rapid above the stock", () => {
    const moves: CheckMove[] = [
      { kind: "rapid", tool: FLAT4, gcodeLine: 10,
        from: { x: 10, y: 30, z: 5 }, to: { x: 80, y: 30, z: 5 } },
    ];
    const result = runSampledChecks(moves, { stock, safeZ: 1 });
    expect(result.diagnostics.some((d) => d.code === "rapid.throughStock")).toBe(false);
    expect(result.worstRapidCrash).toBe(0);
  });

  it("warns about rapids below the safe height even when they miss material", () => {
    const moves: CheckMove[] = [
      // Cut a channel first, then rapid along it — low, but through fresh air.
      { kind: "cut", tool: FLAT4, gcodeLine: 5,
        from: { x: 10, y: 30, z: -2 }, to: { x: 80, y: 30, z: -2 } },
      { kind: "rapid", tool: FLAT4, gcodeLine: 6,
        from: { x: 80, y: 30, z: -1 }, to: { x: 10, y: 30, z: -1 } },
    ];
    const result = runSampledChecks(moves, { stock, safeZ: 1 });
    expect(result.diagnostics.some((d) => d.code === "rapid.belowSafeZ")).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "rapid.throughStock")).toBe(false);
  });

  it("detects cutting into the spoilboard", () => {
    const moves: CheckMove[] = [
      { kind: "cut", tool: FLAT4, gcodeLine: 20,
        from: { x: 20, y: 20, z: -6.5 }, to: { x: 40, y: 20, z: -6.5 } },
    ];
    const result = runSampledChecks(moves, { stock, safeZ: 1 });
    expect(result.diagnostics.some((d) => d.code === "stock.spoilboard")).toBe(true);
    expect(result.worstSpoilboard).toBeCloseTo(0.5, 6);
  });

  it("reports one diagnostic per offending line, not per sample", () => {
    const moves: CheckMove[] = Array.from({ length: 5 }, (_, i) => ({
      kind: "rapid" as const, tool: FLAT4, gcodeLine: 42,
      from: { x: 10 + i, y: 30, z: -0.5 }, to: { x: 11 + i, y: 30, z: -0.5 },
    }));
    const result = runSampledChecks(moves, { stock, safeZ: 1 });
    expect(result.diagnostics.filter((d) => d.code === "rapid.throughStock")).toHaveLength(1);
  });
});

describe("safety certificate", () => {
  const budget = buildErrorBudget([
    { stage: "chord-refinement", geometric: mm(0.01), rationale: "chord tolerance" },
    { stage: "gcode-rounding", geometric: mm(0.0005), rationale: "3 decimals" },
  ]);

  it("sums the error budget conservatively", () => {
    expect(budget.totalGeometric).toBeCloseTo(0.0105, 9);
  });

  it("reports sampled checks with their actual resolution", () => {
    const cert = buildCertificate({
      simulation: {
        spatialResolution: mm(0.15),
        numericalTolerance: mm(0.01),
        gougeDepth: 0,
        rapidCrashDepth: 0,
      },
      hasRawEscape: false,
      budget,
      warnings: [],
    });

    expect(cert.gouge.kind).toBe("verified-to-resolution");
    if (cert.gouge.kind === "verified-to-resolution") {
      expect(cert.gouge.spatial).toBe(0.15);
    }
    expect(cert.travel.kind).toBe("verified-exact");
  });

  it("reports not-checked rather than passing when the simulation did not run", () => {
    const cert = buildCertificate({ hasRawEscape: false, budget, warnings: [] });
    expect(cert.gouge.kind).toBe("not-checked");
    expect(cert.rapidCrash.kind).toBe("not-checked");
    expect(isFullyVerified(cert)).toBe(false);
  });

  it("always reports fixture and holder as not-checked in v1", () => {
    const cert = buildCertificate({
      simulation: {
        spatialResolution: mm(0.1), numericalTolerance: mm(0.01),
        gougeDepth: 0, rapidCrashDepth: 0,
      },
      hasRawEscape: false, budget, warnings: [],
    });
    expect(cert.fixture.kind).toBe("not-checked");
    expect(cert.holder.kind).toBe("not-checked");
    // ...and therefore the program is never claimed to be fully verified in the
    // colloquial sense, only in the sense of the checks that exist.
    expect(isFullyVerified(cert)).toBe(true); // the six modelled checks passed
  });

  it("downgrades everything analysable to unverifiable when a raw escape is present", () => {
    const cert = buildCertificate({
      simulation: {
        spatialResolution: mm(0.1), numericalTolerance: mm(0.01),
        gougeDepth: 0, rapidCrashDepth: 0,
      },
      hasRawEscape: true, budget, warnings: [],
    });
    expect(cert.travel.kind).toBe("unverifiable");
    expect(cert.interlocks.kind).toBe("unverifiable");
    expect(isFullyVerified(cert)).toBe(false);
  });

  it("warns when the requested finish is below the achievable budget", () => {
    const diags = checkBudgetAgainstRequest(budget, 0.005);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe("tolerance.budgetExceeded");
    expect(diags[0].message).toMatch(/chord-refinement/);
  });

  it("stays quiet when the request is achievable", () => {
    expect(checkBudgetAgainstRequest(budget, 0.05)).toHaveLength(0);
  });

  it("formats as a readable checklist, not a boolean", () => {
    const cert = buildCertificate({
      simulation: {
        spatialResolution: mm(0.15), numericalTolerance: mm(0.01),
        gougeDepth: 0, rapidCrashDepth: 0,
      },
      hasRawEscape: false, budget, warnings: [],
    });
    const text = formatCertificate(cert);
    expect(text).toContain("SAFETY CERTIFICATE");
    expect(text).toContain("verified to 0.150 mm grid");
    expect(text).toContain("not checked — no fixture model has been defined");
    expect(text).toContain("error budget");
  });
});

describe("time estimation", () => {
  it("sums length over feed", () => {
    const est = estimateTime([
      { kind: "cut", length: 100, feed: 600 },   // 10 s
      { kind: "rapid", length: 300, feed: 0 },   // 300/3000*60 = 6 s
    ], 3000);
    expect(est.cutting).toBeCloseTo(10, 6);
    expect(est.rapid).toBeCloseTo(6, 6);
    expect(est.total).toBeCloseTo(16, 6);
    expect(est.cutLength).toBe(100);
  });

  it("labels its model so the UI can qualify the number", () => {
    expect(estimateTime([], 3000).model).toBe("length-over-feed");
  });

  it("formats durations", () => {
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3725)).toBe("1:02:05");
  });
});
