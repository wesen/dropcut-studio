/**
 * The scripting surface: what a user can express, what is rejected, and what the
 * sandbox refuses to hand over.
 */

import { describe, expect, it } from "vitest";
import { EXAMPLES } from "./examples.js";
import { DENIED_GLOBALS, locateInScript, runScript } from "./sandbox.js";

const ok = (src: string) => {
  const r = runScript(src);
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join("; "));
  return r;
};

describe("DSL surface", () => {
  it("builds a 2.5D plan from a script", () => {
    const r = ok(`
      const T = tools.flatEndMill({ name: "4mm", diameter: mm(4) });
      job.setup({ stock: { x: mm(60), y: mm(40), z: mm(12) }, clearance: mm(6) });
      job.withTool(T, () => {
        job.withSpindle({ speed: rpm(12000) }, () => {
          job.face({ x: mm(0), y: mm(0), w: mm(60), h: mm(40), z: mm(-0.5),
                     stepover: 0.6, feed: mmPerMin(900) });
          job.rectPocket({ x: mm(10), y: mm(10), w: mm(30), h: mm(20),
                           depth: mm(6), stepdown: mm(2), feed: mmPerMin(600) });
        });
      });
    `);

    expect(r.plan.operations).toHaveLength(2);
    expect(r.plan.operations[0].kind).toBe("face");
    expect(r.plan.operations[1].kind).toBe("pocket");
    expect(Object.keys(r.plan.tools)).toHaveLength(1);
    // The spindle scope propagated onto both operations.
    expect(r.plan.operations.every((o) => o.spindleSpeed === 12000)).toBe(true);
  });

  it("assigns stable, readable operation ids", () => {
    const r = ok(`
      const T = tools.flatEndMill({ diameter: mm(4) });
      job.setup({ stock: { x: mm(60), y: mm(40), z: mm(12) } });
      job.toolChange(T);
      job.face({ x: mm(0), y: mm(0), w: mm(10), h: mm(10), z: mm(-1), feed: mmPerMin(500) });
      job.face({ x: mm(0), y: mm(0), w: mm(10), h: mm(10), z: mm(-2), feed: mmPerMin(500) });
    `);
    expect(r.plan.operations.map((o) => o.id)).toEqual(["face#1", "face#2"]);
  });

  it("supports the 3D surfacing operations", () => {
    const r = ok(`
      const T = tools.ballEndMill({ diameter: mm(3) });
      job.setup({ stock: { x: mm(36), y: mm(36), z: mm(16), topZ: mm(15) }, floorZ: mm(0) });
      geometry.mesh("dome");
      job.withTool(T, () => {
        job.roughSurface({ stepdown: mm(2), stockToLeave: mm(0.3), feed: mmPerMin(1200) });
        job.finishSurface({
          strategy: strategy.constantScallop({ scallop: mm(0.02) }),
          feed: mmPerMin(800),
        });
      });
    `);
    expect(r.plan.operations.map((o) => o.kind)).toEqual(["rough-surface", "finish-surface"]);
    expect(r.meshName).toBe("dome");
  });

  it("converts inches to millimetres on construction", () => {
    const r = ok(`
      const T = tools.flatEndMill({ diameter: inch(0.25) });
      job.setup({ stock: { x: mm(60), y: mm(40), z: mm(12) } });
      job.toolChange(T);
      job.face({ x: mm(0), y: mm(0), w: mm(10), h: mm(10), z: mm(-1), feed: mmPerMin(500) });
    `);
    const tool = Object.values(r.plan.tools)[0];
    expect(tool.geometry.diameter).toBeCloseTo(6.35, 9);
  });

  it("runs the shipped examples", () => {
    for (const example of EXAMPLES) {
      const r = runScript(example.source, { meshNames: ["dome"] });
      expect(r.ok, `${example.name}: ${r.ok ? "" : r.diagnostics.map((d) => d.message).join("; ")}`)
        .toBe(true);
      if (r.ok) expect(r.plan.operations.length).toBeGreaterThan(0);
    }
  });
});

describe("scope combinators", () => {
  it("withTool restores the previous tool afterwards", () => {
    const r = ok(`
      const A = tools.flatEndMill({ diameter: mm(4) });
      const B = tools.ballEndMill({ diameter: mm(3) });
      job.setup({ stock: { x: mm(60), y: mm(40), z: mm(12) } });
      job.toolChange(A);
      job.withTool(B, () => {
        job.face({ x: mm(0), y: mm(0), w: mm(10), h: mm(10), z: mm(-1), feed: mmPerMin(500) });
      });
      job.face({ x: mm(0), y: mm(0), w: mm(10), h: mm(10), z: mm(-2), feed: mmPerMin(500) });
    `);
    // Inner op used B, outer op fell back to A.
    expect(r.plan.operations[0].toolId).not.toBe(r.plan.operations[1].toolId);
  });

  it("withSpindle restores the previous speed, even if the body throws", () => {
    const r = runScript(`
      const T = tools.flatEndMill({ diameter: mm(4) });
      job.setup({ stock: { x: mm(60), y: mm(40), z: mm(12) } });
      job.toolChange(T);
      try {
        job.withSpindle({ speed: rpm(20000) }, () => { throw new Error("boom"); });
      } catch (e) { /* swallowed by the script itself */ }
      job.withSpindle({ speed: rpm(9000) }, () => {
        job.face({ x: mm(0), y: mm(0), w: mm(10), h: mm(10), z: mm(-1), feed: mmPerMin(500) });
      });
    `);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.operations[0].spindleSpeed).toBe(9000);
  });
});

describe("branded units", () => {
  it("accepts a bare number but warns", () => {
    const r = ok(`
      const T = tools.flatEndMill({ diameter: 4 });
      job.setup({ stock: { x: mm(60), y: mm(40), z: mm(12) } });
      job.toolChange(T);
      job.face({ x: mm(0), y: mm(0), w: mm(10), h: mm(10), z: mm(-1), feed: mmPerMin(500) });
    `);
    const warn = r.diagnostics.find((d) => d.code === "units.bareNumber");
    expect(warn).toBeDefined();
    expect(warn!.severity).toBe("warning");
    expect(warn!.message).toMatch(/tools\.flatEndMill diameter/);
    // ...and it still compiled, which is the point.
    expect(Object.values(r.plan.tools)[0].geometry.diameter).toBe(4);
  });

  it("rejects the WRONG brand outright", () => {
    const r = runScript(`
      const T = tools.flatEndMill({ diameter: rpm(4) });
    `);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => /expected mm, got rpm/.test(d.message))).toBe(true);
  });

  it("rejects a non-finite number", () => {
    const r = runScript(`tools.flatEndMill({ diameter: 1 / 0 });`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => /not a finite number/.test(d.message))).toBe(true);
  });
});

describe("error reporting", () => {
  it("reports a missing tool with an actionable message", () => {
    const r = runScript(`
      job.setup({ stock: { x: mm(60), y: mm(40), z: mm(12) } });
      job.face({ x: mm(0), y: mm(0), w: mm(10), h: mm(10), z: mm(-1), feed: mmPerMin(500) });
    `);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => /no tool selected/.test(d.message))).toBe(true);
  });

  it("reports a syntax error rather than throwing", () => {
    const r = runScript(`job.setup({{{`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0].code).toBe("script.error");
    expect(r.diagnostics[0].message).toMatch(/syntax error/);
  });

  it("reports an empty program as an error, not a silent success", () => {
    const r = runScript(`const x = 1;`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => /no operations/.test(d.message))).toBe(true);
  });

  it("locates a runtime error on the user's line", () => {
    // The throw is on line 3 of the source (1-indexed, counting the leading \n
    // as line 1 being empty).
    const src = "const T = tools.flatEndMill({ diameter: mm(4) });\n" +
                "job.setup({ stock: { x: mm(60), y: mm(40), z: mm(12) } });\n" +
                "throw new Error('deliberate');\n";
    const r = runScript(src);
    expect(r.ok).toBe(false);
    const diag = r.diagnostics.find((d) => d.message === "deliberate");
    expect(diag).toBeDefined();
    expect(diag!.provenance?.script?.line).toBe(3);
  });

  it("keeps warnings emitted before a failure", () => {
    const r = runScript(`
      const T = tools.flatEndMill({ diameter: 4 });
      throw new Error("later");
    `);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.code === "units.bareNumber")).toBe(true);
    expect(r.diagnostics.some((d) => d.message === "later")).toBe(true);
  });

  it("rejects an unknown mesh by name", () => {
    const r = runScript(`geometry.mesh("nope");`, { meshNames: ["dome"] });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => /no such mesh/.test(d.message))).toBe(true);
  });
});

describe("sandbox isolation", () => {
  it("does not expose network or storage globals", () => {
    for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "localStorage", "indexedDB"]) {
      const r = runScript(`
        const T = tools.flatEndMill({ diameter: mm(4) });
        job.setup({ stock: { x: mm(10), y: mm(10), z: mm(5) } });
        job.toolChange(T);
        if (typeof ${name} !== "undefined") throw new Error("${name} is reachable");
        job.face({ x: mm(0), y: mm(0), w: mm(5), h: mm(5), z: mm(-1), feed: mmPerMin(300) });
      `);
      expect(r.ok, `${name} should not be reachable`).toBe(true);
    }
  });

  it("shadows process and require, so Node APIs are not reachable", () => {
    const r = runScript(`
      const T = tools.flatEndMill({ diameter: mm(4) });
      job.setup({ stock: { x: mm(10), y: mm(10), z: mm(5) } });
      job.toolChange(T);
      if (typeof process !== "undefined") throw new Error("process is reachable");
      if (typeof require !== "undefined") throw new Error("require is reachable");
      job.face({ x: mm(0), y: mm(0), w: mm(5), h: mm(5), z: mm(-1), feed: mmPerMin(300) });
    `);
    expect(r.ok).toBe(true);
  });

  it("lists what it denies, so the limitation is inspectable", () => {
    expect(DENIED_GLOBALS).toContain("fetch");
    expect(DENIED_GLOBALS).toContain("process");
  });

  it("keeps two runs completely independent", () => {
    const src = `
      const T = tools.flatEndMill({ diameter: mm(4) });
      job.setup({ stock: { x: mm(10), y: mm(10), z: mm(5) } });
      job.toolChange(T);
      job.face({ x: mm(0), y: mm(0), w: mm(5), h: mm(5), z: mm(-1), feed: mmPerMin(300) });
    `;
    const a = ok(src);
    const b = ok(src);
    expect(a.plan.operations).toHaveLength(1);
    expect(b.plan.operations).toHaveLength(1);
    expect(Object.keys(a.plan.tools)).toEqual(Object.keys(b.plan.tools));
  });
});

describe("locateInScript", () => {
  it("returns undefined for a non-Error", () => {
    expect(locateInScript("not an error")).toBeUndefined();
  });

  it("returns undefined for an error with no script frame", () => {
    expect(locateInScript(new Error("elsewhere"))).toBeUndefined();
  });
});
