/** CLI smoke test: the commands run and produce output on real input. */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exampleByName } from "@cam/script-host";
import { main } from "./main.js";

const dir = mkdtempSync(join(tmpdir(), "dropcut-"));

describe("cli", () => {
  it("lists machines and examples", () => {
    expect(main(["machines"])).toBe(0);
    expect(main(["examples"])).toBe(0);
  });

  it("writes an example to disk", () => {
    const out = join(dir, "prog.js");
    expect(main(["example", "pocket-and-face", "-o", out])).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("job.rectPocket");
  });

  it("compiles a script to a .nc file", () => {
    const src = join(dir, "prog.js");
    const out = join(dir, "prog.nc");
    writeFileSync(src, exampleByName("pocket-and-face")!.source, "utf8");
    expect(main(["compile", src, "-m", "linuxcnc", "-o", out, "-q"])).toBe(0);
    const nc = readFileSync(out, "utf8");
    expect(nc).toContain("G21");
    expect(nc).toContain("M30");
    expect(nc.split("\n").length).toBeGreaterThan(50);
  });

  it("checks a .nc file it just produced", () => {
    const nc = join(dir, "prog.nc");
    expect(main(["check", nc, "-m", "linuxcnc"])).toBe(0);
  });

  it("reports a bad script with a non-zero exit code", () => {
    const bad = join(dir, "bad.js");
    writeFileSync(bad, "job.face({});", "utf8");
    expect(main(["compile", bad, "-q"])).toBe(1);
  });

  it("reports a missing file rather than throwing", () => {
    expect(main(["compile", join(dir, "nope.js")])).toBe(2);
  });

  it("prints usage for an unknown command", () => {
    expect(main(["wat"])).toBe(0);
  });
});
