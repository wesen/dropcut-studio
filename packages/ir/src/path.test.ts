import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { point, samePoint, vec3, distance, toVec3 } from "@cam/math";
import { rad } from "@cam/units";
import {
  arcPlane, concat, concatAll, emptyPath, isContinuous, pathFrom, pathLength,
  sampleArc, samplePath,
} from "./path.js";
import type { Path } from "./path.js";

const coord = () => fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true });

/** A random path in the "work" frame, starting wherever the caller says. */
function arbPathFrom(start: { x: number; y: number; z: number }) {
  return fc.array(fc.tuple(coord(), coord(), coord()), { minLength: 1, maxLength: 6 })
    .map((pts) => {
      const b = pathFrom(point(start.x, start.y, start.z, "work"));
      for (const [x, y, z] of pts) b.lineTo(point(x, y, z, "work"));
      return b.build();
    });
}

const arbStart = fc.tuple(coord(), coord(), coord()).map(([x, y, z]) => ({ x, y, z }));

/** Three paths that chain end-to-start, so composition is legal. */
const arbChain = arbStart.chain((s0) =>
  arbPathFrom(s0).chain((a) =>
    arbPathFrom(a.end).chain((b) =>
      arbPathFrom(b.end).map((c) => [a, b, c] as const),
    ),
  ),
);

function sameSegments(x: Path<"work">, y: Path<"work">): boolean {
  if (x.segments.length !== y.segments.length) return false;
  const px = samplePath(x);
  const py = samplePath(y);
  if (px.length !== py.length) return false;
  return px.every((p, i) => samePoint(p, py[i], 1e-9));
}

describe("path category laws", () => {
  it("concat is associative", () => {
    fc.assert(
      fc.property(arbChain, ([a, b, c]) => {
        const left = concat(concat(a, b), c);
        const right = concat(a, concat(b, c));
        expect(sameSegments(left, right)).toBe(true);
        expect(samePoint(left.start, right.start)).toBe(true);
        expect(samePoint(left.end, right.end)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("the empty path is a left and right identity", () => {
    fc.assert(
      fc.property(arbStart.chain((s) => arbPathFrom(s)), (a) => {
        const left = concat(emptyPath(a.start), a);
        const right = concat(a, emptyPath(a.end));
        expect(sameSegments(left, a)).toBe(true);
        expect(sameSegments(right, a)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("concat rejects paths that do not meet", () => {
    const a = pathFrom(point(0, 0, 0, "work")).lineTo(point(10, 0, 0, "work")).build();
    const b = pathFrom(point(99, 0, 0, "work")).lineTo(point(99, 5, 0, "work")).build();
    expect(() => concat(a, b)).toThrow(/do not meet/);
  });

  it("built paths are continuous and end where their last segment ends", () => {
    fc.assert(
      fc.property(arbStart.chain((s) => arbPathFrom(s)), (a) => {
        expect(isContinuous(a)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe("path construction", () => {
  it("drops degenerate zero-length line segments", () => {
    const p = pathFrom(point(0, 0, 0, "work"))
      .lineTo(point(0, 0, 0, "work"))
      .lineTo(point(1, 0, 0, "work"))
      .build();
    expect(p.segments).toHaveLength(1);
  });

  it("rejects a frame mismatch at build time", () => {
    const b = pathFrom(point(0, 0, 0, "work"));
    // @ts-expect-error — "part" is not the builder's "work" frame
    expect(() => b.lineTo(point(1, 1, 1, "part"))).toThrow(/frame mismatch/);
  });

  it("poly segments report their last point as the end", () => {
    const p = pathFrom(point(0, 0, 0, "work"))
      .polyTo(new Float64Array([1, 0, 0, 2, 0, 0, 3, 1, 0]))
      .build();
    expect([p.end.x, p.end.y, p.end.z]).toEqual([3, 1, 0]);
  });

  it("rejects poly arrays that are not a multiple of three", () => {
    const b = pathFrom(point(0, 0, 0, "work"));
    expect(() => b.polyTo(new Float64Array([1, 2, 3, 4]))).toThrow(/multiple of 3/);
  });
});

describe("arc sampling", () => {
  it("a quarter circle in XY has the expected length", () => {
    const R = 10;
    const start = point(R, 0, 0, "work");
    const p = pathFrom(start)
      .arcTo(point(0, R, 0, "work"), point(0, 0, 0, "work"), vec3(0, 0, 1), rad(Math.PI / 2))
      .build();
    // Chord approximation is inscribed, so it slightly undershoots the true arc.
    const expected = (Math.PI / 2) * R;
    expect(pathLength(p, 0.001)).toBeGreaterThan(expected * 0.999);
    expect(pathLength(p, 0.001)).toBeLessThanOrEqual(expected + 1e-9);
  });

  it("every sample lies on the circle within chord tolerance", () => {
    const R = 25;
    const center = point(0, 0, 0, "work");
    const seg = {
      kind: "arc" as const,
      to: point(-R, 0, 0, "work"),
      center,
      axis: vec3(0, 0, 1),
      sweep: rad(Math.PI),
    };
    const tol = 0.01;
    const pts = sampleArc(seg, point(R, 0, 0, "work"), tol);
    for (const q of pts) {
      const r = distance(toVec3(q), toVec3(center));
      expect(Math.abs(r - R)).toBeLessThanOrEqual(1e-9);
    }
    expect(samePoint(pts[pts.length - 1], seg.to)).toBe(true);
  });

  it("finer chord tolerance produces more samples", () => {
    const seg = {
      kind: "arc" as const,
      to: point(0, 10, 0, "work"),
      center: point(0, 0, 0, "work"),
      axis: vec3(0, 0, 1),
      sweep: rad(Math.PI / 2),
    };
    const coarse = sampleArc(seg, point(10, 0, 0, "work"), 0.1).length;
    const fine = sampleArc(seg, point(10, 0, 0, "work"), 0.001).length;
    expect(fine).toBeGreaterThan(coarse);
  });

  it("a helical arc interpolates height along the sweep", () => {
    const seg = {
      kind: "arc" as const,
      to: point(0, 10, -5, "work"),
      center: point(0, 0, 0, "work"),
      axis: vec3(0, 0, 1),
      sweep: rad(Math.PI / 2),
    };
    const pts = sampleArc(seg, point(10, 0, 0, "work"), 0.01);
    expect(pts[pts.length - 1].z).toBeCloseTo(-5, 9);
    // Heights should descend monotonically.
    for (let i = 1; i < pts.length; i++) expect(pts[i].z).toBeLessThanOrEqual(pts[i - 1].z + 1e-12);
  });
});

describe("arcPlane", () => {
  it("classifies axis-aligned arcs", () => {
    expect(arcPlane(vec3(0, 0, 1))).toBe("XY");
    expect(arcPlane(vec3(0, 0, -1))).toBe("XY");
    expect(arcPlane(vec3(0, 1, 0))).toBe("XZ");
    expect(arcPlane(vec3(1, 0, 0))).toBe("YZ");
  });

  it("returns null for an oblique axis so the post can linearize it", () => {
    const s = 1 / Math.sqrt(3);
    expect(arcPlane(vec3(s, s, s))).toBeNull();
  });
});

describe("concatAll", () => {
  it("chains a sequence of meeting paths", () => {
    const a = pathFrom(point(0, 0, 0, "work")).lineTo(point(1, 0, 0, "work")).build();
    const b = pathFrom(point(1, 0, 0, "work")).lineTo(point(1, 1, 0, "work")).build();
    const c = pathFrom(point(1, 1, 0, "work")).lineTo(point(0, 1, 0, "work")).build();
    const all = concatAll([a, b, c]);
    expect(all.segments).toHaveLength(3);
    expect([all.end.x, all.end.y]).toEqual([0, 1]);
  });

  it("rejects an empty list rather than inventing a start point", () => {
    expect(() => concatAll([])).toThrow(/at least one/);
  });
});
