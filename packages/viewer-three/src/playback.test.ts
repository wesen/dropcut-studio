/**
 * Playback edge cases.
 *
 * All three prototypes wrote this binary search separately, and the cases that
 * break it are the boring ones: an empty program, a time before the first
 * motion, a time past the end, and a zero-duration motion (a dwell, or a move of
 * zero length) which divides by zero if you are not careful.
 */

import { describe, expect, it } from "vitest";
import { MoveKind } from "@cam/ir";
import type { TimelineMotion } from "./playback.js";
import { buildRenderBuffers, sampleAt, trailCount } from "./playback.js";

const at = (x: number, y: number, z: number) => ({ x, y, z });

const line = (
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  seconds: number,
  kind: "rapid" | "cut" = "cut",
  gcodeLine = 0,
  purpose = "finish",
): TimelineMotion => ({ kind, from, to, seconds, gcodeLine, purpose });

describe("buildRenderBuffers", () => {
  it("produces one point per motion plus the initial start", () => {
    const b = buildRenderBuffers([
      line(at(0, 0, 0), at(10, 0, 0), 1),
      line(at(10, 0, 0), at(10, 10, 0), 1),
    ]);
    expect(b.count).toBe(3);
    expect(Array.from(b.positions.slice(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(b.positions.slice(6, 9))).toEqual([10, 10, 0]);
    expect(b.totalSeconds).toBe(2);
  });

  it("handles an empty program", () => {
    const b = buildRenderBuffers([]);
    expect(b.count).toBe(0);
    expect(b.totalSeconds).toBe(0);
    expect(sampleAt(b, 5).motionIndex).toBe(-1);
    expect(trailCount(b, 5)).toBe(0);
  });

  it("classifies move kinds for colouring", () => {
    const b = buildRenderBuffers([
      line(at(0, 0, 5), at(0, 0, 5), 0.1, "rapid"),
      line(at(0, 0, 5), at(0, 0, 0), 0.5, "cut", 0, "plunge"),
      line(at(0, 0, 0), at(5, 0, 0), 1, "cut", 0, "rough"),
      line(at(5, 0, 0), at(9, 0, 0), 1, "cut", 0, "finish"),
    ]);
    expect(b.kinds[1]).toBe(MoveKind.Traverse);
    expect(b.kinds[2]).toBe(MoveKind.Plunge);
    expect(b.kinds[3]).toBe(MoveKind.Rough);
    expect(b.kinds[4]).toBe(MoveKind.Finish);
  });

  it("records the Z range for depth colouring", () => {
    const b = buildRenderBuffers([
      line(at(0, 0, 4), at(0, 0, -3), 1),
    ]);
    expect(b.minZ).toBe(-3);
    expect(b.maxZ).toBe(4);
  });
});

describe("sampleAt", () => {
  const b = buildRenderBuffers([
    line(at(0, 0, 0), at(10, 0, 0), 1, "cut", 11),
    line(at(10, 0, 0), at(10, 10, 0), 2, "cut", 12),
    line(at(10, 10, 0), at(10, 10, -5), 1, "cut", 13),
  ]);

  it("interpolates within a motion", () => {
    const s = sampleAt(b, 0.5);
    expect(s.x).toBeCloseTo(5, 9);
    expect(s.motionIndex).toBe(0);
    expect(s.done).toBe(false);
  });

  it("lands exactly on motion boundaries", () => {
    const s = sampleAt(b, 1);
    expect(s.x).toBeCloseTo(10, 9);
    expect(s.y).toBeCloseTo(0, 9);
  });

  it("interpolates within a later motion", () => {
    const s = sampleAt(b, 2); // 1s into the 2s second motion
    expect(s.x).toBeCloseTo(10, 9);
    expect(s.y).toBeCloseTo(5, 9);
    expect(s.motionIndex).toBe(1);
  });

  it("clamps before the start", () => {
    const s = sampleAt(b, -100);
    expect(s.x).toBe(0);
    expect(s.done).toBe(false);
  });

  it("clamps after the end and reports done", () => {
    const s = sampleAt(b, 1000);
    expect(s.x).toBeCloseTo(10, 9);
    expect(s.z).toBeCloseTo(-5, 9);
    expect(s.done).toBe(true);
  });

  it("reports the G-code line of the motion in progress", () => {
    expect(sampleAt(b, 0.5).gcodeLine).toBe(11);
    expect(sampleAt(b, 2).gcodeLine).toBe(12);
    expect(sampleAt(b, 3.5).gcodeLine).toBe(13);
  });

  it("survives a zero-duration motion without dividing by zero", () => {
    const z = buildRenderBuffers([
      line(at(0, 0, 0), at(1, 0, 0), 1),
      line(at(1, 0, 0), at(1, 0, 0), 0), // a dwell: no time, no distance
      line(at(1, 0, 0), at(2, 0, 0), 1),
    ]);
    for (const t of [0, 0.5, 1, 1.0000001, 1.5, 2]) {
      const s = sampleAt(z, t);
      expect(Number.isFinite(s.x)).toBe(true);
      expect(Number.isFinite(s.y)).toBe(true);
      expect(Number.isFinite(s.z)).toBe(true);
    }
    expect(sampleAt(z, 1).x).toBeCloseTo(1, 9);
    expect(sampleAt(z, 2).x).toBeCloseTo(2, 9);
  });

  it("handles a single-point program", () => {
    const one = buildRenderBuffers([line(at(3, 4, 5), at(3, 4, 5), 0)]);
    const s = sampleAt(one, 0);
    expect([s.x, s.y, s.z]).toEqual([3, 4, 5]);
  });

  it("is monotonic in time", () => {
    let previous = -Infinity;
    for (let t = 0; t <= 4; t += 0.13) {
      const s = sampleAt(b, t);
      const travelled = s.motionIndex + (s.done ? 1 : 0);
      expect(travelled).toBeGreaterThanOrEqual(previous);
      previous = travelled;
    }
  });
});

describe("trailCount", () => {
  const b = buildRenderBuffers([
    line(at(0, 0, 0), at(1, 0, 0), 1),
    line(at(1, 0, 0), at(2, 0, 0), 1),
    line(at(2, 0, 0), at(3, 0, 0), 1),
  ]);

  it("grows monotonically and reaches the full count", () => {
    let previous = 0;
    for (let t = 0; t <= 3.5; t += 0.25) {
      const c = trailCount(b, t);
      expect(c).toBeGreaterThanOrEqual(previous);
      previous = c;
    }
    expect(trailCount(b, 99)).toBe(b.count);
  });

  it("is zero-ish at the start", () => {
    expect(trailCount(b, 0)).toBeLessThanOrEqual(1);
  });
});
