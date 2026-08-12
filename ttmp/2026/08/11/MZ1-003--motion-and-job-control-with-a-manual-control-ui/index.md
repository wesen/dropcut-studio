---
Title: Motion and job control with a manual control UI
Ticket: MZ1-003
Status: active
Topics:
    - cnc
    - protocol
    - cli
    - glazed
    - architecture
    - safety
    - frontend
DocType: index
Intent: long-term
Owners: []
RelatedFiles: []
ExternalSources: []
Summary: "Design for adding motion and job control to z1ctl together with a pendant-style manual control UI: four risk classes, the authorised path, jogging with its dead-man keepalive, job lifecycle and halt handling, and a bring-up sequence starting from an air cut."
LastUpdated: 2026-08-11T22:30:00-04:00
WhatFor: "Landing page for the motion and job control work."
WhenToUse: "Start here before implementing anything that can move the machine."
---

# Motion and job control, with a manual control UI

Design-only ticket. No code has been written; this exists so the design is
settled before anything in it can move a machine tool.

Builds on MZ1-001 (protocol, client, read-only CLI) and MZ1-002 (control page).

## What makes this ticket different

Everything built so far shares one property: the worst possible bug was a wrong
answer. From here on, the worst possible bug is a machine moving when nobody
asked, or not stopping when somebody did.

Two principles run through the design:

- **Software is not the safety system.** The physical emergency stop and the
  cover interlock are. Software gating is convenient and catches mistakes, and
  must never be the only thing between an operator and an injury.
- **Stopping is never gated.** `suspend`, `abort`, feed hold and jog-stop work
  in every state, including when the preflight is failing and the software is
  confused. A stop that can be refused is not a stop.

## Key document

| Document | What it is |
|---|---|
| [design/01 — Motion and Job Control: Analysis, Design and Implementation Guide](design/01-motion-and-job-control-analysis-design-and-implementation-guide.md) | The whole thing: risk classes, authorised path, jogging and its dead-man, job lifecycle, the UI, HTTP surface, testing, bring-up, five decision records |

## The single best thing in this design

Continuous jog requires a keepalive every ~200 ms. **If the host stops sending
it, the machine stops moving.** That is a dead-man switch built into the
firmware, and it is the strongest safety guarantee in the system because it does
not depend on our software behaving correctly — it depends on our software
*stopping*. A crashed client, a closed tab, a severed network: all stop the axis.

The UI does not need to invent a dead-man. It needs to avoid defeating the one
that exists. See design guide §4.2 and ADR-011.

## Blocking prerequisite

**A safety review of §3 (the risk classification) and §11 (the preflight) by
someone who operates the machine**, before any code is written. Those are
engineering judgements about a physical machine and should be checked by someone
whose hands are near it.

## Three questions to answer first

1. Does `play` take `-O` (what the reference controller sends) or `-v` (what the
   firmware's own help documents)?
2. Does single-axis homing (`$H X`) work on this firmware?
3. Which mechanism sets a work zero reliably — `G10 L20`, or the configuration
   path the reference controller uses?

## Status

Design complete, unreviewed, unimplemented.

## Topics

- cnc
- protocol
- cli
- glazed
- architecture
- safety
- frontend
