# Tasks

## DONE — analysis and design (this ticket's deliverable)

- [x] 1. Locate the prototypes (`original/`, not `sources/`) and open the ticket workspace
- [x] 2. Read `dropcut-cam(1).jsx` end to end (1,971 lines)
- [x] 3. Read `dropcut-ide(1).jsx` end to end (1,673 lines)
- [x] 4. Read `z1-gcode-checker-l2.jsx` end to end (1,217 lines)
- [x] 5. Store the user-supplied DSL design notes in `original/` (DESIGN-01, DESIGN-02)
- [x] 6. Inspect `MakeraBadge.nc` for dialect evidence (header grammar, block census)
- [x] 7. Write the intern architecture guide (design-doc/01, 18 parts)
- [x] 8. Write the prototype API reference and code map (reference/02)
- [x] 9. Keep the investigation diary (reference/01)
- [x] 10. Relate source files, update changelog and index
- [x] 11. Validate with `docmgr doctor`
- [x] 12. Upload the bundle to reMarkable

## Implementation status

M1, M2, M4, M5 and M7 are **built and tested** (191 tests, typecheck clean).
M3 (viewport) and M6 (React shell) are **not started** — the headless core was
finished first so every algorithm is testable in Node, which is the ordering the
design doc recommends for a single developer.

Items marked done below were completed differently from the original plan where
the user clarified that the prototypes are reference sketches, not code to port:
golden-file parity (task 24) was replaced by **analytic ground-truth tests**.

Several M1/M4/M7 items are deliberately still open and are annotated inline with
what is and is not built — notably arc *fitting* (47), the script watchdog (66),
the `job.raw`/`job.canonical` escape hatches (68), and everything editor-related.

## TODO — implementation (see design doc Part XIII)

### M1 — Core types and G-code round trip (no UI)

- [x] 13. `@cam/units`: branded scalars; `inch()` normalises to mm on construction
- [x] 14. `@cam/math`: `Point3<F>`, `Transform<A,B>`, `compose`, `invert`; groupoid property tests
- [x] 15. `@cam/ir`: `Segment`, `Path`, `concat` with endpoint checking; associativity property test
- [x] 16. `@cam/ir`: `CanonicalCommand` union, `Provenance`, `Diagnostic`
- [x] 17. `@cam/machine`: `MachineProfile`, capabilities; `xyz3018` and `makera-z1` profiles
- [x] 18. `@cam/gcode-parser`: port `parseGcode` + `arcPoints`; fix G18/G19 backplot (D5)
- [x] 19. `@cam/compiler/gcode-ir`: `GCodeBlock`, modal `compress()`
- [x] 20. `@cam/post-rs274`: emit blocks → text
- [x] 21. Round-trip property test: `parse(emit(P)).motions ≈ P.motions`, 1,000 generated programs
- [x] 22. Parse `MakeraBadge.nc`; assert the block census from design doc XI.3
- [ ] 23. `dependency-cruiser` config enforcing the layering in design doc III.2 — **not done**; layering is currently enforced only by package.json dependencies and review

### M2 — Geometry kernel

- [x] 24. ~~Capture golden files from the prototypes~~ — superseded: tested against
      analytic ground truth instead (hemisphere CL identity, ramp offset, vee depth,
      cone contour radii, flat-plane Eikonal). Better than parity, because it catches
      errors the prototypes may also have had.
- [x] 25. Port `parseSTL`, `buildModel` → `geometry/mesh.ts` with an explicit `Transform<"mesh","part">`
- [x] 26. Port `buildGrid` → `geometry/spatial-index.ts`
- [x] 27. Port `makeEvaluator` → `geometry/drop-cutter.ts`; keep monomorphic, allocation-free
- [x] 28. Analytic test: hemisphere R0 + ball R → CL hemisphere of radius R0+R, within 1e-6
- [x] 29. Port `buildCLField`, `bilin` → `geometry/cl-field.ts`
- [x] 30. Port `marchSquares`, `splitByMask`; replace the string endpoint key with a packed integer key and name the tolerance (D4)
- [x] 31. Port `solveEikonal` → `geometry/eikonal.ts`; flat-plane sanity test
- [x] 32. Benchmark drop-cutter throughput in CI; assert no regression vs prototype

### M3 — Viewport package (framework-free)

- [ ] 33. `viewer-three/orbit.ts`: one orbit controller, Z-up (ADR-008)
- [ ] 34. `viewer-three/playback.ts`: `sampleAt` + edge-case tests (before first, after last, zero-duration, empty)
- [ ] 35. `viewer-three/toolpath-lines.ts`: rapids/rough/finish + `drawRange` trail
- [ ] 36. `viewer-three/stock-mesh.ts`, `tool-marker.ts`
- [ ] 37. `createViewport() → ViewportApi`; standalone HTML demo, no React
- [ ] 38. Assert 60 fps at 18k segments and zero live WebGL contexts after `dispose()`

### M4 — Strategies and planner

- [x] 39. `strategies/registry.ts` — built as a `dispatchStrategy` switch. **JSON Schema per strategy is not done**; it was specified to drive editor autocomplete, which needs M6/M7's editor first
- [x] 40. Port `zlevel-rough` (union-find scanline clearing)
- [x] 41. Port `raster-finish`
- [x] 42. Port `hybrid-waterline` (with the 1.15/0.85 classification hysteresis)
- [x] 43. Port `constant-scallop` (Eikonal level sets)
- [x] 44. Port `face` and `rect-pocket`; **fix D1** — use the resolved tool diameter, not the hard-coded 4 mm
- [x] 45. `planner/entry.ts`: helix → ramp → plunge; emit an `info` diagnostic when entry degrades (D7)
- [x] 46. `planner/linker.ts`, `clearance.ts`, `refine.ts`
- [ ] 47. `planner/arc-fit.ts` — **not done**. Only arc *lowering* (arc → polyline when a machine cannot express it) exists. Fitting is a pure optimisation and nothing depends on it
- [ ] 48. Arc-fit property tests — **not done** (blocked on 47). Path-continuity property tests ARE done
- [x] 49. CLI `dropcut compile <script> -m <machine> -o out.nc` — done, plus `check`, `example`, `examples`, `machines`. Golden-file parity superseded by analytic tests (see 24)

### M5 — Analysis and certificate

- [x] 50. `analysis/dexel.ts`: merge `verifyJob` + `StockSim` into one sim with batch and incremental modes (ADR-009); drop the dead `_maxIn` (D3)
- [x] 51. `analysis/deviation.ts`: fix `pctOK` to exclude empty margin cells (D2)
- [x] 52. Static checks with provenance — exact checks in `compiler/validate.ts` (travel, spindle range/direction, tool loaded, spindle running, feed present, tool-change interlock, path continuity, suspicious move length, probe support, raw escape) plus sampled checks in `analysis/checks.ts` (rapid-through-stock, rapid below safe Z, spoilboard) and parser checks (unknown codes, late unit switch)
- [x] 53. `analysis/time.ts`: naive length/feed; add `accel` to `MachineProfile` for the future model
- [x] 54. `analysis/certificate.ts`: `ErrorBudget`, `SafetyCertificate`, `CheckStatus` (ADR-010)
- [x] 55. Warn when arc tolerance exceeds the requested scallop
- [x] 56. Verify the planted defects in the `z1` SAMPLE program are both detected

### M6 — Application shell

- [ ] 57. Vite + TS strict + pnpm workspace scaffold
- [ ] 58. Six Redux slices per design doc V.2
- [ ] 59. `artifactCache.ts` (tier 2) + `artifactGc` middleware
- [ ] 60. `compileThunk.ts` with `AbortSignal` cancellation and throttled progress
- [ ] 61. `autoCompile` (600 ms debounce) and `persist` (IndexedDB) middleware
- [ ] 62. `redux-undo` on the `project` slice only, grouping consecutive edits
- [ ] 63. `Viewport.tsx` imperative shell; panels for G-code / IR / diagnostics / stats / certificate
- [ ] 64. Test asserting no typed array ever appears in `store.getState()`
- [ ] 65. Virtualise the G-code list — no 6,000-line cap (D6)

### M7 — Scripting IDE

- [x] 66. Sandbox with capability globals and denied globals shadowed as parameters. **The watchdog is NOT implemented** — it needs the worker host, which is M6 work
- [x] 67. `script-host/api/`: units, tools, geometry, job façade, scope combinators
- [ ] 68. `job.canonical()` escape hatch and `job.raw()` — **not done** in the script API. The IR supports `RawCmd` and the validator downgrades the certificate for it, but the DSL does not expose either yet
- [x] 69. Provenance: script line/column is captured for script ERRORS via a load-time-measured stack offset. **Mapping each `job.*` call to its source line is not done** — operations carry ids, not positions
- [ ] 70. CodeMirror 6 host — **not done** (M6/M7 UI work)
- [ ] 71. Playback line highlight via `StateEffect` — **not done** (needs the viewport and editor)
- [x] 72. Verified `fetch`/`process`/`require` are unreachable from a script. **`while(true)` termination is NOT verified** — that needs the watchdog (see 66)
- [ ] 73. Reproduce the prototype's default program byte-for-byte — **not done**, and now unlikely to be meaningful: the DSL diverged deliberately (real tool diameters, mesh placement, scope combinators)

### M8 — Dialects, import, persistence

- [x] 74. `post-makera`: `;@MKR|` header, `M02` end, arc linearization via capability-driven `lowerArcs` — done and tested against the real export's grammar
- [x] 75. `post-linuxcnc` — done as a machine profile over the shared RS-274 emitter, which is the point of the dialect abstraction
- [x] 76. Round-trip property test per dialect — done for all three profiles
- [ ] 77. G-code import view; reconstruct stock from the `;@MKR|STOCK` header
- [ ] 78. Project save/load; meshes in IndexedDB by content hash

### Follow-ups and open questions (design doc Part XVI)

- [ ] 79. Harden the script sandbox with a null-origin iframe (R4)
- [ ] 80. Cross-compile CL-field cache keyed by (mesh hash, tool, bounds, gridSize) — open question 1
- [ ] 81. Trapezoidal-acceleration time model — open question 2
- [ ] 82. Research `M6` manual tool-change semantics per controller — open question 6
- [ ] 83. Consider WASM for the drop-cutter kernel if profiling justifies it (ADR-005)
- [ ] 84. Simulation snapshots if backward scrubbing proves slow (R9)


## Discovered during implementation

- [x] 85. Distance-aware drop-cutter pruning + nearest-first cell traversal (3,197 → 78,000 q/s)
- [x] 86. Fix marching squares emitting zero-length segments at exact-level nodes
- [x] 87. Fix `splitByMask` cutting closed loops at the array seam
- [x] 88. Fix retract heights computed from the part surface, not the stock (12.9 mm rapid crash)
- [x] 89. Fix retract traverses ending at cutting depth (rapid descending into material)
- [x] 90. Add `NoInfer` so frame mismatches are genuine compile errors
- [x] 91. Add `geometry.mesh(name, { at })` — nothing mapped a part into the work envelope
- [x] 92. Tag emitted motions with the active T-number so simulation stamps the right cutter
- [x] 93. Add `verbatim` G-code blocks so structured headers pass through unreformatted
- [x] 94. Correct the Makera Z travel model (max Z of 0 forbade any clearance height)

### Follow-ups this work created

- [ ] 95. Stock-aware link planning, to recover the travel time the conservative retract clamp costs
- [ ] 96. Arc *fitting* (polyline → arcs). Only arc *lowering* exists; fitting is a pure optimisation
- [ ] 97. Exact toroidal drop-cutter for bull-nose tools (currently a conservative bound)
- [ ] 98. Conical drop-cutter for V-bits (currently approximated by a flat disc of the tip diameter)
- [ ] 99. Move compute into workers; everything is synchronous but cancellation is already polled
- [ ] 100. Re-measure and re-baseline the performance budgets in design doc XIV.5 against reality
