# Changelog

## 2026-08-09

- Initial workspace created


## 2026-08-09

Read all three prototypes end to end (4,861 lines); mapped every top-level function to a target module

### Related Files

- /home/manuel/code/wesen/2026-08-09--cam-software/original/dropcut-cam(1).jsx — generateJob:546 fuses six pipeline stages


## 2026-08-09

Stored the user-supplied DSL design notes as normative input (commit 214a44a)

### Related Files

- /home/manuel/code/wesen/2026-08-09--cam-software/original/DESIGN-01-semantic-cam-architecture.md — Five-layer semantic stack, canonical IR, capability-driven lowering


## 2026-08-09

Inspected MakeraBadge.nc: ;@MKR| header grammar, 17,439 G1 / 0 arcs, M02 end — concrete dialect evidence

### Related Files

- /home/manuel/code/wesen/2026-08-09--cam-software/original/MakeraBadge.nc — Parser conformance fixture and Makera dialect reference


## 2026-08-09

Wrote the intern architecture guide: 18 parts covering domain primer, prototype dissection, layered design, Redux state, scripting sandbox, viewport, algorithms, error budgets, dialects, file-by-file plan, 8 milestones, 10 ADRs

### Related Files

- /home/manuel/code/wesen/2026-08-09--cam-software/ttmp/2026/08/09/CAM-001--vite-react-redux-cam-application-with-embedded-js-scripting-ide/design-doc/01-dropcut-studio-architecture-analysis-and-implementation-guide.md — Primary deliverable


## 2026-08-09

Wrote the prototype API reference and code map, including 8 defects found while reading (D1 hard-coded 4mm tool diameter in face/rectPocket is a live bug)

### Related Files

- /home/manuel/code/wesen/2026-08-09--cam-software/ttmp/2026/08/09/CAM-001--vite-react-redux-cam-application-with-embedded-js-scripting-ide/reference/02-prototype-api-reference-and-code-map.md — Function-by-function lookup table


## 2026-08-09

Implemented M1: units, math/frames, non-modal IR, machine profiles, compiler, parser, RS-274 and Makera posts (commit c3af382)

### Related Files

- /home/manuel/code/wesen/2026-08-09--cam-software/packages/compiler/src/gcode-ir.ts — The only place modality exists


## 2026-08-09

Implemented M2: geometry kernel; drop-cutter went 3,197 to 78,000 q/s via distance-aware pruning and nearest-first traversal (commit 239c28b)

### Related Files

- /home/manuel/code/wesen/2026-08-09--cam-software/packages/geometry/src/drop-cutter.ts — Hot kernel with analytic contact cases


## 2026-08-09

Implemented M4: five strategies plus planner; defect D1 fixed and regression-tested (commit af1caea)

### Related Files

- /home/manuel/code/wesen/2026-08-09--cam-software/packages/planner/src/run.ts — Composes strategy, ordering, linking and entry


## 2026-08-09

Implemented M5: dexel sim found two real planner crashes (12.9mm rapid through stock); honest safety certificates (commit 4c780ec)

### Related Files

- /home/manuel/code/wesen/2026-08-09--cam-software/packages/planner/src/linker.ts — Carries both crash fixes and the reasoning


## 2026-08-09

Implemented M7: scripting sandbox, DSL, examples and headless CLI; 191 tests green (commit 97d7c64)

### Related Files

- /home/manuel/code/wesen/2026-08-09--cam-software/apps/cli/src/compile.ts — The whole pipeline in one function


## 2026-08-09

Implemented M3+M6: framework-free Three.js viewport and the Vite/React/Redux app; verified in Chromium; 214 tests (commit 97f4b65)

### Related Files

- /home/manuel/code/wesen/2026-08-09--cam-software/apps/studio/src/state/store.test.ts — Enforces the three-tier rule by walking the state tree

