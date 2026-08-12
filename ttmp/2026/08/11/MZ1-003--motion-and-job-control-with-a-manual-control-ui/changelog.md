# Changelog

## 2026-08-11

- Created MZ1-003 for motion and job control plus a manual control UI. Design
  only; deliberately no code, so the design is settled before anything in it can
  move a machine tool.
- Established **four risk classes** to replace the single motion predicate that
  MZ1-001 used. That predicate produced a real bug — `time` was refused, so
  identity queries silently failed — and it cannot express that `M821` (light on)
  and `M3 S10000` (spindle at ten thousand RPM) are both M-codes. The classes are
  motion, state-enabling, accessory and data, plus **Class 0: commands that only
  stop things, which are never gated.**
- Identified the design's most useful property: continuous jog requires a
  keepalive, so **if the host stops sending it the machine stops moving.** That
  is a dead-man switch built into the firmware, and it is stronger than anything
  our software can provide because it depends on our software *stopping* rather
  than on it behaving correctly. The UI's job is to avoid defeating it.
- Specified the continuous-jog stop as a handshake rather than fire-and-forget:
  `0x19`, suppress keepalives immediately so they cannot fight the stop, wait for
  the firmware's `^Y`.
- Designed the manual control UI as the *safer test harness* rather than as a
  convenience: testing motion through a CLI means composing commands while
  standing next to a moving machine.
- Recorded the first genuine security question in the project: once the page can
  move the machine, an unauthenticated POST from anywhere on the LAN becomes a
  motion command. ADR-012 defaults the server to loopback, requires a token and
  same-origin otherwise.
- Stated plainly what the preflight **cannot** establish: the axis limit indices
  are inherited rather than verified, nothing knows whether a workpiece is
  clamped or the right tool is fitted, and the cover interlock is a sensor rather
  than a lock.
- Scoped out probing, tool change and resume-at-line, each of which deserves its
  own ticket.
- Wrote a hardware bring-up sequence that begins with a dry run and an air cut,
  and that includes deliberately verifying the dead-man on the real machine
  before anyone relies on it.

## 2026-08-11

Pre-implementation review: graded MZ1-001/002 work, found the Client command-serialisation gap, amended the design (typed MotionOps, classifier-owned risk class, jog lease)

### Related Files

- /home/manuel/workspaces/2026-08-11/cnc-control-dropcut/dropcut-studio/ttmp/2026/08/11/MZ1-003--motion-and-job-control-with-a-manual-control-ui/analysis/01-implementation-review-the-client-the-cli-and-the-mz1-003-design.md — The review


## 2026-08-11

Implemented Phases 1-4: risk-class safety core with typed MotionOps and preflight (3507195), 1:1 browser-held jog keepalives after operator overruled the lease design (9d50f54), full motion/job CLI with dry-run and exit codes (48255aa), manual control page with guarded mutation surface, loopback default and DNS-rebinding defence (9c6db2b). Hardware bring-up deliberately not run.

### Related Files

- /home/manuel/workspaces/2026-08-11/cnc-control-dropcut/dropcut-studio/makera-z1-cli/pkg/makera/motion.go — The authorised path


## 2026-08-11

Hardware bring-up finding: $J F is a scale of max_rate on stock firmware (F1..F1000 all ran at max, confirmed in stock SimpleShell::jog). Jog speed is now a percent of axis maximum across CLI/API/UI. Firmware source excerpts vendored; open questions answered from source: play takes -v only (no -O on stock), play-while-playing is refused by firmware, play silently no-ops when unhomed, $H X single-axis homing is supported by source.

### Related Files

- /home/manuel/workspaces/2026-08-11/cnc-control-dropcut/dropcut-studio/ttmp/2026/08/11/MZ1-003--motion-and-job-control-with-a-manual-control-ui/vendor/README.md — Firmware evidence provenance


## 2026-08-12

Bring-up incidents: feed hold had no exit (resume != cycle start; hold --release + /api/cycle-start added, b23a625); header shows homed state (31a2fd3); $H silently no-ops while unhomed — OPEN, Motion now surfaces machine reply text to diagnose it (3d03711). Vault report published (go-go-parc c3135d8). Diary steps 9-12.

### Related Files

- /home/manuel/workspaces/2026-08-11/cnc-control-dropcut/dropcut-studio/makera-z1-cli/pkg/makera/jobctl.go — CycleStart, the hold release

