/**
 * Strategy dispatch: map an Operation to the strategy that implements it.
 *
 * This lives in @cam/strategies (not @cam/planner) so the dependency runs one
 * way: strategies know about the planner's context type, the planner does not
 * know which strategies exist. Adding a strategy is a change here and nowhere
 * else.
 */

import type { Operation, PlanningContext, ToolpathSet } from "@cam/planner";
import { planConstantScallop } from "./constant-scallop.js";
import { planHybridWaterline } from "./hybrid-waterline.js";
import { planFace, planDrill, planRectPocket } from "./pocket.js";
import { planRaster } from "./raster.js";
import { planZLevelRough } from "./zlevel-rough.js";

export function dispatchStrategy(ctx: PlanningContext, op: Operation): ToolpathSet {
  switch (op.kind) {
    case "rough-surface":
      return planZLevelRough(ctx, {
        stepdown: op.stepdown,
        stepover: op.stepover,
        stockToLeave: op.stockToLeave,
      });

    case "finish-surface": {
      const s = op.strategy;
      switch (s.kind) {
        case "raster":
          return planRaster(ctx, {
            direction: s.direction,
            scallop: s.scallop,
            stepover: s.stepover,
            chordTolerance: op.chordTolerance,
          });
        case "hybrid-waterline":
          return planHybridWaterline(ctx, {
            scallop: s.scallop,
            steepAngle: s.steepAngle,
            direction: "X",
            chordTolerance: op.chordTolerance,
          });
        case "constant-scallop":
          return planConstantScallop(ctx, {
            scallop: s.scallop,
            chordTolerance: op.chordTolerance,
          });
        default:
          throw new Error(`strategy "${(s as { kind: string }).kind}" is not a finishing strategy`);
      }
    }

    case "face":
      return planFace(ctx, { area: op.area, z: op.z, stepover: op.stepover });

    case "pocket":
      return planRectPocket(ctx, {
        area: op.area, depth: op.depth, stepdown: op.stepdown, stepover: op.stepover,
      });

    case "drill":
      return planDrill(ctx, { points: op.points, depth: op.depth, peck: op.peck });
  }
}
