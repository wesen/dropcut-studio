---
Title: Vite + React + Redux CAM application with embedded JS scripting IDE
Ticket: CAM-001
Status: active
Topics:
    - cam
    - gcode
    - react
    - redux
    - vite
    - ide
    - toolpath
DocType: index
Intent: long-term
Owners: []
RelatedFiles: []
ExternalSources: []
Summary: ""
LastUpdated: 2026-08-09T12:54:39.139769585-04:00
WhatFor: ""
WhenToUse: ""
---

# Vite + React + Redux CAM application with embedded JS scripting IDE

## Overview

Consolidate three standalone React + Three.js CAM prototypes (4,861 lines, in
`original/`) into **DROPCUT Studio**: one Vite + React + Redux application with an
embedded JavaScript scripting IDE.

The organising principle comes from the user-supplied design notes: *do not make
G-code the semantic model — make machining the semantic model and treat G-code as
one serialization backend*. The application is therefore built as a layered
compiler (script → manufacturing plan → toolpaths → canonical IR → machine
program → validated program → G-code), where every intermediate is a value the UI
can inspect.

This ticket delivers the analysis and design. Implementation is planned across
eight milestones in Part XIII of the design doc and enumerated in `tasks.md`.

## Documents

| Document | What it is |
| --- | --- |
| [design-doc/01 — DROPCUT Studio architecture, analysis and implementation guide](./design-doc/01-dropcut-studio-architecture-analysis-and-implementation-guide.md) | The primary deliverable. 18 parts, intern-oriented: domain primer, prototype dissection, layered architecture, data model, Redux design, compute layer, scripting sandbox, viewport, algorithms, verification and error budgets, postprocessors, repository layout, 8-milestone build plan, testing strategy, 10 ADRs, risks, glossary. |
| [reference/01 — Diary](./reference/01-diary.md) | Chronological investigation log with commands, failures and evidence. |
| [reference/02 — Prototype API reference and code map](./reference/02-prototype-api-reference-and-code-map.md) | Function-by-function lookup for all three prototypes: signature, behaviour, gotchas, target module. Includes 8 defects found while reading. |

## Implementation

Source lives in `packages/` and `apps/`, outside the ticket workspace.

| Package | Contents |
| --- | --- |
| `@cam/units` | Branded scalars; inch normalises to mm on construction |
| `@cam/math` | Vec3/Box, frame-tagged `Point3`, SE(3) `Transform` (groupoid laws property-tested) |
| `@cam/ir` | `Path` as a category, non-modal `CanonicalCommand`, provenance, the `ValidatedProgram` brand |
| `@cam/machine` | Capabilities as data; `xyz-3018`, `makera-z1`, `linuxcnc` profiles; tool geometry |
| `@cam/geometry` | Mesh/STL, spatial index, drop-cutter, CL field, marching squares, Eikonal |
| `@cam/strategies` | Raster, constant-scallop, hybrid-waterline, z-level rough, face, pocket, drill |
| `@cam/planner` | Manufacturing plan, entry, linker, refinement, the plan runner |
| `@cam/analysis` | Dexel simulator, deviation, sampled checks, error budgets, certificates, time |
| `@cam/compiler` | `GCodeBlock` IR, the single modal `compress()`, `lower()`, `validate()`, `recertify()` |
| `@cam/gcode-parser` | Modal RS-274 interpreter, all three arc planes, structured header harvesting |
| `@cam/post-rs274` / `@cam/post-makera` | Emitter, and a dialect that is pure configuration |
| `@cam/script-host` | Capability API, sandbox, worked examples |
| `@studio/cli` | `dropcut compile / check / example / examples / machines` |

Bugs the implementation found that the design phase did not:

- The dexel simulator caught a rapid ploughing through **12.9 mm of stock** on a
  real finishing compile — two planner defects (retract heights computed from the
  part rather than the stock; traverses ending at cutting depth).
- The drop-cutter's first working version ran at **3,197 queries/s**, 60x under
  the design doc's *unmeasured* estimate. Distance-aware pruning plus
  nearest-first cell traversal took it to ~78,000.
- Marching squares emitted zero-length segments where a grid node landed exactly
  on the contour level; `splitByMask` cut closed loops at the array seam.
- Nothing mapped a part into the work envelope — `geometry.mesh(name, { at })`
  was a missing capability, not just a missing fixture.

## Source material

| Path | Lines | Role |
| --- | --- | --- |
| `original/dropcut-cam(1).jsx` | 1,971 | Drop-cutter CAM: strategies, arc fitting, dexel verification, RS-274 emission |
| `original/dropcut-ide(1).jsx` | 1,673 | Scripting IDE: DSL sandbox, canonical IR, validation, modal G-code |
| `original/z1-gcode-checker-l2.jsx` | 1,217 | G-code parser, heightmap stock simulator, static safety checks |
| `original/MakeraBadge.nc` | 18,531 | Real Makera Studio export — dialect evidence and parser fixture |
| `original/DESIGN-01-semantic-cam-architecture.md` | — | Normative architecture (user-supplied) |
| `original/DESIGN-02-kleisli-composition-for-machine-commands.md` | — | Sequencing model for stateful, fallible machine commands (user-supplied) |

## Key decisions

- **ADR-001** Machining semantics, not G-code, is the model.
- **ADR-002** The canonical IR is non-modal; modality is a postprocessor compression pass.
- **ADR-003** Certified stages: only the validator can construct a `ValidatedProgram`.
- **ADR-004** Redux holds documents and summaries; geometry lives in an artifact cache keyed by content hash.
- **ADR-005** Heavy compute runs in Web Workers over transferable typed arrays.
- **ADR-006** User scripts run in a sandboxed worker with capability-limited globals and a watchdog.
- **ADR-010** Safety certificates report what was actually verified and at what resolution — never a bare `safe: true`.

Full records in Part XV of the design doc.

## Key Links

- **Related Files**: See frontmatter RelatedFiles field
- **External Sources**: See frontmatter ExternalSources field

## Status

Current status: **active** — analysis and design complete; the **headless core is
built and tested** (191 tests, typecheck clean, 14 packages, ~11,100 lines).

Milestones M1 (core + G-code round trip), M2 (geometry kernel), M4 (strategies +
planner), M5 (analysis + safety certificates) and M7 (scripting host + CLI) are
done. M3 (Three.js viewport) and M6 (React/Redux shell) are not started — the
headless pipeline was finished first so every algorithm is testable in Node,
which is the ordering the design doc recommends.

`dropcut compile prog.js -m makera-z1` turns a JavaScript script into validated,
simulated, machine-specific G-code with a printed safety certificate.

## Topics

- cam
- gcode
- react
- redux
- vite
- ide
- toolpath

## Tasks

See [tasks.md](./tasks.md) for the current task list.

## Changelog

See [changelog.md](./changelog.md) for recent changes and decisions.

## Structure

- design/ - Architecture and design documents
- reference/ - Prompt packs, API contracts, context summaries
- playbooks/ - Command sequences and test procedures
- scripts/ - Temporary code and tooling
- various/ - Working notes and research
- archive/ - Deprecated or reference-only artifacts
