/**
 * @cam/machine/profile — machine capabilities as data.
 *
 * The rule (ADR / DESIGN-01 §27): never write `if (machine === "Makera")` in the
 * compiler. Capabilities are data; lowering is driven by them. Adding a machine
 * is adding a record, not editing the compiler.
 *
 * Design doc: Part IV.9.
 */

import type { Mm, MmPerMin, Range, Rpm } from "@cam/units";
import { mm, mmPerMin, range, rpm } from "@cam/units";

export type Axis = "X" | "Y" | "Z" | "A" | "B" | "C";
export type SpindleDirection = "cw" | "ccw";
export type DialectId = "rs274" | "makera" | "linuxcnc";

export interface InterpolationCaps {
  readonly linear: true;
  readonly arcXY: boolean;
  readonly arcXZ: boolean;
  readonly arcYZ: boolean;
  readonly helical: boolean;
}

export type ProbeCaps = { readonly kind: "g38" } | { readonly kind: "g31" } | null;

export interface MachineProfile {
  readonly id: string;
  readonly name: string;
  readonly axes: readonly Axis[];

  /**
   * Axis limits expressed in the WORK frame.
   *
   * This is a simplification: physically these are machine-frame limits, and
   * where work zero sits inside them depends on how the job was set up. Until
   * work-offset probing exists, we assume work zero is placed such that these
   * ranges are reachable, which is what a user setting up on a fixed fixture
   * would arrange anyway. Z ranges therefore include headroom above the stock
   * top for clearance moves.
   */
  readonly travels: {
    readonly x: Range<Mm>;
    readonly y: Range<Mm>;
    readonly z: Range<Mm>;
  };

  readonly rapidRate: MmPerMin;
  readonly maxFeed: MmPerMin;
  /** Axis acceleration, for a future trapezoidal time model. Unused in v1. */
  readonly accel?: number;

  readonly spindle: {
    readonly range: Range<Rpm>;
    readonly directions: readonly SpindleDirection[];
  };

  readonly interpolation: InterpolationCaps;

  /**
   * "coordinated": a rapid follows a straight line, so XY+Z can be combined.
   * "axis-independent": axes may move at different rates, so the path between
   * endpoints is not guaranteed — traverses must be decomposed into
   * retract / move / descend.
   */
  readonly rapidSemantics: "coordinated" | "axis-independent";

  readonly toolChange: "manual" | "automatic";
  readonly coordinateSystems: readonly string[];
  readonly probe: ProbeCaps;

  readonly dialect: DialectId;

  /** G and M codes the controller understands. Used to flag unknown words. */
  readonly supportedG: ReadonlySet<number>;
  readonly supportedM: ReadonlySet<number>;
}

/** Codes common to essentially every RS-274 controller. */
const BASE_G = new Set([
  0, 1, 2, 3, 4, 17, 18, 19, 20, 21, 28, 30, 40, 41, 42, 43, 49, 53,
  54, 55, 56, 57, 58, 59, 80, 90, 91, 92, 93, 94,
]);
const BASE_M = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 30]);

/**
 * XYZ-3018 style hobby router. Numbers from the IDE prototype's MACHINE record.
 */
export const xyz3018: MachineProfile = {
  id: "xyz-3018",
  name: "XYZ-3018 · 3-axis",
  axes: ["X", "Y", "Z"],
  travels: {
    x: range(mm(-5), mm(300)),
    y: range(mm(-5), mm(180)),
    z: range(mm(-80), mm(40)),
  },
  rapidRate: mmPerMin(3000),
  maxFeed: mmPerMin(3000),
  spindle: { range: range(rpm(3000), rpm(24000)), directions: ["cw", "ccw"] },
  interpolation: { linear: true, arcXY: true, arcXZ: true, arcYZ: true, helical: false },
  rapidSemantics: "axis-independent",
  toolChange: "manual",
  coordinateSystems: ["G54"],
  probe: null,
  dialect: "rs274",
  supportedG: BASE_G,
  supportedM: BASE_M,
};

/**
 * Makera Z1 desktop CNC.
 *
 * Travel and RPM from the checker prototype's Z1 constant. The arc capabilities
 * and program-end code come from inspecting a real Makera Studio export
 * (original/MakeraBadge.nc): 17,439 G1 blocks, ZERO G2/G3, and M02 rather than
 * M30. Makera Studio linearizes everything, so a Makera-targeted compile must
 * linearize fitted arcs back out.
 */
export const makeraZ1: MachineProfile = {
  id: "makera-z1",
  name: "MAKERA Z1",
  axes: ["X", "Y", "Z"],
  travels: {
    x: range(mm(0), mm(200)),
    y: range(mm(0), mm(200)),
    // 100 mm of Z travel, with the stock top at work zero and headroom above it.
    z: range(mm(-80), mm(20)),
  },
  rapidRate: mmPerMin(3000),
  maxFeed: mmPerMin(3000),
  spindle: { range: range(rpm(0), rpm(13000)), directions: ["cw"] },
  // Observed: the exporter emits no arcs at all. Modelled as "cannot".
  interpolation: { linear: true, arcXY: false, arcXZ: false, arcYZ: false, helical: false },
  rapidSemantics: "axis-independent",
  toolChange: "manual",
  coordinateSystems: ["G54"],
  probe: null,
  dialect: "makera",
  supportedG: new Set([0, 1, 2, 3, 4, 10, 17, 18, 19, 20, 21, 28, 30, 43, 49, 53,
    54, 55, 56, 57, 58, 59, 90, 91, 92, 94]),
  supportedM: new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 30, 321, 322, 323, 324, 325,
    331, 490, 495]),
};

/** LinuxCNC: the permissive reference target — arcs in every plane, G38 probing. */
export const linuxcnc: MachineProfile = {
  id: "linuxcnc",
  name: "LinuxCNC generic 3-axis",
  axes: ["X", "Y", "Z"],
  travels: {
    x: range(mm(-500), mm(500)),
    y: range(mm(-500), mm(500)),
    z: range(mm(-300), mm(100)),
  },
  rapidRate: mmPerMin(6000),
  maxFeed: mmPerMin(6000),
  spindle: { range: range(rpm(100), rpm(30000)), directions: ["cw", "ccw"] },
  interpolation: { linear: true, arcXY: true, arcXZ: true, arcYZ: true, helical: true },
  rapidSemantics: "coordinated",
  toolChange: "manual",
  coordinateSystems: ["G54", "G55", "G56", "G57", "G58", "G59"],
  probe: { kind: "g38" },
  dialect: "linuxcnc",
  supportedG: BASE_G,
  supportedM: BASE_M,
};

const REGISTRY = new Map<string, MachineProfile>([
  [xyz3018.id, xyz3018],
  [makeraZ1.id, makeraZ1],
  [linuxcnc.id, linuxcnc],
]);

export const machineIds = (): string[] => [...REGISTRY.keys()];

export function getMachine(id: string): MachineProfile {
  const m = REGISTRY.get(id);
  if (!m) throw new Error(`unknown machine profile "${id}" (have: ${machineIds().join(", ")})`);
  return m;
}

export function registerMachine(p: MachineProfile): void {
  REGISTRY.set(p.id, p);
}

/** Can this machine interpolate an arc in the given plane? */
export function supportsArcPlane(m: MachineProfile, plane: "XY" | "XZ" | "YZ"): boolean {
  return plane === "XY" ? m.interpolation.arcXY
    : plane === "XZ" ? m.interpolation.arcXZ
    : m.interpolation.arcYZ;
}
