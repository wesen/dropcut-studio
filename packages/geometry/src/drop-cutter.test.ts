/**
 * Drop-cutter correctness, against closed-form ground truth.
 *
 * Prototype parity would only prove we copied faithfully. These tests instead
 * check the kernel against shapes whose exact cutter-location surface is known
 * analytically, which catches errors the prototype might also have had.
 *
 * The key identity: for a HEMISPHERE of radius R0 and a BALL tool of radius R,
 * the CL surface (the locus of tool-tip positions) is a hemisphere of radius
 * R0 + R, lowered by R. That is exact, not approximate, and it exercises all
 * three contact cases at once.
 */

import { describe, expect, it } from "vitest";
import { mm } from "@cam/units";
import type { ToolGeometry } from "@cam/machine";
import { makeCutterLocation } from "./drop-cutter.js";
import { meshFromTriangles, PRESETS, tessellate } from "./mesh.js";

const BALL = (d: number): ToolGeometry => ({ type: "ball", diameter: mm(d) });
const FLAT = (d: number): ToolGeometry => ({ type: "flat", diameter: mm(d) });

/** A single triangle in the z = h plane, spanning a generous area. */
function flatPlate(h: number, half = 30) {
  return meshFromTriangles(new Float64Array([
    -half, -half, h, half, -half, h, half, half, h,
    -half, -half, h, half, half, h, -half, half, h,
  ]), "plate");
}

/** A 45-degree ramp rising in +X from z=0 at x=0. */
function ramp(half = 30) {
  return meshFromTriangles(new Float64Array([
    -half, -half, 0, half, -half, half * 2, half, half, half * 2,
    -half, -half, 0, half, half, half * 2, -half, half, 0,
  ]), "ramp");
}

describe("flat plate", () => {
  it("a ball tool tip sits exactly on the plate", () => {
    const evalZ = makeCutterLocation(flatPlate(3), BALL(6), { floorZ: -10 });
    for (const [x, y] of [[0, 0], [5, -5], [-8, 2], [12.5, 7.25]]) {
      expect(evalZ(x, y)).toBeCloseTo(3, 9);
    }
  });

  it("a flat tool tip sits exactly on the plate", () => {
    const evalZ = makeCutterLocation(flatPlate(3), FLAT(6), { floorZ: -10 });
    expect(evalZ(0, 0)).toBeCloseTo(3, 9);
    expect(evalZ(-4, 9)).toBeCloseTo(3, 9);
  });

  it("falls back to the floor away from any geometry", () => {
    const evalZ = makeCutterLocation(flatPlate(3, 5), BALL(2), { floorZ: -7 });
    expect(evalZ(40, 40)).toBeCloseTo(-7, 9);
  });
});

describe("45-degree ramp", () => {
  /**
   * On a plane of slope m, a ball of radius R rides with its tip offset from the
   * surface directly below it. The tip Z is
   *     z_tip = z_plane(x) + R * (sqrt(1 + m^2) - 1)  ... measured at the tool axis
   * because the contact point moves uphill by R*m/sqrt(1+m^2).
   */
  it("a ball tool rides the plane at the analytic offset", () => {
    const R = 3;
    const m = 1; // 45 degrees
    const evalZ = makeCutterLocation(ramp(), BALL(2 * R), { floorZ: -50 });
    const expectedAt = (x: number) => (x + 30) * m + R * (Math.sqrt(1 + m * m) - 1);
    for (const x of [-10, -5, 0, 5, 10]) {
      expect(evalZ(x, 0)).toBeCloseTo(expectedAt(x), 6);
    }
  });

  it("a flat tool contacts at its uphill rim", () => {
    const R = 3;
    const m = 1;
    const evalZ = makeCutterLocation(ramp(), FLAT(2 * R), { floorZ: -50 });
    // The highest point under the disc is R uphill of the axis.
    const expectedAt = (x: number) => (x + 30 + R) * m;
    for (const x of [-10, 0, 10]) {
      expect(evalZ(x, 0)).toBeCloseTo(expectedAt(x), 6);
    }
  });
});

describe("hemisphere — the closed-form benchmark", () => {
  const R0 = 14;
  const mesh = tessellate({ ...PRESETS.dome, n: 300 }, "dome");

  it("a ball tool traces a hemisphere of radius R0 + R", () => {
    const R = 3;
    const evalZ = makeCutterLocation(mesh, BALL(2 * R), { floorZ: 0 });

    // Sample well inside the dome, where tessellation error is smallest.
    for (const r of [0, 2, 5, 8, 10]) {
      for (const theta of [0, 0.7, 1.9, 3.3, 5.1]) {
        const x = r * Math.cos(theta);
        const y = r * Math.sin(theta);
        // CL surface: sphere of radius R0+R centred at the origin, tip lowered by R.
        const expected = Math.sqrt((R0 + R) ** 2 - r * r) - R;
        expect(evalZ(x, y)).toBeGreaterThan(expected - 0.02);
        expect(evalZ(x, y)).toBeLessThan(expected + 0.02);
      }
    }
  });

  it("the CL surface is never BELOW the true surface (no gouging)", () => {
    const R = 3;
    const evalZ = makeCutterLocation(mesh, BALL(2 * R), { floorZ: 0 });
    // A faceted mesh can only ever sit at or below the ideal sphere, so the CL
    // height must be at least the ideal minus the facet sagitta. The critical
    // direction is the other one: it must never dip below the true part.
    for (let r = 0; r <= 13; r += 0.37) {
      const trueZ = Math.sqrt(R0 * R0 - r * r);
      expect(evalZ(r, 0)).toBeGreaterThan(trueZ - 0.05);
    }
  });

  it("a larger tool produces a higher CL surface everywhere", () => {
    const small = makeCutterLocation(mesh, BALL(2), { floorZ: 0 });
    const large = makeCutterLocation(mesh, BALL(12), { floorZ: 0 });
    for (let r = 0; r <= 12; r += 1.3) {
      expect(large(r, 0)).toBeGreaterThanOrEqual(small(r, 0) - 1e-9);
    }
  });
});

describe("inflation (stock to leave)", () => {
  it("raises the CL surface by exactly the allowance on a flat plate", () => {
    const plain = makeCutterLocation(flatPlate(2), BALL(6), { floorZ: -10 });
    const inflated = makeCutterLocation(flatPlate(2), BALL(6), { floorZ: -10, inflate: 0.5 });
    expect(inflated(0, 0) - plain(0, 0)).toBeCloseTo(0.5, 9);
  });

  it("keeps the inflated surface above the plain one on curved geometry", () => {
    const mesh = tessellate({ ...PRESETS.dome, n: 200 }, "dome");
    const plain = makeCutterLocation(mesh, BALL(6), { floorZ: 0 });
    const inflated = makeCutterLocation(mesh, BALL(6), { floorZ: 0, inflate: 0.4 });
    for (let r = 0; r <= 12; r += 1.7) {
      expect(inflated(r, 0)).toBeGreaterThan(plain(r, 0));
    }
  });
});

describe("sharp features", () => {
  it("a ball tool cannot reach into a corner narrower than its radius", () => {
    // A V-groove: two planes meeting at x=0, descending to z=0.
    const half = 20;
    const mesh = meshFromTriangles(new Float64Array([
      -half, -half, half, 0, -half, 0, 0, half, 0,
      -half, -half, half, 0, half, 0, -half, half, half,
      0, -half, 0, half, -half, half, half, half, half,
      0, -half, 0, half, half, half, 0, half, 0,
    ]), "vee");

    const R = 4;
    const evalZ = makeCutterLocation(mesh, BALL(2 * R), { floorZ: -20 });
    // At the bottom of a 90-degree vee, a ball of radius R rides high: its centre
    // is R*sqrt(2) above the vertex, so the tip is R*(sqrt(2) - 1) above it.
    const expected = R * (Math.SQRT2 - 1);
    expect(evalZ(0, 0)).toBeGreaterThan(expected - 0.05);
    expect(evalZ(0, 0)).toBeLessThan(expected + 0.05);
  });

  it("a flat tool reaches the bottom of the same vee", () => {
    const half = 20;
    const mesh = meshFromTriangles(new Float64Array([
      -half, -half, half, 0, -half, 0, 0, half, 0,
      -half, -half, half, 0, half, 0, -half, half, half,
      0, -half, 0, half, -half, half, half, half, half,
      0, -half, 0, half, half, half, 0, half, 0,
    ]), "vee");
    // A flat tool of radius R centred on the vee still rides on its rim.
    const R = 4;
    const evalZ = makeCutterLocation(mesh, FLAT(2 * R), { floorZ: -20 });
    expect(evalZ(0, 0)).toBeCloseTo(R, 3); // rim at x = +/-R, where z = R
  });
});

describe("performance", () => {
  /**
   * Throughput depends on TRIANGLE DENSITY RELATIVE TO THE TOOL, not on triangle
   * count. The tool disc sweeps a fixed area, so the work per query is
   * proportional to (triangles per mm^2) * pi * R^2 before pruning.
   *
   * The design doc's original ">200k queries/s on a 100k-tri mesh" was an
   * unmeasured estimate and is not achievable at that density — a 6 mm tool on a
   * 50 tri/mm^2 mesh has ~1,400 triangles under it on every single query. These
   * budgets are measured, and are set with ~2x headroom over observed values so
   * they catch regressions without failing on a loaded CI box.
   */
  function throughput(mesh: ReturnType<typeof tessellate>, diameter: number, N: number) {
    const evalZ = makeCutterLocation(mesh, BALL(diameter), { floorZ: 0 });
    const half = (mesh.bounds.maxX - mesh.bounds.minX) / 2;
    const side = Math.round(Math.sqrt(N));
    let best = Infinity;
    for (let pass = 0; pass < 3; pass++) {
      const t0 = performance.now();
      let acc = 0;
      for (let i = 0; i < N; i++) {
        const x = -half + (2 * half * (i % side)) / side;
        const y = -half + (2 * half * Math.floor(i / side)) / side;
        acc += evalZ(x, y);
      }
      best = Math.min(best, performance.now() - t0);
      expect(Number.isFinite(acc)).toBe(true);
    }
    return (N / best) * 1000;
  }

  it("handles a typical part density", () => {
    // ~18k triangles over 36 mm: about 14 triangles/mm^2, typical of a real STL.
    const mesh = tessellate({ ...PRESETS.dome, n: 96 }, "dome");
    const qps = throughput(mesh, 6, 40_000);
    console.log(`  drop-cutter: ${Math.round(qps).toLocaleString()} q/s on ` +
      `${mesh.triangleCount.toLocaleString()} tri (typical density)`);
    expect(qps).toBeGreaterThan(60_000);
  });

  it("handles a deliberately dense mesh", () => {
    // ~97k triangles over 44 mm: about 50 triangles/mm^2. Pathological, kept as
    // the worst-case regression guard.
    const mesh = tessellate({ ...PRESETS.hills, n: 220 }, "hills");
    const qps = throughput(mesh, 6, 20_000);
    console.log(`  drop-cutter: ${Math.round(qps).toLocaleString()} q/s on ` +
      `${mesh.triangleCount.toLocaleString()} tri (dense)`);
    expect(qps).toBeGreaterThan(20_000);
  });

  it("builds the spatial index quickly", () => {
    const mesh = tessellate({ ...PRESETS.hills, n: 220 }, "hills");
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      makeCutterLocation(mesh, BALL(6), { floorZ: 0 });
      best = Math.min(best, performance.now() - t0);
    }
    console.log(`  index build: ${best.toFixed(1)} ms for ` +
      `${mesh.triangleCount.toLocaleString()} triangles`);
    expect(best).toBeLessThan(300);
  });
});
