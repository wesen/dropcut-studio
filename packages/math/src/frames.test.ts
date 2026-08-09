/**
 * Frame groupoid laws.
 *
 * These are the load-bearing invariants for every coordinate conversion in the
 * system, so they are property-tested rather than example-tested.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  apply, compose, identity, invert, point, rotationZ, samePoint, translation,
} from "./frames.js";
import { vec3 } from "./vec.js";

const finite = () => fc.double({ min: -500, max: 500, noNaN: true, noDefaultInfinity: true });
const angle = () => fc.double({ min: -Math.PI, max: Math.PI, noNaN: true, noDefaultInfinity: true });

const arbPointA = fc.tuple(finite(), finite(), finite()).map(([x, y, z]) => point(x, y, z, "a"));

const arbAB = fc.tuple(angle(), finite(), finite(), finite())
  .map(([t, x, y, z]) => rotationZ("a", "b", t, vec3(x, y, z)));
const arbBC = fc.tuple(angle(), finite(), finite(), finite())
  .map(([t, x, y, z]) => rotationZ("b", "c", t, vec3(x, y, z)));
const arbCD = fc.tuple(angle(), finite(), finite(), finite())
  .map(([t, x, y, z]) => rotationZ("c", "d", t, vec3(x, y, z)));

/** Rotations mix coordinates, so absolute error scales with magnitude. */
const EPS = 1e-6;

describe("frame groupoid", () => {
  it("every transform is invertible: invert(t) . t = identity", () => {
    fc.assert(
      fc.property(arbAB, arbPointA, (ab, p) => {
        const round = apply(invert(ab), apply(ab, p));
        expect(samePoint(round, p, EPS)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("composition agrees with sequential application", () => {
    fc.assert(
      fc.property(arbAB, arbBC, arbPointA, (ab, bc, p) => {
        const viaCompose = apply(compose(ab, bc), p);
        const viaSteps = apply(bc, apply(ab, p));
        expect(samePoint(viaCompose, viaSteps, EPS)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("composition is associative", () => {
    fc.assert(
      fc.property(arbAB, arbBC, arbCD, arbPointA, (ab, bc, cd, p) => {
        const left = apply(compose(compose(ab, bc), cd), p);
        const right = apply(compose(ab, compose(bc, cd)), p);
        expect(samePoint(left, right, EPS)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("identity is a left and right unit", () => {
    fc.assert(
      fc.property(arbAB, arbPointA, (ab, p) => {
        const withLeft = apply(compose(identity("a"), ab), p);
        const withRight = apply(compose(ab, identity("b")), p);
        const plain = apply(ab, p);
        expect(samePoint(withLeft, plain, EPS)).toBe(true);
        expect(samePoint(withRight, plain, EPS)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("invert is an involution", () => {
    fc.assert(
      fc.property(arbAB, arbPointA, (ab, p) => {
        expect(samePoint(apply(invert(invert(ab)), p), apply(ab, p), EPS)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe("frame tagging", () => {
  it("rejects applying a transform to a point in the wrong frame", () => {
    const t = translation("work", "machine", vec3(10, 20, 0));
    const wrong = point(1, 2, 3, "part");
    // @ts-expect-error — "part" is not assignable to the transform's "work" input
    expect(() => apply(t, wrong)).toThrow(/frame "part".*expects "work"/);
  });

  it("rejects composing transforms that do not chain", () => {
    const ab = translation("a", "b", vec3(1, 0, 0));
    const cd = translation("c", "d", vec3(0, 1, 0));
    // @ts-expect-error — "c" does not match "b"
    expect(() => compose(ab, cd)).toThrow(/cannot chain/);
  });

  it("translation moves a point by exactly the offset", () => {
    const t = translation("work", "machine", vec3(10, -5, 2));
    const p = apply(t, point(1, 2, 3, "work"));
    expect([p.x, p.y, p.z]).toEqual([11, -3, 5]);
    expect(p.frame).toBe("machine");
  });

  it("rotationZ by 90 degrees maps +X to +Y", () => {
    const t = rotationZ("a", "b", Math.PI / 2);
    const p = apply(t, point(1, 0, 0, "a"));
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(1, 12);
    expect(p.z).toBeCloseTo(0, 12);
  });
});
