/**
 * Conformance against a real Makera Studio export.
 *
 * `original/MakeraBadge.nc` is 18,531 lines of genuine controller-bound G-code.
 * It exercises things synthetic fixtures never do: a structured `;@MKR|` comment
 * header, a base64 PNG thumbnail appended as comment lines, both `M5` and `M05`
 * spellings, `M02` rather than `M30`, and complete linearization (no arcs at
 * all). It also serves as the performance floor for parsing.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { makeraZ1 } from "@cam/machine";
import { parseGcode } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../../../original/MakeraBadge.nc");

const source = readFileSync(FIXTURE, "utf8");
const parsed = parseGcode(source, {
  rapidRate: makeraZ1.rapidRate,
  supportedG: makeraZ1.supportedG,
  supportedM: makeraZ1.supportedM,
});

describe("MakeraBadge.nc", () => {
  it("has the expected size", () => {
    // `wc -l` says 18531 (it counts newlines); splitting a file with a trailing
    // newline yields one extra empty element. Both are correct; this is ours.
    expect(parsed.lineCount).toBe(18532);
  });

  it("is fully linearized — no arcs anywhere", () => {
    expect(parsed.codesUsed.g.has(2)).toBe(false);
    expect(parsed.codesUsed.g.has(3)).toBe(false);
    expect(parsed.segments.every((s) => s.points === null)).toBe(true);
  });

  it("uses only G0/G1 motion, plus G90/G21/G28", () => {
    expect(parsed.codesUsed.g.has(0)).toBe(true);
    expect(parsed.codesUsed.g.has(1)).toBe(true);
    expect(parsed.codesUsed.g.has(90)).toBe(true);
    expect(parsed.codesUsed.g.has(21)).toBe(true);
    expect(parsed.codesUsed.g.has(28)).toBe(true);
  });

  it("ends with M02 rather than M30, and uses both M5 and M05 spellings", () => {
    expect(parsed.codesUsed.m.has(2)).toBe(true);
    expect(parsed.codesUsed.m.has(30)).toBe(false);
    // M5 and M05 both parse to the numeric code 5 — the point is that they parse.
    expect(parsed.codesUsed.m.has(5)).toBe(true);
    expect(/^M05\s*$/m.test(source)).toBe(true);
    expect(/^M5\s*$/m.test(source)).toBe(true);
  });

  it("produces the expected motion census", () => {
    const cuts = parsed.segments.filter((s) => s.kind === "cut").length;
    const rapids = parsed.segments.filter((s) => s.kind === "rapid").length;
    // Slightly below the raw G1/G0 word counts because zero-length repeats and
    // coordinate-free blocks do not become segments.
    expect(cuts).toBeGreaterThan(17_000);
    expect(rapids).toBeGreaterThan(700);
    expect(cuts + rapids).toBeLessThanOrEqual(18_231);
  });

  it("finds two tools and two tool changes", () => {
    expect(parsed.toolsUsed).toEqual([1, 2]);
    expect(parsed.toolChanges.length).toBeGreaterThanOrEqual(2);
  });

  it("harvests the structured ;@MKR| header", () => {
    const byKey = new Map(parsed.headers.map((h) => [h.key, h]));

    expect(byKey.get("MACHINE")?.fields).toMatchObject({ id: "Z1", name: "Makera Z1" });
    expect(byKey.get("UNIT")?.fields.value).toBe("mm");
    expect(byKey.get("STOCK")?.fields).toMatchObject({
      id: "cuboid", length: "100", width: "100", height: "1.3",
    });
    expect(byKey.get("ORIGIN")?.fields).toMatchObject({ type_name: "topFrontLeft" });
    expect(byKey.get("TIME")?.fields.seconds).toBe("1800");

    // Two tools in the table, with full cutter geometry.
    const tools = parsed.headers.filter((h) => h.key === "TOOL");
    expect(tools).toHaveLength(2);
    expect(tools[0].fields).toMatchObject({ number: "1", type: "Flat End", diameter: "3.175" });
    expect(tools[1].fields).toMatchObject({ number: "2", type: "Engraving", tipdiameter: "0.3" });

    // Three named toolpaths in the manifest.
    expect(parsed.headers.filter((h) => h.key === "TOOLPATH")).toHaveLength(3);
    // Plus per-operation markers in the body.
    expect(parsed.headers.filter((h) => h.key === "TOOLPATH_START").length).toBeGreaterThan(0);
  });

  it("reconstructs stock dimensions that match the header", () => {
    const stock = parsed.headers.find((h) => h.key === "STOCK")!;
    const w = Number(stock.fields.length);
    const d = Number(stock.fields.width);
    expect(parsed.bounds.maxX - parsed.bounds.minX).toBeLessThanOrEqual(w);
    expect(parsed.bounds.maxY - parsed.bounds.minY).toBeLessThanOrEqual(d);
  });

  it("raises no unsupported-code diagnostics against the Makera profile", () => {
    const unknown = parsed.diagnostics.filter((d) => d.code === "dialect.unknownCode"
      && d.severity === "warning");
    expect(unknown).toHaveLength(0);
  });

  it("estimates a plausible run time", () => {
    // The header claims 1800 s. Our naive length/feed model ignores accel, so it
    // will differ — but it should be the same order of magnitude, not 10x off.
    expect(parsed.totalSeconds).toBeGreaterThan(300);
    expect(parsed.totalSeconds).toBeLessThan(10_000);
  });

  it("parses within the performance budget", () => {
    // Best-of-N, not a single sample: vitest runs files in parallel workers, so
    // a lone measurement mostly reports scheduler contention. Best-of-5 is a
    // stable lower bound on the real cost.
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      parseGcode(source, { rapidRate: makeraZ1.rapidRate });
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(200);
  });
});
