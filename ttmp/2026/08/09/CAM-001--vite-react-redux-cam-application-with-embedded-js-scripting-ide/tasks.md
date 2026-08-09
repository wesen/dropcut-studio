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

## TODO — implementation (see design doc Part XIII)

### M1 — Core types and G-code round trip (no UI)

- [ ] 13. `@cam/units`: branded scalars; `inch()` normalises to mm on construction
- [ ] 14. `@cam/math`: `Point3<F>`, `Transform<A,B>`, `compose`, `invert`; groupoid property tests
- [ ] 15. `@cam/ir`: `Segment`, `Path`, `concat` with endpoint checking; associativity property test
- [ ] 16. `@cam/ir`: `CanonicalCommand` union, `Provenance`, `Diagnostic`
- [ ] 17. `@cam/machine`: `MachineProfile`, capabilities; `xyz3018` and `makera-z1` profiles
- [ ] 18. `@cam/gcode-parser`: port `parseGcode` + `arcPoints`; fix G18/G19 backplot (D5)
- [ ] 19. `@cam/compiler/gcode-ir`: `GCodeBlock`, modal `compress()`
- [ ] 20. `@cam/post-rs274`: emit blocks → text
- [ ] 21. Round-trip property test: `parse(emit(P)).motions ≈ P.motions`, 1,000 generated programs
- [ ] 22. Parse `MakeraBadge.nc`; assert the block census from design doc XI.3
- [ ] 23. `dependency-cruiser` config enforcing the layering in design doc III.2

### M2 — Geometry kernel

- [ ] 24. Capture golden files from the prototypes **before** porting anything
- [ ] 25. Port `parseSTL`, `buildModel` → `geometry/mesh.ts` with an explicit `Transform<"mesh","part">`
- [ ] 26. Port `buildGrid` → `geometry/spatial-index.ts`
- [ ] 27. Port `makeEvaluator` → `geometry/drop-cutter.ts`; keep monomorphic, allocation-free
- [ ] 28. Analytic test: hemisphere R0 + ball R → CL hemisphere of radius R0+R, within 1e-6
- [ ] 29. Port `buildCLField`, `bilin` → `geometry/cl-field.ts`
- [ ] 30. Port `marchSquares`, `splitByMask`; replace the string endpoint key with a packed integer key and name the tolerance (D4)
- [ ] 31. Port `solveEikonal` → `geometry/eikonal.ts`; flat-plane sanity test
- [ ] 32. Benchmark drop-cutter throughput in CI; assert no regression vs prototype

### M3 — Viewport package (framework-free)

- [ ] 33. `viewer-three/orbit.ts`: one orbit controller, Z-up (ADR-008)
- [ ] 34. `viewer-three/playback.ts`: `sampleAt` + edge-case tests (before first, after last, zero-duration, empty)
- [ ] 35. `viewer-three/toolpath-lines.ts`: rapids/rough/finish + `drawRange` trail
- [ ] 36. `viewer-three/stock-mesh.ts`, `tool-marker.ts`
- [ ] 37. `createViewport() → ViewportApi`; standalone HTML demo, no React
- [ ] 38. Assert 60 fps at 18k segments and zero live WebGL contexts after `dispose()`

### M4 — Strategies and planner

- [ ] 39. `strategies/registry.ts`: `defineStrategy`, JSON Schema per strategy
- [ ] 40. Port `zlevel-rough` (union-find scanline clearing)
- [ ] 41. Port `raster-finish`
- [ ] 42. Port `hybrid-waterline` (with the 1.15/0.85 classification hysteresis)
- [ ] 43. Port `constant-scallop` (Eikonal level sets)
- [ ] 44. Port `face` and `rect-pocket`; **fix D1** — use the resolved tool diameter, not the hard-coded 4 mm
- [ ] 45. `planner/entry.ts`: helix → ramp → plunge; emit an `info` diagnostic when entry degrades (D7)
- [ ] 46. `planner/linker.ts`, `clearance.ts`, `refine.ts`
- [ ] 47. `planner/arc-fit.ts`: produce geometric `Segment`s, not plane-tagged ops; keep the centre projection
- [ ] 48. Property tests: arc-fit tolerance, arc-fit endpoint continuity, path continuity
- [ ] 49. CLI `dropcut plan part.stl --strategy … -o out.nc`; golden-file parity for all four combinations

### M5 — Analysis and certificate

- [ ] 50. `analysis/dexel.ts`: merge `verifyJob` + `StockSim` into one sim with batch and incremental modes (ADR-009); drop the dead `_maxIn` (D3)
- [ ] 51. `analysis/deviation.ts`: fix `pctOK` to exclude empty margin cells (D2)
- [ ] 52. `analysis/static-checks.ts`: all thirteen checks from design doc X.4, each with provenance
- [ ] 53. `analysis/time.ts`: naive length/feed; add `accel` to `MachineProfile` for the future model
- [ ] 54. `analysis/certificate.ts`: `ErrorBudget`, `SafetyCertificate`, `CheckStatus` (ADR-010)
- [ ] 55. Warn when arc tolerance exceeds the requested scallop
- [ ] 56. Verify the planted defects in the `z1` SAMPLE program are both detected

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

- [ ] 66. Script worker: capability globals, deleted network APIs, main-thread watchdog (ADR-006)
- [ ] 67. `script-host/api/`: units, tools, geometry, job façade, scope combinators
- [ ] 68. `job.canonical()` escape hatch and `job.raw()` with declared effects
- [ ] 69. Provenance capture: map `job.*` calls back to script line/column
- [ ] 70. CodeMirror 6 host: lang-javascript, lint gutter from diagnostics, schema-driven autocomplete
- [ ] 71. Playback line highlight via `StateEffect`, not Redux
- [ ] 72. Verify `while(true){}` is terminated and `fetch()` throws
- [ ] 73. Reproduce the prototype's default program byte-for-byte in G-code

### M8 — Dialects, import, persistence

- [ ] 74. `post-makera`: `;@MKR|` header, `M02` end, arc linearization via `lowerArcs`
- [ ] 75. `post-linuxcnc`
- [ ] 76. Round-trip property test per dialect
- [ ] 77. G-code import view; reconstruct stock from the `;@MKR|STOCK` header
- [ ] 78. Project save/load; meshes in IndexedDB by content hash

### Follow-ups and open questions (design doc Part XVI)

- [ ] 79. Harden the script sandbox with a null-origin iframe (R4)
- [ ] 80. Cross-compile CL-field cache keyed by (mesh hash, tool, bounds, gridSize) — open question 1
- [ ] 81. Trapezoidal-acceleration time model — open question 2
- [ ] 82. Research `M6` manual tool-change semantics per controller — open question 6
- [ ] 83. Consider WASM for the drop-cutter kernel if profiling justifies it (ADR-005)
- [ ] 84. Simulation snapshots if backward scrubbing proves slow (R9)
