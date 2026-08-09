/**
 * The whole system, from a user's script to G-code on disk.
 *
 * If these pass, someone can write JavaScript and get a validated, simulated,
 * machine-specific program out — which is the entire point of the project.
 */

import { describe, expect, it } from "vitest";
import { formatCertificate } from "@cam/analysis";
import { parseGcode } from "@cam/gcode-parser";
import { getMachine } from "@cam/machine";
import { EXAMPLES, exampleByName } from "@cam/script-host";
import { compileScript } from "./compile.js";

const POCKET = exampleByName("pocket-and-face")!.source;
const SURFACE = exampleByName("surface-finish")!.source;

describe("script to G-code", () => {
  it("compiles the 2.5D example", () => {
    const r = compileScript(POCKET, { machineId: "linuxcnc" });
    expect(r.ok, r.ok ? "" : r.diagnostics.map((d) => d.message).join("; ")).toBe(true);
    if (!r.ok) return;

    expect(r.emitted.document.text).toContain("G21");
    expect(r.emitted.document.text).toContain("M30");
    expect(r.summaries.map((s) => s.operationId)).toEqual(["face#1", "pocket#1"]);
    expect(r.time.total).toBeGreaterThan(0);
  });

  it("compiles the 3D surfacing example, rough then finish", () => {
    const r = compileScript(SURFACE, { machineId: "linuxcnc", simulationResolution: 90 });
    expect(r.ok, r.ok ? "" : r.diagnostics.map((d) => d.message).join("; ")).toBe(true);
    if (!r.ok) return;

    expect(r.summaries).toHaveLength(2);
    expect(r.summaries[0].description).toMatch(/z-level rough/);
    expect(r.summaries[1].description).toMatch(/constant scallop/);

    // Two tools means at least two tool changes in the output.
    const toolChanges = r.emitted.document.text.split("\n").filter((l) => l.includes("M6"));
    expect(toolChanges.length).toBeGreaterThanOrEqual(2);
  });

  it("emits G-code that parses back without errors", () => {
    const r = compileScript(POCKET, { machineId: "linuxcnc" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const machine = getMachine("linuxcnc");
    const parsed = parseGcode(r.emitted.document.text, {
      rapidRate: machine.rapidRate,
      supportedG: machine.supportedG,
      supportedM: machine.supportedM,
    });
    expect(parsed.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(parsed.segments.length).toBeGreaterThan(50);
  });

  it("all shipped examples compile on every machine", () => {
    for (const example of EXAMPLES) {
      for (const machineId of ["linuxcnc", "xyz-3018", "makera-z1"]) {
        const r = compileScript(example.source, {
          machineId,
          skipSimulation: true, // keep the matrix fast; simulation covered elsewhere
        });
        expect(
          r.ok,
          `${example.name} on ${machineId}: ${r.ok ? "" : r.diagnostics.map((d) => d.message).join("; ")}`,
        ).toBe(true);
      }
    }
  });
});

describe("machine differences show up in the output", () => {
  it("Makera gets a structured header and M02; LinuxCNC does not", () => {
    const makera = compileScript(POCKET, { machineId: "makera-z1", skipSimulation: true });
    const linux = compileScript(POCKET, { machineId: "linuxcnc", skipSimulation: true });
    expect(makera.ok && linux.ok).toBe(true);
    if (!makera.ok || !linux.ok) return;

    expect(makera.emitted.document.text).toContain(";@MKR|BEGIN");
    expect(makera.emitted.document.text).toContain("M02");
    expect(linux.emitted.document.text).not.toContain(";@MKR|");
    expect(linux.emitted.document.text).toContain("M30");
  });

  it("the Makera header carries the REAL tool geometry from the script", () => {
    // Regression guard: an earlier draft synthesised a placeholder 3mm flat
    // here, which is the same class of bug as defect D1.
    const src = `
      const T = tools.ballEndMill({ name: "5mm ball", diameter: mm(5) });
      job.setup({ stock: { x: mm(50), y: mm(50), z: mm(10) }, clearance: mm(5) });
      job.withTool(T, () => {
        job.withSpindle({ speed: rpm(10000) }, () => {
          job.rectPocket({ x: mm(10), y: mm(10), w: mm(30), h: mm(30),
                           depth: mm(3), stepdown: mm(1.5), feed: mmPerMin(600) });
        });
      });
    `;
    const r = compileScript(src, { machineId: "makera-z1", skipSimulation: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.emitted.document.text).toMatch(/;@MKR\|TOOL\|.*name=5mm ball.*diameter=5/);
    expect(r.emitted.document.text).not.toMatch(/diameter=3\b/);
  });
});

describe("the certificate reflects what actually ran", () => {
  it("reports sampled checks when simulation runs", () => {
    const r = compileScript(POCKET, { machineId: "linuxcnc", simulationResolution: 120 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.program.certificate.gouge.kind).toBe("verified-to-resolution");
    expect(formatCertificate(r.program.certificate)).toMatch(/PASS\s+gouge/);
  });

  it("reports not-checked when simulation is skipped", () => {
    const r = compileScript(POCKET, { machineId: "linuxcnc", skipSimulation: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.program.certificate.gouge.kind).toBe("not-checked");
    expect(formatCertificate(r.program.certificate)).toMatch(/SKIP\s+gouge/);
  });
});

describe("failure modes are reported, not thrown", () => {
  it("a script error stops at the script stage", () => {
    const r = compileScript(`job.face({});`, { machineId: "linuxcnc" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.stage).toBe("script");
    expect(r.diagnostics.some((d) => d.code === "script.error")).toBe(true);
  });

  it("a program outside machine travel stops at validation", () => {
    const src = `
      const T = tools.flatEndMill({ diameter: mm(4) });
      job.setup({ stock: { x: mm(400), y: mm(400), z: mm(10) }, clearance: mm(5) });
      job.withTool(T, () => {
        job.withSpindle({ speed: rpm(10000) }, () => {
          job.face({ x: mm(0), y: mm(0), w: mm(400), h: mm(400), z: mm(-1),
                     feed: mmPerMin(800) });
        });
      });
    `;
    // The Makera envelope is only 200 x 200.
    const r = compileScript(src, { machineId: "makera-z1" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.stage).toBe("validate");
    expect(r.diagnostics.some((d) => d.code === "travel.exceeded")).toBe(true);
  });

  it("a spindle speed the machine cannot reach stops at validation", () => {
    const src = `
      const T = tools.flatEndMill({ diameter: mm(4) });
      job.setup({ stock: { x: mm(50), y: mm(50), z: mm(10) }, clearance: mm(5) });
      job.withTool(T, () => {
        job.withSpindle({ speed: rpm(40000) }, () => {
          job.face({ x: mm(5), y: mm(5), w: mm(20), h: mm(20), z: mm(-1),
                     feed: mmPerMin(800) });
        });
      });
    `;
    const r = compileScript(src, { machineId: "makera-z1" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.some((d) => d.code === "spindle.outOfRange")).toBe(true);
  });

  it("surfaces unit warnings on an otherwise successful compile", () => {
    const src = `
      const T = tools.flatEndMill({ diameter: 4 });
      job.setup({ stock: { x: mm(50), y: mm(50), z: mm(10) }, clearance: mm(5) });
      job.withTool(T, () => {
        job.withSpindle({ speed: rpm(10000) }, () => {
          job.face({ x: mm(5), y: mm(5), w: mm(20), h: mm(20), z: mm(-1),
                     feed: mmPerMin(800) });
        });
      });
    `;
    const r = compileScript(src, { machineId: "linuxcnc", skipSimulation: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diagnostics.some((d) => d.code === "units.bareNumber")).toBe(true);
  });
});
