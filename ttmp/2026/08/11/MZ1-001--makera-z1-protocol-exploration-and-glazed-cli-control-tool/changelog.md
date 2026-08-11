# Changelog

## 2026-08-11

- Initial workspace created.
- Cloned four reference implementations into `vendor/`: Carvera-Community
  Controller (`777482a`, = v2.2.0-RC1, the release that adds "Initial Z1
  support"), MakeraInc OEM controller, `hagmonk/carvera-cli`,
  `GridSpace/carve-control`.
- Reverse-specified the Makera wire protocol from upstream source with file:line
  citations: frame layout, CRC-16/CCITT (poly 0x1021, **init 0x0000**), the full
  packet-type table including the six file-transfer types, protocol
  autodetection, the command surface and escaping rules, the status and diagnose
  report grammars, and both file-transfer state machines.
- **Established that only the two GPL Python controllers implement the framed
  protocol.** `hagmonk/carvera-cli` and `GridSpace/carve-control` are
  legacy-text-only (verified: zero hits for `0x8668`) and cannot drive a Z1. This
  changed the recommendation from "port carvera-cli" to "implement from the
  Community Controller's specification".
- **Corrected two points in the upfront research:** `LENGTH` is `payload + 3`
  (it covers the type byte and the CRC), and the packet-type list was missing
  `0xB1`–`0xB6`, without which file transfer cannot be implemented.
- Added four passing offline experiments that make the specification executable:
  frame golden vectors cross-checked against upstream, a dependency-free Go codec
  with adversarial RX tests, a discovery-record parser, and a status/diagnose
  grammar decoder.
- Documented a **known desync limitation** shared with upstream: garbage
  containing `86 68` plus a plausible length makes the decoder swallow the frame
  behind it. Reproduced in `scripts/02-goframe`; mitigation is to log every
  footer/CRC drop.
- Documented the **Z1 MD5 firmware quirk**: `md5sum` returns
  `default_md5_hash_value_32_bytes_`, 32 characters but not hex, so integrity
  checks must validate hex digits and not just length (ADR-007).
- Wrote the intern-facing analysis / design / implementation guide (`design/01`),
  the terse wire protocol reference (`reference/02`) and the investigation diary
  (`reference/01`). Seven decision records; a five-phase implementation plan whose
  first two phases need no hardware.
- Verified every Glazed API used in the design against the local `glazed`
  checkout (`pkg/cmds/cmds.go`, `pkg/cmds/fields/field-type.go`,
  `pkg/cli/cobra.go`, `cmd/examples/new-api-build-first-command`).
- Captured four upstream pages to `sources/web/` with docmgr frontmatter.
- Added `vendor/` to `dropcut-studio/ttmp/.docmgrignore` so vendored upstream
  Markdown does not fail frontmatter validation; added `docTypes/design` and
  `topics/reference` to the vocabulary. `docmgr doctor --ticket MZ1-001` passes.
- Uploaded the bundle (index, design guide, protocol reference, diary, tasks,
  changelog) to reMarkable at `/ai/2026/08/11/MZ1-001`.
- **Licensing decided: `z1ctl` is GPL-2.0** (ADR-008), matching the Carvera
  Community Controller, with upstream credited in a `NOTICE` and the protocol
  specification published in the repository as `docs/protocol.md`. An MIT
  decision was taken and reversed earlier the same day; the MIT plan is retained
  in design guide §3.5.3 as the fallback if a permissive core is ever needed.
  Practical effect: upstream's file-transfer state machines may now be **ported**
  with provenance headers instead of re-derived — that is where the
  implementation risk was concentrated.
- **Two licence corrections found while verifying the clones:**
  `MakeraInc/CarveraController` is **GPL-3.0**, not GPL-2.0 (`COPYING` = GPLv3,
  README states it), which is incompatible with a GPLv2-only tree; and
  `hagmonk/carvera-cli` carries **no licence at all** — no `LICENSE`, no
  `license` field, no README statement — despite being described as MIT. Its
  ideas remain usable, its code does not.
- Flagged that GPL copyleft reaches the future device control UI: anything
  linking `pkg/makera` must be GPL. Mitigation is a process boundary
  (`z1ctl --format json`); decide before that ticket starts (design guide §3.5.3).
- Open sub-decision recorded: GPLv2-only vs GPLv2-or-later, recommendation
  or-later, to be settled in Phase 0 before file headers exist.
- **First hardware contact — read-only session against `Makera_Z1_012146`
  (`192.168.0.55`), firmware `1.0.15.0.1.11`.** Nothing was sent that could move
  the machine: `scripts/05-probe.py` enforces a read-only allowlist in code and
  refuses motion, job, file-write and config-write verbs before a byte reaches
  the socket; the only realtime byte permitted is `?`. The machine was still
  unhomed at the end of the session.
- **The entire wire layer is confirmed against real firmware: zero decoder drops
  across five sessions.** Frame layout (`LENGTH = payload + 3`), CRC-16/CCITT
  with init `0x0000`, the `0xA2` no-trailing-newline rule, `0xA1` realtime
  encoding, silence-means-makera protocol detection, and the echo sentinel all
  held. The probe implements framing from our own spec rather than importing
  upstream, so this validates the specification end to end.
- **About a dozen payload-format divergences found and recorded in the new
  `reference/03-live-z1-observations-firmware-1-0-15.md`**, which now outranks
  `reference/02` and the design guide wherever they disagree. The ones that
  change the design: `ftype = nc` (this firmware accepts **no** compressed
  uploads, making ADR-005 a fact rather than a trade-off); `MPos`/`WPos` carry
  **five** axes (X,Y,Z,A,B); the status report has **no `G:` key** on stock
  firmware so the active WCS must come from `get wcs`; two undocumented status
  keys (`E:`, `OTA:`); values can carry leading spaces (`L:0, 0, 0, …`);
  discovery and `model` each carry an extra trailing machine-state field;
  `md5sum` returns a **real** digest concatenated with the path; and `help` is
  incomplete but reveals a useful query family (`get pos|wcs|state`, `progress`,
  `mem`, `net`).
- **Flagged as blocking a safety feature:** the diagnose `E:` vector has **8**
  values on real firmware where upstream maps 6, so the field order may be
  shifted rather than truncated. The `z1ctl doctor` cover interlock (design guide
  §17.2) must not be implemented until the mapping is confirmed by opening the
  cover and diffing a capture.
- The generic "decode to a map first, interpret second" report design was
  vindicated on first hardware contact — the two undocumented keys arrived as
  data rather than as parse failures.
- Added `scripts/05-probe.py` (live read-only probe) and answered five of the
  seven open questions; four new ones opened, all recorded in diary §12.

## 2026-08-11

Implemented the Go library, the z1ctl CLI and the hardware control page (commits 6d89caf, e84d59f, 81d775d); backfilled the diary at reference/04-diary.md

