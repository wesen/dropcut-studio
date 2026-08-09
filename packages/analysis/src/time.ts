/**
 * @cam/analysis/time — run-time estimation.
 *
 * Deliberately naive: length / feed, summed. Real controllers accelerate and
 * decelerate, so a path made of many short segments takes considerably longer
 * than this predicts — finishing passes can be off by 2x.
 *
 * That limitation is documented rather than hidden, and `MachineProfile.accel`
 * exists so a trapezoidal model can be added later without a schema change.
 * Reporting a confident wrong number would be worse than reporting an honest
 * approximate one.
 */

import type { Seconds } from "@cam/units";
import { seconds } from "@cam/units";

export interface TimedMove {
  readonly kind: "rapid" | "cut";
  readonly length: number;
  readonly feed: number;
}

export interface TimeEstimate {
  readonly total: Seconds;
  readonly cutting: Seconds;
  readonly rapid: Seconds;
  readonly cutLength: number;
  readonly rapidLength: number;
  /** How the estimate was produced, so the UI can qualify it. */
  readonly model: "length-over-feed";
}

export function estimateTime(moves: readonly TimedMove[], rapidRate: number): TimeEstimate {
  let cutting = 0;
  let rapid = 0;
  let cutLength = 0;
  let rapidLength = 0;

  for (const m of moves) {
    const rate = m.kind === "rapid" ? rapidRate : m.feed;
    const t = (m.length / Math.max(rate, 1e-6)) * 60;
    if (m.kind === "rapid") { rapid += t; rapidLength += m.length; }
    else { cutting += t; cutLength += m.length; }
  }

  return {
    total: seconds(cutting + rapid),
    cutting: seconds(cutting),
    rapid: seconds(rapid),
    cutLength,
    rapidLength,
    model: "length-over-feed",
  };
}

export function formatDuration(s: number): string {
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}
