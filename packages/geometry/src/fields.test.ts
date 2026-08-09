/**
 * CL field, contour extraction, and Eikonal solving — all against analytic
 * ground truth rather than prototype output.
 */

import { describe, expect, it } from "vitest";
import { mm } from "@cam/units";
import { box2 } from "@cam/math";
import type { ToolGeometry } from "@cam/machine";
import { buildCLField, fieldMax, sampleHeight, sampleSlope } from "./cl-field.js";
import { chain, marchingSquares, polylineLength, splitByMask } from "./contours.js";
import { maxArrival, scallopSlowness, solveEikonal } from "./eikonal.js";
import { makeCutterLocation } from "./drop-cutter.js";
import { PRESETS, tessellate } from "./mesh.js";

const BALL = (d: number): ToolGeometry => ({ type: "ball", diameter: mm(d) });

/** Build a grid directly from an analytic function, bypassing the mesh path. */
function analyticField(fn: (x: number, y: number) => number, half: number, spacing: number) {
  return buildCLField(fn, box2(-half, -half, half, half), spacing);
}

describe("CL field", () => {
  it("samples the evaluator and recovers it bilinearly at node points", () => {
    const mesh = tessellate({ ...PRESETS.dome, n: 200 }, "dome");
    const evalZ = makeCutterLocation(mesh, BALL(6), { floorZ: 0 });
    const field = buildCLField(evalZ, box2(-16, -16, 16, 16), 0.5)!;

    for (let j = 0; j <= field.ny; j += 7) {
      for (let i = 0; i <= field.nx; i += 7) {
        const x = field.x0 + i * field.spacing;
        const y = field.y0 + j * field.spacing;
        expect(sampleHeight(field, x, y)).toBeCloseTo(field.F[j * (field.nx + 1) + i], 9);
      }
    }
  });

  it("computes the slope of a known plane exactly", () => {
    // z = 0.5x + 0.25y has |grad| = hypot(0.5, 0.25).
    const field = analyticField((x, y) => 0.5 * x + 0.25 * y, 10, 0.5)!;
    const expected = Math.hypot(0.5, 0.25);
    // Skip the boundary, where one-sided differences apply.
    for (let j = 2; j < field.ny - 1; j += 3) {
      for (let i = 2; i < field.nx - 1; i += 3) {
        expect(field.G[j * (field.nx + 1) + i]).toBeCloseTo(expected, 9);
      }
    }
  });

  it("reports zero slope on a flat field", () => {
    const field = analyticField(() => 4, 10, 1)!;
    expect(fieldMax(field.G)).toBeCloseTo(0, 12);
    expect(sampleSlope(field, 3.3, -2.1)).toBeCloseTo(0, 12);
  });

  it("honours cancellation", () => {
    const aborted = { aborted: true };
    const field = buildCLField(() => 0, box2(-20, -20, 20, 20), 0.1, { signal: aborted });
    expect(field).toBeNull();
  });

  it("reports progress", () => {
    const seen: number[] = [];
    buildCLField(() => 0, box2(-10, -10, 10, 10), 0.2, { onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeLessThanOrEqual(1);
    // Monotonic.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });
});

describe("marching squares", () => {
  /** A cone: contours of z = H(1 - r/R0) at level L are circles of known radius. */
  it("extracts circles from a cone at the analytic radius", () => {
    const R0 = 14, H = 12;
    const field = analyticField(
      (x, y) => { const r = Math.hypot(x, y); return r < R0 ? H * (1 - r / R0) : 0; },
      18, 0.1,
    )!;

    for (const level of [3, 6, 9]) {
      const polys = marchingSquares(field.F, field.nx, field.ny, field.x0, field.y0,
        field.spacing, level);
      expect(polys).toHaveLength(1);
      const p = polys[0];
      expect(p.closed).toBe(true);

      const expectedR = R0 * (1 - level / H);
      for (let i = 0; i < p.pts.length; i += 2) {
        expect(Math.hypot(p.pts[i], p.pts[i + 1])).toBeCloseTo(expectedR, 1);
      }
      // Circumference within 1% of 2*pi*r.
      expect(polylineLength(p)).toBeGreaterThan(2 * Math.PI * expectedR * 0.99);
      expect(polylineLength(p)).toBeLessThan(2 * Math.PI * expectedR * 1.01);
    }
  });

  it("returns nothing for a level outside the data range", () => {
    const field = analyticField(() => 5, 10, 0.5)!;
    expect(marchingSquares(field.F, field.nx, field.ny, field.x0, field.y0,
      field.spacing, 99)).toHaveLength(0);
    expect(marchingSquares(field.F, field.nx, field.ny, field.x0, field.y0,
      field.spacing, -99)).toHaveLength(0);
  });

  it("finds two separate loops for two separate hills", () => {
    const field = analyticField((x, y) => {
      const g = (cx: number, cy: number) => 10 * Math.exp(-(((x - cx) ** 2 + (y - cy) ** 2) / 8));
      return g(-7, 0) + g(7, 0);
    }, 16, 0.1)!;

    const polys = marchingSquares(field.F, field.nx, field.ny, field.x0, field.y0,
      field.spacing, 5);
    expect(polys).toHaveLength(2);
    expect(polys.every((p) => p.closed)).toBe(true);
    // One loop around each peak.
    const centres = polys.map((p) => {
      let sx = 0;
      for (let i = 0; i < p.pts.length; i += 2) sx += p.pts[i];
      return sx / (p.pts.length / 2);
    }).sort((a, b) => a - b);
    expect(centres[0]).toBeLessThan(0);
    expect(centres[1]).toBeGreaterThan(0);
  });

  it("resolves the saddle case without self-crossing contours", () => {
    // A hyperbolic paraboloid z = xy has a genuine saddle at the origin.
    const field = analyticField((x, y) => x * y, 10, 0.25)!;
    const polys = marchingSquares(field.F, field.nx, field.ny, field.x0, field.y0,
      field.spacing, 0);
    expect(polys.length).toBeGreaterThan(0);
    // The zero level of xy is the two axes: every point must lie on one of them.
    for (const p of polys) {
      for (let i = 0; i < p.pts.length; i += 2) {
        const onAxis = Math.abs(p.pts[i]) < 1e-6 || Math.abs(p.pts[i + 1]) < 1e-6;
        expect(onAxis).toBe(true);
      }
    }
  });
});

describe("chaining", () => {
  it("joins segments into one open polyline", () => {
    const polys = chain([0, 0, 1, 0, 1, 0, 2, 0, 2, 0, 3, 0]);
    expect(polys).toHaveLength(1);
    expect(polys[0].closed).toBe(false);
    expect(Array.from(polys[0].pts)).toEqual([0, 0, 1, 0, 2, 0, 3, 0]);
  });

  it("detects a closed loop", () => {
    const polys = chain([0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0, 1, 0, 0]);
    expect(polys).toHaveLength(1);
    expect(polys[0].closed).toBe(true);
  });

  it("keeps disjoint pieces separate", () => {
    const polys = chain([0, 0, 1, 0, 5, 5, 6, 5]);
    expect(polys).toHaveLength(2);
  });

  it("grows a chain in both directions from the middle segment", () => {
    // Deliberately out of order so the walk must extend backwards too.
    const polys = chain([1, 0, 2, 0, 0, 0, 1, 0, 2, 0, 3, 0]);
    expect(polys).toHaveLength(1);
    expect(polys[0].pts.length / 2).toBe(4);
  });
});

describe("splitByMask", () => {
  const square: { pts: Float64Array; closed: boolean } = {
    pts: Float64Array.from([0, 0, 4, 0, 4, 4, 0, 4, 0, 0]),
    closed: true,
  };

  /** A closed loop sampled finely enough that runs contain several points. */
  function circle(n: number, r = 4) {
    const pts = new Float64Array((n + 1) * 2);
    for (let i = 0; i <= n; i++) {
      pts[i * 2] = r * Math.cos((2 * Math.PI * i) / n);
      pts[i * 2 + 1] = r * Math.sin((2 * Math.PI * i) / n);
    }
    return { pts, closed: true };
  }

  it("keeps a fully-surviving loop closed", () => {
    const out = splitByMask(square, () => true);
    expect(out).toHaveLength(1);
    expect(out[0].closed).toBe(true);
  });

  it("returns nothing when the mask rejects everything", () => {
    expect(splitByMask(square, () => false)).toHaveLength(0);
  });

  it("splits a loop into open runs", () => {
    const out = splitByMask(circle(64), (x) => x < 0);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.every((p) => !p.closed)).toBe(true);
    for (const p of out) {
      for (let i = 0; i < p.pts.length; i += 2) expect(p.pts[i]).toBeLessThan(0);
    }
  });

  it("merges a run that straddles the seam of a closed loop", () => {
    // Keep x > 0: on a circle starting at angle 0 that region wraps around the
    // array seam. It must come back as ONE run, not two, or the planner would
    // lift the tool in the middle of a continuous pass.
    const out = splitByMask(circle(64), (x) => x > 0);
    expect(out).toHaveLength(1);
    // Roughly half the samples survive.
    expect(out[0].pts.length / 2).toBeGreaterThan(28);
  });
});

describe("Eikonal solver", () => {
  it("on a flat surface, arrival time equals distance/stepover", () => {
    // Flat: |grad f| = 0, so f = 1/s0 and T is the distance to the boundary
    // divided by s0.
    const n = 60;
    const h = 0.5;
    const s0 = 1.0;
    const slope = new Float64Array((n + 1) * (n + 1)); // all zero
    const T = solveEikonal(scallopSlowness(slope, s0), n, n, h);

    const centre = T[(n / 2) * (n + 1) + n / 2];
    // Distance from the centre to the nearest boundary is (n/2)*h.
    const expected = ((n / 2) * h) / s0;
    // Fast sweeping on a square grid slightly overestimates diagonal distance;
    // a few percent is expected and acceptable for pass spacing.
    expect(centre).toBeGreaterThan(expected * 0.95);
    expect(centre).toBeLessThan(expected * 1.05);
  });

  it("a steeper surface produces more level sets over the same area", () => {
    const n = 60;
    const h = 0.5;
    const s0 = 1.0;

    const flat = new Float64Array((n + 1) * (n + 1));
    const steep = new Float64Array((n + 1) * (n + 1)).fill(2); // |grad f| = 2

    const tFlat = maxArrival(solveEikonal(scallopSlowness(flat, s0), n, n, h));
    const tSteep = maxArrival(solveEikonal(scallopSlowness(steep, s0), n, n, h));

    // sqrt(1+4) = 2.236x more surface distance per XY step.
    expect(tSteep / tFlat).toBeGreaterThan(2.0);
    expect(tSteep / tFlat).toBeLessThan(2.5);
  });

  it("halving the stepover doubles the number of passes", () => {
    const n = 50;
    const h = 0.5;
    const slope = new Float64Array((n + 1) * (n + 1));
    const coarse = maxArrival(solveEikonal(scallopSlowness(slope, 1.0), n, n, h));
    const fine = maxArrival(solveEikonal(scallopSlowness(slope, 0.5), n, n, h));
    expect(fine / coarse).toBeCloseTo(2, 1);
  });

  it("T is zero on the boundary and positive inside", () => {
    const n = 20;
    const slope = new Float64Array((n + 1) * (n + 1));
    const T = solveEikonal(scallopSlowness(slope, 1), n, n, 1);
    for (let i = 0; i <= n; i++) {
      expect(T[i]).toBe(0);
      expect(T[n * (n + 1) + i]).toBe(0);
    }
    expect(T[(n / 2) * (n + 1) + n / 2]).toBeGreaterThan(0);
  });

  it("its level sets form usable contours", () => {
    const n = 60;
    const h = 0.5;
    const slope = new Float64Array((n + 1) * (n + 1));
    const T = solveEikonal(scallopSlowness(slope, 1), n, n, h);
    // Level sets of distance-from-boundary on a square are rounded squares.
    const polys = marchingSquares(T, n, n, -15, -15, h, 5);
    expect(polys.length).toBeGreaterThan(0);
    expect(polys.some((p) => p.closed)).toBe(true);
  });
});
