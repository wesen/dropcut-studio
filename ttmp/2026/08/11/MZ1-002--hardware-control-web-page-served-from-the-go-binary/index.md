---
Title: Hardware control web page served from the Go binary
Ticket: MZ1-002
Status: active
Topics:
    - cnc
    - cli
    - architecture
    - frontend
    - protocol
DocType: index
Intent: long-term
Owners: []
RelatedFiles: []
ExternalSources: []
Summary: "z1ctl serve: a read-only machine telemetry page embedded in the Go binary, styled to match DROPCUT Studio, with motion deliberately disabled until the endstop mapping is confirmed."
LastUpdated: 2026-08-11T18:30:00-04:00
WhatFor: "Landing page for the hardware control web UI work."
WhenToUse: "Start here when picking up MZ1-002."
---

# Hardware control web page

`z1ctl serve` renders a hardware control page for a Makera Z1 from the Go
binary. It is a separate surface from DROPCUT Studio — Studio is the CAM
application, this is the machine pendant — styled from the same design tokens so
the two read as one instrument.

**Everything on the page is read-only.** Every endpoint is a GET; none of them
can move the machine, start a job, or write to the SD card. Motion controls are
rendered but disabled, with the reason stated in the page.

Built on MZ1-001, which established the protocol and the library.

## Key documents

| Document | What it is |
|---|---|
| [design/01 — Hardware Control Web Page Design](design/01-hardware-control-web-page-design.md) | Why one shared session, why polling rather than websockets, why no build step, the visual token mapping, and what enabling motion requires |

## Status

Implemented and verified against `Makera_Z1_012146` (firmware `1.0.15.0.1.11`):
live DRO, file listing, preflight checks, raw status inspection. No write was
attempted and the machine did not move.

## Running it

```bash
z1ctl serve                                    # discover the machine, serve :8080
z1ctl serve --addr :8137 --device 192.168.0.55
```

While this server runs, Makera's own controller cannot connect — the machine
accepts exactly one TCP client, which the server holds and shares between
browser tabs.

## The one blocker worth knowing

The cover interlock reports `unknown`, not `ok`. The cover bit lives in the
diagnose `E:` vector, which has eight elements on real firmware where every
published client maps six, so the field order may be shifted rather than
truncated. Establishing it needs an operator to trigger inputs one at a time —
see `MZ1-001/scripts/06-sensor-map.py`. Motion stays disabled until then.

## Topics

- cnc
- cli
- architecture
- frontend
- protocol
