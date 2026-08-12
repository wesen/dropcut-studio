# Tasks

## Blocking — before any code

- [ ] **Safety review of design guide §3 (risk classification) and §11 (preflight)** by someone who operates the machine
- [ ] Settle the classification table in §3.1
- [x] Answer: does `play` take `-O` or `-v`?
- [x] Answer: does `$H X` (single-axis homing) work?
- [ ] Answer: which mechanism sets a work zero reliably?

## Phase 1 — Classification and dry run (no hardware)

- [x] Replace `motionVerbs` with the four-class table; keep existing safety tests green
- [x] `MotionRequest`, `Client.Motion`, and the preflight
- [x] `--dry-run` on every motion command, printing the exact frames
- [x] Extend `fakemachine_test.go`: scripted state sequences, jog keepalive tracking, `^Y` handshake, alarm injection, cover/e-stop reporting
- [x] Table-driven preflight tests, one per condition in §11.1
- [x] Test that unknown cover state refuses rather than proceeding

## Phase 2 — Jog and position (first motion)

- [x] `z1ctl jog` (step), `z1ctl goto`, `z1ctl park`
- [x] `z1ctl home` with its own confirmation
- [x] Continuous jog: `$J -c`, keepalive, `0x19` stop with `^Y` acknowledgement
- [ ] Hardware bring-up steps 1–9, air only, spindle disabled
- [ ] **Deliberately test the dead-man**: close the tab mid-jog, confirm the axis stops

## Phase 3 — Job control

- [x] `z1ctl job play|suspend|resume|abort|progress`
- [x] `z1ctl job run` composite — upload, verify, preflight, play, monitor
- [x] Halt handling using the reason table and its recovery bands
- [x] Exit codes: 0 complete, 1 usage/connection, 2 refused, 3 alarm
- [ ] Bring-up step 10: air-cutting program with the spindle off

## Phase 4 — The UI

- [x] Jog panel, press-and-hold, released on pointerup/cancel/leave/blur/visibilitychange
- [x] **Feed hold**: largest control, always enabled, keyboard-bound
- [x] Job panel: progress, pause, abort
- [x] WCS panel: read, select, zero-here with confirmation
- [x] Spindle behind a confirmation; accessories as plain toggles
- [x] Disabled states everywhere carry a reason
- [x] Server-side preflight on every mutating route — the browser is not trusted
- [x] Loopback binding by default; token and same-origin for non-loopback (ADR-012)
- [ ] Server owns the protocol keepalive; browser liveness rides the status poll (ADR-011)

## Phase 5 — Deferred to their own tickets

- [ ] Probing and auto-levelling (`M495`, `M495.3`, `M469.x`)
- [ ] Automatic tool change (`M6`)
- [ ] Resume-at-line
- [ ] Single-axis homing, if supported
- [x] REVISED ADR-011: keepalives forward 1:1 from the browser's held button; no server timer keeps motion alive (task 30 superseded by operator review) <!-- t:dv36 -->
