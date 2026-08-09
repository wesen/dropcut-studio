/**
 * Store behaviour, especially the rule that keeps it usable at scale.
 *
 * The headline test is `no typed arrays in the store`. That is the mechanical
 * enforcement of ADR-004, and it is the thing that quietly breaks first when
 * someone is in a hurry: one `Float32Array` in a slice and DevTools stops being
 * usable on real programs.
 */

import { describe, expect, it } from "vitest";
import { EXAMPLES } from "@cam/script-host";
import { artifactCount, clearArtifacts, getArtifact } from "./artifactCache.js";
import { compile } from "./compileThunk.js";
import { createStore } from "./store.js";
import { machineChanged, scriptChanged } from "./slices.js";

/** Walk a value looking for anything that must not be in a Redux store. */
function findForbidden(value: unknown, path = "state", seen = new Set<unknown>()): string | null {
  if (value === null || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (ArrayBuffer.isView(value)) return `${path} is a typed array (${value.constructor.name})`;
  if (value instanceof ArrayBuffer) return `${path} is an ArrayBuffer`;
  if (value instanceof Map || value instanceof Set) return `${path} is a ${value.constructor.name}`;
  if (typeof value === "function") return `${path} is a function`;

  for (const [k, v] of Object.entries(value)) {
    const found = findForbidden(v, `${path}.${k}`, seen);
    if (found) return found;
  }
  return null;
}

const POCKET = EXAMPLES[0].source;

describe("store", () => {
  it("starts with an example loaded", () => {
    const store = createStore();
    expect(store.getState().project.script.length).toBeGreaterThan(100);
    expect(store.getState().compile.status).toBe("idle");
  });

  it("compiles and records summaries", async () => {
    clearArtifacts();
    const store = createStore();
    store.dispatch(scriptChanged(POCKET));
    await store.dispatch(compile());

    const s = store.getState().compile;
    expect(s.status).toBe("ok");
    expect(s.artifactId).not.toBeNull();
    expect(s.stats!.lines).toBeGreaterThan(50);
    expect(s.summaries.map((x) => x.operationId)).toEqual(["face#1", "pocket#1"]);
    expect(s.certificate.length).toBe(8);
  });

  it("never puts a typed array, Map, Set or function in the store", async () => {
    const store = createStore();
    store.dispatch(scriptChanged(POCKET));
    await store.dispatch(compile());

    const found = findForbidden(store.getState());
    expect(found, found ?? "clean").toBeNull();
  });

  it("keeps the heavy artifacts in the cache, reachable by id", async () => {
    clearArtifacts();
    const store = createStore();
    store.dispatch(scriptChanged(POCKET));
    await store.dispatch(compile());

    const id = store.getState().compile.artifactId!;
    const artifact = getArtifact(id);
    expect(artifact).toBeDefined();
    // Exactly the things that must NOT be in Redux.
    expect(ArrayBuffer.isView(artifact!.buffers.positions)).toBe(true);
    expect(artifact!.buffers.count).toBeGreaterThan(10);
    expect(artifact!.document.lines.length).toBeGreaterThan(50);
  });

  it("garbage-collects superseded artifacts", async () => {
    clearArtifacts();
    const store = createStore();
    store.dispatch(scriptChanged(POCKET));
    await store.dispatch(compile());
    expect(artifactCount()).toBe(1);

    // A second compile must not leak the first one's buffers.
    await store.dispatch(compile());
    expect(artifactCount()).toBe(1);
  });

  it("reports a failed compile without leaving stale geometry on screen", async () => {
    const store = createStore();
    store.dispatch(scriptChanged(POCKET));
    await store.dispatch(compile());
    expect(store.getState().compile.artifactId).not.toBeNull();

    store.dispatch(scriptChanged("job.face({});"));
    await store.dispatch(compile());

    const s = store.getState().compile;
    expect(s.status).toBe("failed");
    expect(s.failedStage).toBe("script");
    // Critically: the id is cleared, so the viewport shows nothing rather than
    // the previous program's toolpath.
    expect(s.artifactId).toBeNull();
  });

  it("recompiles for a different machine and the output differs", async () => {
    const store = createStore();
    store.dispatch(scriptChanged(POCKET));
    await store.dispatch(compile());
    const linux = getArtifact(store.getState().compile.artifactId!)!.document.text;

    store.dispatch(machineChanged("makera-z1"));
    await store.dispatch(compile());
    const makera = getArtifact(store.getState().compile.artifactId!)!.document.text;

    expect(linux).toContain("M30");
    expect(makera).toContain("M02");
    expect(makera).toContain(";@MKR|BEGIN");
  });

  it("surfaces the certificate as flat serialisable rows", async () => {
    const store = createStore();
    store.dispatch(scriptChanged(POCKET));
    await store.dispatch(compile());

    const rows = store.getState().compile.certificate;
    const byLabel = new Map(rows.map((r) => [r.label, r]));
    expect(byLabel.get("travel limits")!.status).toBe("exact");
    expect(byLabel.get("gouge")!.status).toBe("resolution");
    expect(byLabel.get("fixture collision")!.status).toBe("skipped");
    expect(store.getState().compile.errorBudgetMm).toBeGreaterThan(0);
  });
});
