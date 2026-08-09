/**
 * @cam/analysis/checks — sampled safety checks over an emitted program.
 *
 * These run on the MOTION TIMELINE (after emission) rather than on canonical
 * commands, because that is where the real geometry lives: a traverse has been
 * decomposed into its actual moves, and arcs have been resolved. The exact
 * checks — travel, spindle range, interlocks — happen earlier in
 * @cam/compiler/validate; these are the ones that need simulation.
 *
 * Design doc: Part X.4.
 */

import { mm } from "@cam/units";
import type { Diagnostic } from "@cam/ir";
import { error, warning } from "@cam/ir";
import type { ToolGeometry } from "@cam/machine";
import type { StockDefinition } from "./dexel.js";
import { DexelSim } from "./dexel.js";

export interface CheckMove {
  readonly kind: "rapid" | "cut";
  readonly from: { x: number; y: number; z: number };
  readonly to: { x: number; y: number; z: number };
  readonly tool: ToolGeometry;
  readonly gcodeLine: number;
}

export interface CheckOptions {
  readonly stock: StockDefinition;
  /** Height below which a rapid with XY motion is considered risky. */
  readonly safeZ: number;
  /** Grid resolution for the crash simulation. Coarser than display. */
  readonly resolution?: number;
}

export interface CheckResult {
  readonly diagnostics: readonly Diagnostic[];
  /** Deepest material a rapid ploughed through, in mm. Zero if none did. */
  readonly worstRapidCrash: number;
  /** Deepest penetration below the stock bottom. */
  readonly worstSpoilboard: number;
  readonly resolution: number;
}

/**
 * Run the sampled checks.
 *
 * A single simulation pass serves both the rapid-crash detection and the
 * spoilboard check. The prototype ran a SECOND independent simulation at a
 * different resolution purely for crash detection, which was wasted work and
 * could in principle disagree with the display simulation.
 */
export function runSampledChecks(
  moves: readonly CheckMove[],
  opts: CheckOptions,
): CheckResult {
  const diagnostics: Diagnostic[] = [];
  const resolution = opts.resolution ?? 150;
  const sim = new DexelSim(opts.stock, { resolution });
  const bottom = opts.stock.topZ - opts.stock.height;

  const rapidHits = new Map<number, number>();
  const spoilboardHits = new Map<number, number>();
  const belowSafeZ = new Set<number>();

  let worstRapidCrash = 0;
  let worstSpoilboard = 0;

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];

    // Rapid travelling in XY below the safe height is a warning even if it
    // happens to miss material this time — it is one fixture away from a crash.
    if (m.kind === "rapid") {
      const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y);
      const lowZ = Math.min(m.from.z, m.to.z);
      if (xy > 0.01 && lowZ < opts.safeZ && !belowSafeZ.has(m.gcodeLine)) {
        belowSafeZ.add(m.gcodeLine);
        diagnostics.push(warning("rapid.belowSafeZ",
          `rapid moves in XY at Z=${lowZ.toFixed(2)}, below the ${opts.safeZ.toFixed(1)} mm ` +
          "safe height",
          { gcodeLine: m.gcodeLine, detail: { z: lowZ } }));
      }
    }

    // Penetration below the stock bottom: cutting into the spoilboard.
    const minZ = Math.min(m.from.z, m.to.z);
    if (minZ < bottom - 1e-6) {
      const depth = bottom - minZ;
      if (depth > (spoilboardHits.get(m.gcodeLine) ?? 0)) {
        spoilboardHits.set(m.gcodeLine, depth);
      }
      if (depth > worstSpoilboard) worstSpoilboard = depth;
    }

    const removed = sim.sweep({ ...m, index: i });
    if (m.kind === "rapid" && removed > 0.02) {
      if (removed > (rapidHits.get(m.gcodeLine) ?? 0)) rapidHits.set(m.gcodeLine, removed);
      if (removed > worstRapidCrash) worstRapidCrash = removed;
    }
  }

  for (const [line, depth] of rapidHits) {
    diagnostics.push(error("rapid.throughStock",
      `rapid move cuts through stock — up to ${depth.toFixed(2)} mm of material in its path`,
      { gcodeLine: line, detail: { depth } }));
  }

  for (const [line, depth] of spoilboardHits) {
    diagnostics.push(warning("stock.spoilboard",
      `tool reaches ${depth.toFixed(2)} mm below the stock bottom — cutting into the spoilboard`,
      { gcodeLine: line, detail: { depth } }));
  }

  return {
    diagnostics,
    worstRapidCrash,
    worstSpoilboard,
    resolution: Math.max(sim.cellW, sim.cellD),
  };
}

/** Spatial resolution of a check run, for the certificate's honesty. */
export const checkResolution = (r: CheckResult) => mm(r.resolution);
