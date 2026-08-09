/**
 * The saved file format.
 *
 * A saved project outlives the code that wrote it, so the tests that matter
 * here are about surviving inputs the current code did not produce: an older
 * document, a newer one, a truncated one, a hand-edited one.
 */

import { describe, expect, it } from "vitest";
import {
  createDocument, parseDocument, PROJECT_FORMAT_VERSION, serialise, settingsEqual,
  settingsOf, suggestedFilename, updateDocument,
} from "./projectFile.js";

const SETTINGS = {
  name: "bracket",
  script: "job.setup({});",
  machineId: "linuxcnc",
  simulate: true,
  simulationResolution: 140,
};

describe("document lifecycle", () => {
  it("creates a document with an id and timestamps", () => {
    const doc = createDocument(SETTINGS);
    expect(doc.formatVersion).toBe(PROJECT_FORMAT_VERSION);
    expect(doc.id).toBeTruthy();
    expect(doc.createdAt).toBe(doc.modifiedAt);
    expect(doc.name).toBe("bracket");
  });

  it("gives distinct ids to distinct documents", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createDocument(SETTINGS).id));
    expect(ids.size).toBe(50);
  });

  it("preserves id and creation time across updates", () => {
    const first = createDocument(SETTINGS, new Date("2026-01-01T00:00:00Z"));
    const second = updateDocument(
      first,
      { ...SETTINGS, script: "changed" },
      new Date("2026-06-01T00:00:00Z"),
    );
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.modifiedAt).not.toBe(first.modifiedAt);
    expect(second.script).toBe("changed");
  });

  it("falls back to the previous name rather than accepting an empty one", () => {
    const doc = createDocument(SETTINGS);
    expect(updateDocument(doc, { ...SETTINGS, name: "" }).name).toBe("bracket");
  });
});

describe("round trip", () => {
  it("survives serialise then parse", () => {
    const doc = createDocument(SETTINGS);
    const parsed = parseDocument(serialise(doc));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.document).toEqual(doc);
  });

  it("writes indented JSON so saved files diff cleanly", () => {
    const text = serialise(createDocument(SETTINGS));
    expect(text).toContain('\n  "script"');
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("parsing hostile input", () => {
  it("rejects non-JSON with a readable message", () => {
    const r = parseDocument("{not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not valid JSON/);
  });

  it("rejects a JSON value that is not an object", () => {
    expect(parseDocument("42").ok).toBe(false);
    expect(parseDocument('"a string"').ok).toBe(false);
    expect(parseDocument("null").ok).toBe(false);
  });

  it("refuses a file from a NEWER format version", () => {
    const future = JSON.stringify({ ...createDocument(SETTINGS), formatVersion: 99 });
    const r = parseDocument(future);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/newer than this build/);
  });

  it("accepts a version-less file that still has a script", () => {
    const r = parseDocument(JSON.stringify({ script: "job.setup({});", name: "legacy" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.document.formatVersion).toBe(PROJECT_FORMAT_VERSION);
      expect(r.document.name).toBe("legacy");
      expect(r.document.machineId).toBe("linuxcnc"); // defaulted
      expect(r.document.id).toBeTruthy();            // minted
    }
  });

  it("refuses a version-less file with no script", () => {
    const r = parseDocument(JSON.stringify({ name: "empty" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no 'script' field/);
  });

  it("repairs a current-version file missing optional fields", () => {
    const r = parseDocument(JSON.stringify({
      formatVersion: 1, script: "x", machineId: "makera-z1",
    }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.document.simulate).toBe(true);
      expect(r.document.simulationResolution).toBe(140);
      expect(r.document.name).toBe("untitled");
    }
  });

  it("rejects a wrong-typed field rather than silently discarding it", () => {
    // Defaulting here would open the project with an EMPTY script, which looks
    // like the user's work vanished.
    const r = parseDocument(JSON.stringify({ formatVersion: 1, script: 42 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/'script' should be a string, got number/);

    const bad = parseDocument(JSON.stringify({
      formatVersion: 1, script: "ok", simulationResolution: "high",
    }));
    expect(bad.ok).toBe(false);
  });
});

describe("dirty tracking", () => {
  it("compares settings and ignores identity and timestamps", () => {
    const doc = createDocument(SETTINGS);
    expect(settingsEqual(settingsOf(doc), SETTINGS)).toBe(true);
  });

  it("notices every field that matters", () => {
    const base = SETTINGS;
    expect(settingsEqual(base, { ...base, script: "other" })).toBe(false);
    expect(settingsEqual(base, { ...base, name: "other" })).toBe(false);
    expect(settingsEqual(base, { ...base, machineId: "makera-z1" })).toBe(false);
    expect(settingsEqual(base, { ...base, simulate: false })).toBe(false);
    expect(settingsEqual(base, { ...base, simulationResolution: 200 })).toBe(false);
  });

  it("reports clean again after an edit is undone", () => {
    const saved = settingsOf(createDocument(SETTINGS));
    const edited = { ...SETTINGS, script: "temporary" };
    expect(settingsEqual(saved, edited)).toBe(false);
    expect(settingsEqual(saved, { ...edited, script: SETTINGS.script })).toBe(true);
  });
});

describe("filenames", () => {
  it("produces a filesystem-safe name", () => {
    // The slash is stripped and the surrounding whitespace collapses to one dash.
    expect(suggestedFilename("Bracket v2 / final")).toBe("bracket-v2-final.dropcut.json");
    expect(suggestedFilename("  spaced  out ")).toBe("spaced-out.dropcut.json");
  });

  it("falls back for a name with nothing usable in it", () => {
    expect(suggestedFilename("///")).toBe("untitled.dropcut.json");
    expect(suggestedFilename("")).toBe("untitled.dropcut.json");
  });
});
