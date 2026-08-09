/**
 * @cam/viewer-three/playback — the time index and render buffers.
 *
 * All three prototypes independently implemented a binary search over cumulative
 * motion times, each slightly differently. This is that function, written once,
 * with the edge cases that are easy to get wrong on a rewrite actually tested:
 * time before the first motion, after the last, zero-duration motions (a dwell,
 * or a move of zero length), and an empty program.
 *
 * Also here: the conversion from emitted motions to flat typed arrays. That is
 * the transport representation — `Path` objects with `Point3` members are right
 * for authoring and wrong for shipping to a renderer, so the boundary is explicit
 * rather than incidental.
 *
 * Design doc: Part VIII.5, VI.3.
 */

import type { MoveKindValue, RenderBuffers } from "@cam/ir";
import { MoveKind } from "@cam/ir";

export interface TimelineMotion {
  readonly kind: "rapid" | "cut";
  readonly from: { x: number; y: number; z: number };
  readonly to: { x: number; y: number; z: number };
  readonly seconds: number;
  readonly gcodeLine: number;
  readonly purpose?: string;
}

export interface Sample {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Index into the motion list, or -1 for an empty program. */
  readonly motionIndex: number;
  readonly gcodeLine: number;
  readonly done: boolean;
}

const EMPTY_SAMPLE: Sample = { x: 0, y: 0, z: 0, motionIndex: -1, gcodeLine: -1, done: true };

/**
 * Build render buffers from a motion timeline.
 *
 * One point per motion endpoint plus the very first start, so `positions` has
 * `motions.length + 1` points and the trail can be drawn by advancing a single
 * draw-range integer.
 */
export function buildRenderBuffers(
  motions: readonly TimelineMotion[],
): RenderBuffers {
  const count = motions.length + (motions.length > 0 ? 1 : 0);
  const positions = new Float32Array(count * 3);
  const kinds = new Uint8Array(count);
  const times = new Float64Array(count);
  const gcodeLines = new Int32Array(count);

  if (motions.length === 0) {
    return {
      positions, kinds, times, gcodeLines,
      count: 0, totalSeconds: 0, minZ: 0, maxZ: 0,
    };
  }

  let minZ = Infinity;
  let maxZ = -Infinity;
  let t = 0;

  const write = (i: number, p: { x: number; y: number; z: number },
                 kind: MoveKindValue, time: number, line: number) => {
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
    kinds[i] = kind;
    times[i] = time;
    gcodeLines[i] = line;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  };

  write(0, motions[0].from, kindOf(motions[0]), 0, motions[0].gcodeLine);

  for (let i = 0; i < motions.length; i++) {
    const m = motions[i];
    t += m.seconds;
    write(i + 1, m.to, kindOf(m), t, m.gcodeLine);
  }

  return {
    positions, kinds, times, gcodeLines,
    count,
    totalSeconds: t,
    minZ: Number.isFinite(minZ) ? minZ : 0,
    maxZ: Number.isFinite(maxZ) ? maxZ : 0,
  };
}

function kindOf(m: TimelineMotion): MoveKindValue {
  if (m.kind === "rapid") return MoveKind.Traverse;
  switch (m.purpose) {
    case "rough": return MoveKind.Rough;
    case "plunge": return MoveKind.Plunge;
    case "ramp": return MoveKind.Ramp;
    default: return MoveKind.Finish;
  }
}

/**
 * Position at time `t`, by binary search over cumulative times.
 *
 * `times[i]` is the time at which point `i` is REACHED, so the motion active at
 * time t is the one ending at the first point whose time exceeds t.
 */
export function sampleAt(buffers: RenderBuffers, t: number): Sample {
  const n = buffers.count;
  if (n === 0) return EMPTY_SAMPLE;
  if (n === 1) {
    return {
      x: buffers.positions[0], y: buffers.positions[1], z: buffers.positions[2],
      motionIndex: 0, gcodeLine: buffers.gcodeLines[0], done: true,
    };
  }

  if (t <= 0) {
    return {
      x: buffers.positions[0], y: buffers.positions[1], z: buffers.positions[2],
      motionIndex: 0, gcodeLine: buffers.gcodeLines[1] ?? buffers.gcodeLines[0], done: false,
    };
  }

  const last = n - 1;
  if (t >= buffers.times[last]) {
    return {
      x: buffers.positions[last * 3],
      y: buffers.positions[last * 3 + 1],
      z: buffers.positions[last * 3 + 2],
      motionIndex: last - 1,
      gcodeLine: buffers.gcodeLines[last],
      done: true,
    };
  }

  // Find the first index whose arrival time is >= t.
  let lo = 1;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (buffers.times[mid] < t) lo = mid + 1;
    else hi = mid;
  }

  const t0 = buffers.times[lo - 1];
  const t1 = buffers.times[lo];
  // A zero-duration motion (a dwell, or a zero-length move) would divide by
  // zero; treating it as fully complete is the right answer.
  const span = t1 - t0;
  const f = span > 1e-12 ? (t - t0) / span : 1;

  const a = (lo - 1) * 3;
  const b = lo * 3;
  return {
    x: buffers.positions[a] + (buffers.positions[b] - buffers.positions[a]) * f,
    y: buffers.positions[a + 1] + (buffers.positions[b + 1] - buffers.positions[a + 1]) * f,
    z: buffers.positions[a + 2] + (buffers.positions[b + 2] - buffers.positions[a + 2]) * f,
    motionIndex: lo - 1,
    gcodeLine: buffers.gcodeLines[lo],
    done: false,
  };
}

/** How many points of the trail have been traversed by time `t`. */
export function trailCount(buffers: RenderBuffers, t: number): number {
  if (buffers.count === 0) return 0;
  const s = sampleAt(buffers, t);
  return s.done ? buffers.count : Math.min(buffers.count, s.motionIndex + 1);
}
