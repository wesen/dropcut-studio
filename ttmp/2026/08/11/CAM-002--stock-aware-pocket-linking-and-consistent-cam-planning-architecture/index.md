---
Title: Stock-aware pocket linking and consistent CAM planning architecture
Ticket: CAM-002
Status: active
Topics:
    - cam
    - toolpath
    - gcode
    - safety
    - architecture
DocType: index
Intent: long-term
Owners: []
RelatedFiles:
    - Path: /home/manuel/code/wesen/2026-08-09--cam-software/packages/strategies/src/pocket.ts
      Note: Immediate source of repeated per-level pocket entries
    - Path: /home/manuel/code/wesen/2026-08-09--cam-software/packages/planner/src/run.ts
      Note: Central path ordering, linking, entry, and command emission
    - Path: /home/manuel/code/wesen/2026-08-09--cam-software/packages/planner/src/linker.ts
      Note: Generic conservative linking policy
ExternalSources: []
Summary: Future implementation ticket for efficient pocket-level transitions and a consistent removal-aware CAM planning contract.
LastUpdated: 2026-08-11T16:40:00-04:00
WhatFor: Organize analysis and future implementation of safe pocket linking, entry policy, path sequencing, and stock-aware planning.
WhenToUse: Begin here when planning, implementing, or reviewing CAM-002.
---

# Stock-aware pocket linking and consistent CAM planning architecture

## Overview

DROPCUT currently emits each rectangular-pocket depth as an independent centre-start path. Because the generic linker cannot prove that the previously cleared pocket interior is safe, it retracts to stock top and re-enters at every level. CAM-002 records a future implementation plan that fixes this behavior without weakening conservative safety checks, then extends the same reasoning into consistent strategy, linking, stock-state, diagnostic, and public API contracts.

This is a design-only ticket. No CAM behavior has been changed yet.

## Key documents

- [Stock-aware pocket linking architecture and implementation guide](./design-doc/01-stock-aware-pocket-linking-architecture-and-implementation-guide.md) — complete current-state analysis, target architecture, pseudocode, decisions, phased implementation, and tests.
- [Investigation diary](./reference/01-investigation-diary.md) — chronological evidence, commands, constraints, and continuation guidance.
- [Tasks](./tasks.md) — ticket progress.
- [Changelog](./changelog.md) — documentation and delivery record.

## Recommended reading order

1. Design sections 1-5 for purpose, vocabulary, current architecture, and root cause.
2. Design sections 6-8 for proposed architecture and decisions.
3. Design sections 9-12 for diagnostics, implementation, and testing.
4. Diary before resuming implementation after a pause.

## Status

Current status: **active / future implementation**

The research and design package is complete. Implementation tasks should be added as a separate phased checklist when work is scheduled.

## Topics

- cam
- toolpath
- gcode
- safety
- architecture

## Structure

- `design-doc/` — primary architecture and implementation guide.
- `reference/` — chronological investigation diary.
- `scripts/` — future ticket-specific experiments and fixture generators.
- `archive/` — superseded proposals if the design changes.
