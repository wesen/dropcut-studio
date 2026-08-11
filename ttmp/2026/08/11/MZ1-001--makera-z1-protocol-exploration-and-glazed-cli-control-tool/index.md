---
Title: Makera Z1 protocol exploration and Glazed CLI control tool
Ticket: MZ1-001
Status: active
Topics:
    - cnc
    - protocol
    - cli
    - glazed
    - architecture
    - research
DocType: index
Intent: long-term
Owners: []
RelatedFiles: []
ExternalSources:
    - https://github.com/Carvera-Community/Carvera_Controller
    - https://github.com/MakeraInc/CarveraController
    - https://github.com/hagmonk/carvera-cli
    - https://github.com/GridSpace/carve-control
Summary: "Research and design ticket for z1ctl, a Glazed-based Go CLI that discovers, controls and feeds jobs to a Makera Z1, plus a complete specification of the Makera wire protocol derived from upstream source."
LastUpdated: 2026-08-11T17:10:00-04:00
WhatFor: "Landing page for the Makera Z1 protocol investigation and the z1ctl CLI design."
WhenToUse: "Start here when picking up MZ1-001."
---

# Makera Z1 protocol exploration and Glazed CLI control tool

## Overview

This ticket does two things:

1. **Reverse-specifies the Makera/Carvera wire protocol** from upstream source —
   framing, CRC, packet types, protocol autodetection, the command surface, the
   status and diagnose grammars, and both file-transfer variants — with a
   file:line citation for every claim, and with the specification made
   *executable* by four offline experiments.
2. **Designs `z1ctl`**, a Glazed-based Go CLI that discovers machines, queries
   status, runs commands, moves files, and drives jobs. A device-control GUI is
   explicitly a later ticket; this exists to make that GUI cheap to build.

**Status:** research and design complete, and **the wire layer is now confirmed
against a real machine** — `Makera_Z1_012146`, firmware `1.0.15.0.1.11`,
read-only session on 2026-08-11 with **zero decoder drops**. The payload formats
needed about a dozen corrections, all recorded in `reference/03`. No code written
in the target module yet. Phase 0 and Phase 1 need no machine and are now a
mechanical port of validated code.

**Nothing has ever been sent to the machine that could move it.**
`scripts/05-probe.py` enforces a read-only allowlist in code — motion, job,
file-write and config-write verbs are refused before a byte reaches the socket,
and the only realtime byte permitted is `?`.

**Licence: GPL-2.0** (ADR-008), matching the Carvera Community Controller — so
upstream code may be ported with provenance headers, and the protocol spec is
published in the repo as `docs/protocol.md`. One sub-decision is still open:
GPLv2-only vs GPLv2-or-later (recommendation: or-later). Note that copyleft
reaches the future device control UI — see design guide §3.5.3 before that
ticket starts.

### The two findings that shape everything

- **The Z1 does not stream G-code.** You upload a `.nc` to the machine's SD card
  and send `play <path>`; the machine runs the job locally. The host supervises.
- **There are two wire protocols and the Z1 uses the newer, framed one.** Of the
  four public implementations surveyed, only the two GPL Python controllers
  implement it — `hagmonk/carvera-cli` and `GridSpace/carve-control` are
  legacy-text-only and cannot talk to a Z1.

## Key documents

| Document | What it is |
|---|---|
| [design/01 — Analysis, Design and Implementation Guide](design/01-makera-z1-protocol-and-glazed-cli-analysis-design-and-implementation-guide.md) | **Start here.** Intern-facing: what a Z1 is, the full protocol explained, the Go/Glazed architecture, decision records, phased implementation plan, testing, safety, onboarding checklist |
| [reference/03 — Live Z1 Observations, fw 1.0.15](reference/03-live-z1-observations-firmware-1-0-15.md) | **Ground truth from the real machine.** Verbatim captures plus ~12 places the hardware contradicts the source-derived spec. Outranks the two documents above wherever they disagree |
| [reference/02 — Makera Wire Protocol Reference](reference/02-makera-wire-protocol-reference.md) | Terse citation-dense spec, source-derived. Keep open while implementing `pkg/makera`, but read `reference/03` first |
| [reference/01 — Investigation Diary](reference/01-investigation-diary.md) | How the conclusions were reached, which upfront assumptions were corrected, what failed and why, what remains unverified |
| [tasks.md](./tasks.md) | Research tasks done; implementation tasks queued by phase |
| [changelog.md](./changelog.md) | Dated summary of changes |

## Experiments (all pass, all run without hardware)

```bash
python3 scripts/01-frame-vectors.py                  # frame golden vectors vs upstream
python3 scripts/03-discover.py --self-test           # discovery record parser
( cd scripts/02-goframe  && GOWORK=off go run . )    # Go codec + adversarial RX tests
( cd scripts/04-gostatus && GOWORK=off go run . )    # status/diagnose grammar decoder
```

With the machine on (read-only, enforced allowlist):

```bash
python3 scripts/03-discover.py --listen 25           # passive; cannot affect the machine
python3 scripts/05-probe.py --host 192.168.0.55      # identity, status, diagnose
python3 scripts/05-probe.py --host 192.168.0.55 --hex --cmd "ls -e -s /sd/gcodes"
```

`scripts/05-probe.py` implements framing from our own specification rather than
importing upstream, so a clean run validates the spec end to end. It holds the
machine's single TCP slot while running, so the Makera/Community controllers
cannot connect at the same time.

## Vendored references

`vendor/` holds shallow clones used as evidence (not dependencies):

| Directory | Upstream | Licence (verified in the clone) | Framed (Z1) protocol? |
|---|---|---|---|
| `community-carvera-controller` | Carvera-Community/Carvera_Controller @ `777482a` (v2.2.0-RC1) | GPL-2.0 | **yes** — authoritative for the Z1; may be ported from |
| `makera-carvera-controller` | MakeraInc/CarveraController | **GPL-3.0** | **yes** — original framing intent, Chinese spec comments. Facts only; incompatible with a GPLv2-only tree |
| `hagmonk-carvera-cli` | hagmonk/carvera-cli | **none found** | no — good CLI shape and the echo-sentinel idea, legacy wire only |
| `gridspace-carve-control` | GridSpace/carve-control | MIT | no — good proxy/spoof patterns, legacy wire only |

## Status

Current status: **active** — design complete, implementation not started.

## Topics

- cnc
- protocol
- cli
- glazed
- architecture
- research

## Structure

- `design/` — the analysis / design / implementation guide
- `reference/` — investigation diary, wire protocol reference
- `scripts/` — runnable experiments (`01`…`04`), numbered in investigation order
- `sources/web/` — defuddled upstream pages with docmgr frontmatter
- `vendor/` — shallow clones of the four reference implementations
- `playbooks/`, `various/`, `archive/` — unused so far
