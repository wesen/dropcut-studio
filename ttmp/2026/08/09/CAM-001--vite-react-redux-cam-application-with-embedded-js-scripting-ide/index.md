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

Current status: **active** — analysis and design complete; implementation not started.

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
