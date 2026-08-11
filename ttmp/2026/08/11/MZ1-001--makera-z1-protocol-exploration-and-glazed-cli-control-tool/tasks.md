# Tasks

## Done — research and design

- [x] Create ticket MZ1-001 and add missing vocabulary topics
- [x] Clone the four reference implementations into `vendor/`
- [x] Read the community controller `protocols/` package in full
- [x] Specify the frame layout, CRC and packet types with file:line citations
- [x] Verify which upstreams actually implement the framed protocol (only the two GPL Python controllers)
- [x] Specify protocol autodetection (active probe + two passive switch triggers)
- [x] Enumerate the shell / GRBL / M-code command surface and the escaping rules
- [x] Specify the status `<…>` and diagnose `{…}` report grammars
- [x] Specify both file-transfer state machines, the MD5 policy and the Z1 placeholder quirk
- [x] Record Z1-specific facts (model string, rotary geometry, camera, unwired `config_z1.json`)
- [x] Experiment 01 — frame golden vectors cross-checked against upstream (PASS)
- [x] Experiment 02 — Go codec + adversarial RX state-machine tests (PASS)
- [x] Experiment 03 — discovery record parser self-test (PASS)
- [x] Experiment 04 — status/diagnose grammar decoder (PASS)
- [x] Capture upstream pages to `sources/web/` with docmgr frontmatter
- [x] Verify the Glazed APIs used in the design against the local checkout
- [x] Write the analysis / design / implementation guide
- [x] Write the wire protocol reference and the investigation diary
- [x] **Hardware session (read-only) against `Makera_Z1_012146`, fw `1.0.15.0.1.11`** — discovery, protocol detection, identity, status, diagnose, `help`, `ls`, `md5sum`, `get wcs|state|pos`, `progress`, `mem`
- [x] Experiment 05 — live read-only probe with an enforced command allowlist (`scripts/05-probe.py`)
- [x] Confirm the whole wire layer on real firmware: **zero decoder drops** across five sessions
- [x] Record the ~12 payload divergences in `reference/03-live-z1-observations-firmware-1-0-15.md` and cross-reference from `reference/02` and the design guide

## TODO — Phase 0: scaffolding (no hardware)

- [ ] Create `makera-z1-cli/` module, add `use ./makera-z1-cli` to `go.work`
- [ ] **Decide GPLv2-only vs GPLv2-or-later** (recommendation: or-later, design guide §3.5.2) — it goes in every file header, so settle it before there are file headers
- [ ] `LICENSE` (full GPL-2.0 text), `NOTICE` from design guide §3.6, README linking both and the four upstream projects
- [ ] `docs/protocol.md` — publish `reference/02-makera-wire-protocol-reference.md` as the spec the implementation follows
- [ ] Makefile, golangci-lint, `cmd/z1ctl/main.go` with cobra root
- [ ] Wire `logging.AddLoggingSectionToRootCommand` and the embedded help system
- [ ] Placeholder command so `z1ctl --help` works; `go build ./... && go vet ./...` clean

## TODO — Phase 1: codec and reports (no hardware)

- [ ] `pkg/makera/frame.go` — port `scripts/02-goframe/main.go`
- [ ] `pkg/makera/frame_test.go` — golden vectors + split/garbage/CRC/oversize cases
- [ ] `pkg/makera/status.go` — port `scripts/04-gostatus`, add typed `Status`/`Diagnose` and rotation-aware WCO. **Apply the `reference/03` corrections:** five-axis `MPos`/`WPos`, `G:` absent on stock firmware, space-padded values (`L:0, 0, 0, …`), `E:`/`OTA:` passthrough. Use the verbatim captures in `reference/03` §3–§4 as test fixtures
- [ ] `pkg/makera/wcs.go` — parse `get wcs` (`[current WCS: G54]` + 9 offsets, 5 components each); required because stock firmware omits the `G:` status key
- [ ] Parse `ls -e -s` per `reference/03` §5: split on whitespace runs, last two tokens are size and timestamp, trailing `/` marks a directory, timestamp is `YYYYMMDDHHMMSS` local
- [ ] Parse `md5sum` per `reference/03` §6: `line[:32]` is the digest (validate hex), `line[32:]` is the path — no separator
- [ ] `pkg/makera/escape.go` + round-trip tests
- [ ] `z1ctl proto encode|decode` commands

## TODO — Phase 2: discovery and read-only control (first hardware contact)

- [ ] `discovery.go` — UDP 3333 listener, 3 s sweep, dedupe by name
- [ ] `transport_tcp.go`, `client.go` (single reader goroutine, ModeControl), `detect.go`
- [ ] Commands: `discover`, `status`, `watch`, `exec`, `proto sniff`, `proto probe`
- [ ] Run `help`, `ftype`, `ls -e -s /sd/gcodes` on a real Z1 and answer the open questions in the diary §12

## TODO — Phase 3: file system and job control

- [ ] `filexfer.go` — upload/download state machines, `ModeTransfer`. **Port from the community controller** (`carveracontroller/XMODEM.py`, commit `777482a`) rather than re-deriving; add a provenance header naming the upstream file and its GPL-2.0 licence (ADR-008)
- [ ] Bulk-listing reassembly (`LOAD_INFO` → `LOAD_FINISH`)
- [ ] MD5 policy per ADR-007 (32 **hex** chars, not 32 chars)
- [ ] Commands: `fs ls|stat|get|put|rm|mv|mkdir|cat`, `config dump|get|set`
- [ ] Commands: `job play|pause|resume|abort|progress|run`, `gcode`, `realtime`
- [ ] `fakemachine` test double covering out-of-order blocks, FILE_RETRY, the Z1 MD5 placeholder, injected CRC errors

## TODO — Phase 4: USB and polish

- [ ] `transport_serial.go` (115200, 2 s post-open settle, 128-byte blocks)
- [x] **Confirm the diagnose `E:` field order on hardware** — done 2026-08-11. Appended, not shifted; cover is `E[5]` (1 = closed). Also confirmed `P[1]` tool setter and `I[0]` e-stop
- [x] `z1ctl doctor` cover interlock, backed by `Diagnose.CoverClosed()` with an explicit `known` return
- [ ] Glazed help pages, shell completions
- [ ] Validate `--protocol smoothie` end-to-end if a legacy machine is available

## TODO — decisions needed from a human

- [x] Licensing: **GPL-2.0**, matching the Carvera Community Controller; port from it with provenance headers, credit upstream, publish the spec (ADR-008, design guide §3.5–3.6, diary §11.1)
- [ ] Sub-decision: GPLv2-**only** vs GPLv2-**or-later** (recommendation: or-later — see Phase 0)
- [ ] Decide the licensing boundary for the future device control UI *before* that ticket starts: process boundary (`z1ctl --format json`) or a spec-derived permissive core (design guide §3.5.3)
- [ ] Review the safety rules in design guide §17, especially the commands gated behind an explicit flag
- [ ] Confirm the module path / repo name for `makera-z1-cli`
- [ ] Optional: ask the `hagmonk/carvera-cli` author to add a licence — the repo has none, so its code cannot be reused (diary §11.1)

## Deferred to separate tickets

- [ ] Z1 camera client (ESP32 WebSocket :82) — spec captured in design guide §9.7
- [ ] Firmware upload path (`/sd/firmware.bin` + `reset`)
- [ ] QuickLZ compression for uploads (ADR-005)
- [ ] Device control UI
