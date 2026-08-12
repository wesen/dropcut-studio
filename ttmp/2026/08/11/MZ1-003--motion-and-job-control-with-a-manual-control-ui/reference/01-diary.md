---
Title: Diary
Ticket: MZ1-003
Status: active
Topics:
    - cnc
    - protocol
    - cli
    - safety
DocType: reference
Intent: long-term
Owners: []
RelatedFiles:
    - Path: repo://ttmp/2026/08/11/MZ1-003--motion-and-job-control-with-a-manual-control-ui/analysis/01-implementation-review-the-client-the-cli-and-the-mz1-003-design.md
      Note: Step 1's deliverable — the pre-implementation review whose amendments drive the code
    - Path: repo://makera-z1-cli/cmd/z1ctl/cmds/motionrun.go
      Note: The one CLI path to motion (Step 4, commit 48255aa)
    - Path: repo://makera-z1-cli/pkg/makera/motion.go
      Note: Typed ops, Motion, JogSession incl. manual keepalive mode (Steps 2-3)
    - Path: repo://makera-z1-cli/pkg/makera/preflight.go
      Note: The $11.1 preflight (Step 2)
    - Path: repo://makera-z1-cli/pkg/makera/safety.go
      Note: Risk classes and Classify (Step 2, commit 3507195)
    - Path: repo://makera-z1-cli/pkg/webui/motion.go
      Note: Guarded mutation surface and 1:1 jog forwarding (Step 5, commit 9c6db2b)
ExternalSources: []
Summary: Chronological implementation diary for MZ1-003 — motion and job control with a manual control UI.
LastUpdated: 2026-08-11T23:59:00-04:00
WhatFor: Recording each implementation step, its failures and its open questions, so review and continuation need no terminal history.
WhenToUse: Read before resuming work on MZ1-003; update after every substantive step.
---


# Diary

## Goal

Capture the implementation of MZ1-003 — motion and job control in `z1ctl` plus
the manual control UI — step by step: the pre-implementation review, the safety
core, jog and job control, the web surface, and everything that went wrong on
the way.

## Step 1: Pre-implementation review of the existing work and the design

Before writing motion code, I reviewed everything it will stand on: the ~4,000
lines of `pkg/makera`, the 14 CLI commands, the read-only web server, and the
MZ1-003 design guide itself. The result is the review document in
`analysis/01-implementation-review-the-client-the-cli-and-the-mz1-003-design.md`,
which both grades the existing work and amends the design in three places
before implementation begins.

The headline findings: the foundation is sound (single-reader ownership,
refusal-before-socket, generic report decode, the honest `known` contract), but
the `Client` does not serialise concurrent command exchanges — harmless today,
load-bearing the moment a server-owned jog keepalive shares the connection
with a browser status poll. And the design's `MotionRequest{Commands []string}`
does not actually deliver the structural guarantee its own prose claims, so
implementation switches to typed `MotionOp` constructors with unexported
rendering, and moves risk-class authority from the caller into the ops.

### Prompt Context

**User prompt (verbatim):** "Implement the MZ1-003 ticket, keeping a detailed diary as you work (see the diary format in the diary skill), and committing at appropriate intervals.

First, review all the work done by your colleague and assess how good it is, what you would address, what you think is good, what you think is more questionable, alternative designs/proposals, etc...

Create  a detailed analysis / design / implementation review that is for a new intern, explaining all the parts of the system needed to understand what it is, with prose paragraphs and bullet point sand pseudocode and diagrams and api references and file references. It should be very clear and technical. Store in the ticket and the nupload to remarkable."

**Assistant interpretation:** Two deliverables in sequence: (1) an intern-facing
review of all prior z1ctl work and the MZ1-003 design, stored in the ticket and
uploaded to reMarkable; (2) the actual MZ1-003 implementation (motion core, CLI
commands, manual control UI), with a running diary and periodic commits.

**Inferred user intent:** Get a second set of eyes on the safety-critical design
before it hardens into code, then get the motion feature built — with the
review's corrections applied rather than merely filed.

### What I did

- Read the full MZ1-003 design guide (~1,000 lines) and the core sources:
  `client.go`, `protocol.go`, `report.go`, `halt.go`, `safety.go`, `webui.go`,
  `serve.go`, `unlock.go`, `transport.go`, `fakemachine_test.go`,
  `static/app.js`.
- Wrote the review document: architecture survey, six defect/gap findings
  (§6), three design amendments (§7.1–7.3), additions the design missed
  (§7.4, notably DNS-rebinding via Host-header validation), the adjusted API
  (§8), and prioritised recommendations (§9).
- Created this diary.

### Why

- Motion is the first work where the worst bug is physical. A design review
  *before* implementation is the cheapest point to fix an architecture-level
  mistake, and the design itself lists a review as a blocking prerequisite.

### What worked

- Reading the code with the design side by side surfaced a concurrency gap
  (no command mutex in `Client`) that neither document mentions and that the
  jog keepalive would have turned into intermittent, hard-to-reproduce status
  corruption.
- The typed-op amendment fell directly out of asking "can the claim in §10.2
  actually be enforced by this type?" — it could not.

### What didn't work

- N/A — analysis step; no code executed beyond reading and `git log`.

### What I learned

- The existing `EncodeRealtime` already concatenates multiple realtime frames
  into one buffer, so the one-write keepalive digram requirement is satisfied
  end to end without new transport work.
- `AssertRealtimeAllowed` currently refuses `!` (feed hold). Correct for the
  read-only tool, but it must flip in Phase 1: Class 0 is implemented in
  `safety.go`, not just stated in the design.
- Jogging while unhomed must stay permitted — `$J` is relative motion and is
  how an operator repositions an unhomed machine; the preflight only gates
  work-coordinate moves on homing.

### What was tricky to build

- Judging the drop-on-full policy in `readLoop` (client.go:214-224). It looks
  like a defect (it can discard a command's sentinel under backpressure), but
  it is also what keeps status current, which the jog keepalive depends on. The
  resolution: keep the policy, add one exception — never discard a message
  containing the sentinel byte — and rely on the new command mutex to prevent
  the mixed workload that makes the race likely.

### What warrants a second pair of eyes

- The three design amendments (§7.1–7.3 of the review) override the signed
  design document. They are argued in detail, but they are exactly the kind of
  change that should be checked by the machine's operator alongside the §3/§11
  safety review the design already requires.
- The claim in §7.4 that `play`-while-playing can be resolved client-side by
  the preflight, without knowing the firmware's behaviour.

### What should be done in the future

- Implement Phases 1–4 per the review's §9 ordering (this session).
- Hardware bring-up (design §14.4) with an operator present — not this
  session; no motion command will be sent to the real machine without the
  user's explicit go.

### Code review instructions

- Start with the review document itself, §6 and §7.
- Cross-check §6.1 against `pkg/makera/client.go:263-311` and §7.1 against the
  design guide's §10.2.

### Technical details

- Review doc: `analysis/01-implementation-review-the-client-the-cli-and-the-mz1-003-design.md`.
- Repo state at review time: `dropcut-studio` @ `c200fed`, uncommitted
  `makera-z1-cli/go.mod` replace-path fix from the repo merge.

## Step 2: Motion core — risk classes, typed ops, preflight, dead-man session

The safety layer went first, before any command that could use it. The single
`motionVerbs` predicate became `Classify(cmd) RiskClass` with six ordered
classes, and — the deliberate behaviour change — stops became ungated
everywhere: `suspend`, `abort`, bare `!`, `M5` and `M9` now pass every path,
and the realtime guard admits `!` and `0x19`. Motion became typed
`MotionOp` constructors (review amendment A) gated by the maximum class over
a request (amendment B), with a fresh preflight implementing the design's
§11.1 table.

Continuous jog landed as `JogSession`: a 200 ms `?`+`0x1A` keepalive in one
write, the `0x19`/`^Y` stop handshake with keepalives suppressed first, and
the dead-man proven in tests — the fake machine expires a jog whose
keepalives cease, which is the one property a real machine cannot be asked
to demonstrate.

### Prompt Context

**User prompt (verbatim):** (see Step 1)

**Assistant interpretation:** Phase 1 of the implementation proper.

**Inferred user intent:** The safety architecture in code, testable offline.

**Commit (code):** 3507195 — "Motion core: risk classes, typed ops, preflight, jog dead-man session"

### What I did

- Rewrote `pkg/makera/safety.go` around `RiskClass` and `Classify`; updated
  `safety_test.go` to pin the new boundaries, including
  `TestStopsAreNeverRefused`.
- Added `motion.go` (ops, `MotionRequest`, `DryRun`, `Client.Motion`,
  `JogSession`), `preflight.go`, `jobctl.go`.
- Fixed the review's §6.1–6.3 findings in `client.go`: a command mutex
  serialising every drain→write→collect exchange (realtime bypasses it), an
  overflow policy that never drops a completion sentinel, and
  `awaitReport` parsing candidates instead of pattern-matching `<`.
- Extended the fake machine with the control path: status/diagnose replies,
  scripted alarm and playing states, jog tracking with a dead-man window,
  the `^Y` handshake, and canned echo replies.
- 28 new tests; all pass under `-race` on the first full run.

### Why

- The jog keepalive makes client concurrency load-bearing (three actors on
  one connection), so the mutex had to precede the feature that needs it.

### What worked

- The typed-op design fell together cleanly: `render`/`class`/`requiresHomed`
  unexported, constructors validating before any connection exists, dry-run
  as a pure function over the same rendering.

### What didn't work

- First version of `TestDeliverNeverDropsTheSentinel` asserted the sentinel
  stayed at the HEAD of the channel; the fix re-queues it at the tail, so
  the assertion had to scan. Ordering after an overflow rescue is
  documented as best-effort.

### What I learned

- Upstream encodes continuous jog direction as a signed 1 (`$J -c X-1`),
  confirmed in the pendant add-on (`pendant.py:518`), not as a bare sign.
- The firmware also emits "Stop request timeout" / "Internal stop request
  reset" lines that clear jog state — the read loop treats them as
  ack-equivalent.

### What was tricky to build

- The stop handshake ordering: keepalives must be provably gone before
  `0x19` goes out (cancel + wait on the emitter's done channel), and the ack
  channel must be registered before the stop byte or the `^Y` can land in
  the gap. Ack detection lives in the read loop so the waiter never
  competes with a command exchange for messages.

### What warrants a second pair of eyes

- `M5`/`M9` as Class 0 deviates from the design's table (which filed M5
  under the spindle's Class 1 row) on the principle that a stop that can be
  refused is not a stop. Flagged for the operator safety review.
- The sanity bounds in `motion.go` (1000 mm jog, 10000 mm/min, 20000 rpm)
  are unit-mistake catches, not an envelope model; the firmware owns limits.

### What should be done in the future

- Hardware bring-up per design §14.4, operator present.

### Code review instructions

- Start at `pkg/makera/safety.go` (`Classify`) and `motion.go`
  (`JogSession.stop`). Validate with
  `go test ./pkg/makera/ -count=1 -race`.

### Technical details

- Dead-man test: `TestJogDeadman` abandons the session (as a crash would)
  and asserts the fake's jog expires with no stop byte sent.

## Step 3: The keepalive design reversed — the held button drives the chain

The user reviewed the jog keepalive design mid-implementation and overruled
ADR-011/the review's lease amendment: *"I don't think the server should hold
the jog state, isn't the jog to be there exactly to have a human hold a
button and control and fail safe?"* — followed by *"it would also reduce a
lot of the complexity on the server side, with its jog holding loop."*

They are right, and the argument generalises: a server timer that keeps
motion alive is a mechanism whose bugs fail toward CONTINUING; a server that
only forwards keepalives 1:1 has no such mechanism, so every bug fails
toward stopping. That is the correct asymmetry for a dead-man, and it
deleted the lease, the watchdog and the server-side timer in one stroke.

### Prompt Context

**User prompt (verbatim):** "I don't think the server should hold the jog state, isn't the jog to be there exactly to have a human hold a button and control and fail safe?"

**Assistant interpretation:** Challenge to the server-owned keepalive (ADR-011
and review §7.3): the human's held button should be the liveness source.

**Inferred user intent:** Keep the dead-man chain anchored to the operator's
finger; simplify the server.

**Commit (code):** 9d50f54 — "Jog keepalives forward 1:1; the held button is the dead-man end to end"

### What I did

- Added `JogStartManual` + `JogSession.Keepalive()` (one call, one `?`+`0x1A`
  write; refused once a stop begins); the CLI keeps the timer variant since
  there the process itself is the held button.
- Revised review §7.3 in place with the operator's argument and kept the
  lease text below it as the road not taken.
- Test: `TestManualJogForwardsKeepalivesOneToOne` — exactly N writes for N
  calls, dead-man on cessation with no server involvement, keepalive refused
  after stop.

### Why

- Failure asymmetry: forwarding fails safe by construction; a lease fails
  safe only if its expiry logic is correct.

### What worked / What didn't work

- Clean refactor; nothing failed. The web server later needed no jog loop at
  all — start, forward, stop, three handlers.

### What I learned

- The browser cannot reach the machine anyway (single TCP connection held by
  the server), so "browser owns the keepalive" costs one HTTP POST per
  keepalive and nothing else. Background-tab throttling stalls the POSTs,
  which stops the axis: annoying, safe, honest.

### What was tricky to build

- Nothing mechanical; the tricky part was noticing the original design was
  optimising timing robustness at the expense of failure direction.

### What warrants a second pair of eyes

- The 150 ms browser POST cadence against the firmware's (unmeasured)
  keepalive window — bring-up step 7 observes it on hardware.

### What should be done in the future

- N/A beyond bring-up.

### Code review instructions

- `pkg/makera/motion.go` (`JogStartManual`, `Keepalive`), review §7.3.

## Step 4: The CLI — every motion command through one auditable runner

Phases 2 and 3 in one pass: `jog` (step and bounded continuous), `home`,
`goto`, `park`, `spindle`, `accessory`, `hold`, `preflight`, and the `job`
group with the fail-closed `run` composite. One shared runner
(`cmd/z1ctl/cmds/motionrun.go`) implements the uniform flow — `--dry-run`
renders commands and frames without opening a connection, `--confirm` gates
state-enabling and above, execution goes through `Client.Motion` — so a
reviewer audits one function instead of eight commands.

### Prompt Context

**User prompt (verbatim):** (see Step 1)

**Assistant interpretation:** The CLI surface from design §16 Phases 2–3.

**Inferred user intent:** Operable motion commands, offline-verified, hardware
bring-up deferred.

**Commit (code):** 48255aa — "CLI: jog, home, goto, park, spindle, accessory, hold, preflight, job group"

### What I did

- Nine new commands; `main.go` exit codes 0/1/2/3 mapped from typed errors
  (`ErrPreflightFailed`, `ErrMotionNotAuthorised`, new `ErrJobEndedInAlarm`).
- Smoke-tested dry runs: `jog X 10 --feed 600 --dry-run` prints
  `$J X10 F600` with the exact frame bytes; an unconfirmed jog refuses with
  exit 2.

### Why

- The design's §14.3: dry run is how understanding is checked before the
  machine is involved.

### What worked

- Frame length in the dry-run output (`00 0e` for an 11-byte payload)
  matches the LENGTH = 1 + payload + 2 rule from MZ1-001 — a nice cross-check
  that rendering goes through the same `BuildFrame` as the live path.

### What didn't work

- N/A — this layer is thin by design.

### What was tricky to build

- `goto`'s axis flags: `--x 0` is indistinguishable from an unset flag, so
  each axis has an explicit `--x-set` presence flag. Ugly but honest;
  a positional syntax can replace it later.

### What warrants a second pair of eyes

- CLI continuous jog exists at all (`--continuous --for ≤5s`). It is
  bounded and confirmatory, but the web page is the right tool; if the
  operator thinks the CLI form invites misuse, delete it.

### What should be done in the future

- Bring-up; `wcs zero` remains marked unverified pending the G10 L20 open
  question.

### Code review instructions

- `cmd/z1ctl/cmds/motionrun.go` first, then `job.go`'s `run` composite.
- `go run ./cmd/z1ctl <cmd> --dry-run` for any motion command.

## Step 5: The control page grows hands — and a guarded server

Phase 4: the read-only page became the pendant. Server side, fourteen POST
routes behind one `guardMutation` (Host validation against DNS rebinding,
same-origin, token when remote), single-flight motion with 409 on overlap,
fresh preflight on every motion route, and `serve` now binds loopback by
default with `--allow-remote` as the deliberate exception (ADR-012 plus the
review's Host-check addition — unit-tested without hardware). Jog is three
trivial handlers: start, forward-one-keepalive, stop.

Page side: press-and-hold jog bound to pointerup/cancel/leave/blur/
visibilitychange, FEED HOLD never disabled and bound to Escape, two-step
arm-to-fire on HOME/PLAY/RESUME/zero/spindle-start (not a dialog — dialogs
train dismissal), disabled controls always carrying their reason, and the
footer stating plainly that the physical e-stop is the real one. Verified in
a real browser against an unreachable device: correct disconnected
behaviour, gating reasons, zero JS errors.

### Prompt Context

**User prompt (verbatim):** (see Step 1; keepalive revision in Step 3)

**Assistant interpretation:** Design §12–13 with the review amendments.

**Inferred user intent:** The safer test harness for the hardware bring-up.

**Commit (code):** 9c6db2b — "Manual control page: jog pendant, job control, guarded mutation surface"

### What I did

- `pkg/webui/motion.go` (guards + handlers), `webui.go` (routes, jog
  bookkeeping cleared on session drop — review §6.5), `serve.go` (ADR-012),
  full rewrite of `static/` assets, `webui_test.go` for the guards.
- Playwright smoke test; fixed the jog pad grid (X+ had landed under Z+
  instead of forming the XY cross).
- Fixed a mislabelled dial error the user caught during the smoke test:
  every dial failure claimed "machine busy"; now only `ECONNREFUSED`
  suggests it, phrased as likely (`transport.go`).

### Why

- Once the page can move the machine, an unauthenticated POST from the LAN
  IS a motion command; the server had to grow its security posture in the
  same commit as its first mutating route.

### What worked

- The 1:1 keepalive design made the server's jog surface almost stateless —
  the entire "jog holding loop" the original design needed simply does not
  exist.

### What didn't work

- First screenshot showed the jog pad misaligned (grid-area layout bug);
  fixed and re-verified.
- A `find /` while locating the screenshot annoyed the user, rightly. The
  playwright plugin writes to the workspace root.

### What was tricky to build

- The gating split: machine-state gates (jog disabled while a job runs)
  versus HTTP-security gates (token, origin). Stops skip the former and
  keep the latter — authentication is not gating.

### What warrants a second pair of eyes

- `guardMutation`'s origin check accepts requests with no Origin header
  (curl and same-origin GET-form navigations do not send one); the token
  covers the remote case, but a security review should confirm the
  loopback-trust posture.
- The unlock route reimplements the CLI unlock's preflight checks; the two
  should not drift.

### What should be done in the future

- Hardware bring-up §14.4, including deliberately killing the tab mid-jog
  (step 7) with an operator at the machine.
- WCS panel currently zeroes G54 only; system selection is a follow-up.

### Code review instructions

- `pkg/webui/motion.go` top comment, then `guardMutation`, then the jog
  handlers. `go test ./pkg/webui/ -count=1`. For the page,
  `z1ctl serve --device <ip>` and read `static/app.js`'s header comment
  first.

### Technical details

- Screenshots from the browser smoke test:
  `../../dropcut-control-disconnected.png`, `dropcut-control-v2.png`
  (workspace root).

## Step 6: Connection settings from the environment, the framework way

The user asked whether the machine address could be passed manually because
discovery is slow, then steered the solution: no device cache — use glazed's
env middleware instead. `parserOptions` now supplies a custom chain that adds
`FromEnv("Z1CTL")` wrapped in `WrapWithWhitelistedSections([connection])`, so
`Z1CTL_DEVICE` and the other connection knobs load uniformly from the
environment while nothing else does.

### Prompt Context

**User prompt (verbatim):** "can we pass the ip address of the server manually? do we keep track of it with z1ctl serve? because discovery is slow" — then "like as environment variable using glaed framework env middleware or so? (see `glaze help --all` if necessary)" — then "wait we don't need the cache, env variable is fine"

**Assistant interpretation:** Kill the 3-second discovery sweep for repeat use;
prefer the framework's env loading over bespoke mechanisms; drop the
half-built device cache.

**Inferred user intent:** One idiomatic mechanism, less code.

**Commit (code):** 3defae2 — "Load connection settings from the environment via glazed, whitelisted"

### What I did

- Replaced the hand-rolled `os.Getenv("Z1CTL_DEVICE")` with the built-in env
  source (`root.go:z1ctlMiddlewares`); deleted the device cache mid-flight on
  the user's call.

### Why / What was tricky to build

- The built-in chain (`AppName`) env-loads EVERY section, which would have made
  `Z1CTL_CONFIRM=true` in a shell profile silently satisfy `--confirm` on
  motion commands. The whitelist wrapper closes that: env applies to the
  connection section only, structurally.

### What worked

- Verified empirically: `Z1CTL_DEVICE=10.9.8.7 z1ctl status` dials 10.9.8.7
  with no sweep; `Z1CTL_CONFIRM=true z1ctl jog X 1 --device …` still exits 2.

### What warrants a second pair of eyes

- If a future section ever needs env loading, it must be ADDED to the
  whitelist deliberately — the comment on `z1ctlMiddlewares` says why the
  default section never goes in.

### Code review instructions

- `cmd/z1ctl/cmds/root.go` (`z1ctlMiddlewares`), `connection.go` (`Resolve`).

## Step 7: The F word means something else — jog speed becomes a percentage

During bring-up the user jogged X-10 at F10, F1, F1000 and F300 and reported
all four moves ran at the same speed. The logs corroborated: a 2-second F300
move showed `Idle` 200 ms after send; only F1000 was ever caught in `Run`.
Cloning the STOCK firmware settled it: `SimpleShell::jog` reads F as a scale
of max_rate — `F0.5` is half speed, anything >= 1 is maximum. The community
firmware later redefined F as mm/min and moved the scale to S, which is why
the reference controller (and our code, copied from it) sent mm/min values
that all silently meant "maximum".

Jog speed is now a percent of the axis maximum everywhere — `--speed 25`
renders `$J X10 F0.25` — and the same firmware reading answered three open
questions for free.

### Prompt Context

**User prompt (verbatim):** "These all seem to go at the same speed?" (with four jog logs at F10/F1/F1000/F300)

**Assistant interpretation:** The F parameter is not behaving as a feedrate;
find out what it actually does before shipping a wrong unit.

**Inferred user intent:** Jog speed control that actually controls speed.

**Commit (code):** (this commit) — jog speed as percent of max; firmware evidence vendored

### What I did

- Cloned stock (`MakeraInc/CarveraFirmware` @ 1683b6f) and community
  (`Carvera-Community/Carvera_Community_Firmware` @ 9ac0123) firmware; read
  `SimpleShell::jog`, `Player::play_command`, `Endstops::process_home_command`.
- Changed `StepJog`/`ContinuousJog`/`JogStart*` to take speed as percent of
  max; render `F<pct/100>`; CLI flag `--feed` became `--speed`, the page's
  feed box became "speed %" (default 25), API field `speed_pct`.
- Trimmed the 68 MB of clones to 444 KB of cited files + provenance README
  (`vendor/README.md`).
- Recorded the finding as MZ1-001 observations §11; corrected the design
  guide's §4.1 example in place with a dated note.

### What I learned (beyond the F semantics)

- Stock `play` takes only `-v` (verbose); `-O` is community-only. Open
  question 1: answered — send no flag.
- `play` while playing is refused by firmware: "Currently printing, abort
  print first". Open question 7: answered.
- **`play` on an unhomed machine silently returns** — no error line at all.
  Our preflight requiring homed for play is not just correct, it is the only
  source of an error message.
- Single-axis homing is supported by stock source (axis letters parsed in
  `process_home_command`). Open question 2: answered from source; still to be
  exercised on the machine before `home --axis` is exposed.

### What was tricky to build

- The misleading evidence chain: the reference controller's UI offers
  100–2000 mm/min jog speeds and sends them as F values — perfectly correct
  against COMMUNITY firmware, silently "always max" against stock. Reading
  the controller was not enough; only the firmware said the truth. Third
  instance of "observation outranks citation" in this project.

### What warrants a second pair of eyes

- The speed-% unit choice: an operator used to mm/min may prefer it; percent
  is what the firmware implements, but the UI copy should make sure nobody
  reads "25" as mm/min.
- If community firmware is ever supported, jog must emit `S<frac>` there,
  never `F<frac>` (which community reads as 0.25 mm/min). Noted in
  `renderJogSpeed`'s comment.

### Code review instructions

- `pkg/makera/motion.go` (`renderJogSpeed` comment block), MZ1-001
  observations §11, `vendor/README.md` for the source citations.
- `go run ./cmd/z1ctl jog X-10 --speed 10 --dry-run` → `$J X-10 F0.1`.

## Step 8: JogSpeed grows both units; the dialect check picks the encoding

The user asked whether we detect stock vs community firmware for the speed
handling, then set the interface: `--speed-scale` (0-1, the firmware's own
unit) and `--feed` (mm/min) as separate flags. `JogSpeed{Scale, FeedMMMin}`
now carries the intent; the dialect — detected from the version string, one
cached `version` query when needed — picks the encoding: scale renders `F` on
stock and `S` on community; feed renders `F` on community and is REFUSED on
stock, which cannot express it. Full speed renders no word and skips the
version probe entirely.

### Prompt Context

**User prompt (verbatim):** "do we check for stock vs opensource for properly handling --feed ?" — then "can we call the flag --speed-scale (0-1) then, and show that in the doc? also, if using the opensource firmware, we should be able to use --feed, right?"

**Assistant interpretation:** Make the dialect handling explicit and complete:
both units, each valid exactly where the firmware can express it.

**Inferred user intent:** No unit ever silently means something else.

**Commit (code):** (this commit)

### What was tricky to build

- Dry runs have no machine, hence no dialect. `JogSpeed.canonical()` renders
  the only dialect that can express the speed (community for feed, stock for
  scale), so `--feed 600 --dry-run` shows `F600` even against a stock
  machine — the refusal happens at send time, when the dialect is known.

### What warrants a second pair of eyes

- The community-side encodings (`S0.25`, `F600`) are tested against the fake
  and the community source, not against a community machine — none is
  available here.

### Code review instructions

- `pkg/makera/motion.go`: the dialect table comment, `JogSpeed.word`,
  `TestJogSpeedDialects` in motion_test.go.

## Step 9: Third vault report — the motion phase written up

Wrote the phase's deep-dive report into the go-go-parc Obsidian vault as the
third note in the Makera series: the risk classes and the one absolute rule,
the typed-op architecture, the dead-man chain with the operator's
failure-asymmetry argument quoted as the reason the lease design was deleted,
and the `$J` F-word discovery framed as a case study in observation
outranking citation.

### Prompt Context

**User prompt (verbatim):** "write a detailed project report for the obsidian vault as a deep dive technical analysis blog post using a textbook writing style (no analogies, see skill).
 Commit and push the bsidian vault when done (go-go-parc vault)."

**Assistant interpretation:** Same shape as the two earlier reports — durable
PROJ note, textbook prose, mermaid diagrams, no analogies — covering MZ1-003.

**Inferred user intent:** Keep the vault's record of the project current at
each phase boundary.

**Commit (vault):** go-go-parc c3135d8 — "docs(makera-z1): report the motion phase — dead-man chain, risk classes, $J dialect finding"

### What I did

- `Projects/2026/08/12/PROJ - Makera Z1 Control - Crossing into Motion.md`,
  wikilinked to the two prior notes; committed only the note, pushed.

### What should be done in the future

- N/A — the note carries its own open-questions section.

### Code review instructions

- Read the note's "Working rules" section; it is the distilled contract.

## Step 10: The hold with no exit — feed hold is not suspend

Live incident during bring-up: the user sent a feed hold, then could not get
out of it. The page's RESUME (which sends the `resume` command) answered
`{"ok":true}` and did nothing; the machine light blinked in Hold. A second
datapoint arrived mid-diagnosis: spindle STOP returned
`{"ok":true,"sent":["M5"],"state_after":"Hold"}` — accepted, state unchanged.

Both observations have one explanation. In this firmware, `suspend`/`resume`
are the Player module's job-pause pair, while a feed hold (`!`) is a
different mechanism released only by the realtime cycle start (`~`). And
during a hold, queued G-code — the M5 included — is accepted but not
executed; it runs the moment the hold is released. The library had
`Client.CycleStart()` from Phase 1, but nothing exposed it: a hold was a
one-way door.

### Prompt Context

**User prompt (verbatim):** "so I sent a feed hold but i can't seem to resume out of it. 

Response for status: {\"connected\":true,\"state\":\"Hold\",\"homed\":false,\"machine\":[-1,-1,-1,0,0],\"work\":[189.52,192.73,77.1609,-90,0],\"feed\":{\"Current\":0,\"Target\":2000,\"Override\":100},\"spindle\":{\"Current\":0,\"Target\":10000,\"Override\":100},\"tool\":2,\"tlo\":0.054,\"playing\":null,\"drops\":0,...}

---

when sending resume: {\"ok\":true}

---

light is blinking" — followed mid-work by: "If I say, stop the spindle, I get: {\"ok\":true,\"sent\":[\"M5\"],\"state_after\":\"Hold\"}"

**Assistant interpretation:** The machine is stuck in Hold; our resume path
sends the wrong mechanism's counterpart.

**Inferred user intent:** A working way out of feed hold, and a UI that does
not lie about it.

**Commit (code):** b23a625 — "hold --release: a feed hold is released by cycle start, not 'resume'"

### What I did

- Confirmed in the vendored stock Player source that `resume` pairs with
  `suspend`, not with feed hold.
- Exposed cycle start on all three surfaces: `z1ctl hold --release
  --confirm`, `POST /api/cycle-start`, and the page's RESUME button now
  routes by state — `Hold` → cycle start, suspended job → `resume`.
- Release requires confirmation everywhere, with the reason stated: it is
  NOT a stop — the frozen motion resumes and everything queued behind the
  hold executes immediately.
- Fake machine: `~` transitions Hold → Idle; `TestHoldAndCycleStart` pins the
  pairing.

### Why

- Class 0 reasoning cuts both ways: engaging a hold is never gated, and
  releasing one is gated precisely because it restarts motion.

### What worked

- The user's M5 datapoint arrived mid-fix and slotted straight into the
  model: it was the queued-command behaviour, observed live.

### What didn't work

- The original UI copy ("RESUME continues the held motion") pointed the
  operator at a button that could not work. Corrected to say what release
  does and to warn about the queue.

### What I learned

- The hold/queue interaction is the sharpest operator trap so far: every
  command sent during a hold looks accepted and does nothing until release.
  The gating message now says "stand clear" for exactly this reason.

### What warrants a second pair of eyes

- Whether `job abort` reliably flushes a held queue (offered to the operator
  as the cautious alternative to release); exercised on this machine only
  informally.

### Code review instructions

- `pkg/makera/jobctl.go` (`CycleStart`), `cmd/z1ctl/cmds/outputs.go`
  (`HoldCommand`), `pkg/webui/motion.go` (`handleCycleStart`),
  `app.js` (RESUME routing).

## Step 11: Homed state in the header

Small UI change on request: the header status line now reads
`connected · Idle · homed ✓` (green) or `· not homed` (amber). The DRO footer
and the Checks tab already carried the information; the header is where the
operator's eyes are, and the original design mockup had it there all along.

### Prompt Context

**User prompt (verbatim):** "Can I see if the machine is homed in the UI?"

**Assistant interpretation / intent:** Surface homing state at a glance.

**Commit (code):** 31a2fd3 — "Header shows state and homed at a glance"

### What should be done in the future

- N/A.

## Step 12: `$H` silently does nothing — OPEN

With the machine unhomed (it lost its reference at some point around the
hold episode — `MPos -1,-1,-1`), both the page's HOME and `z1ctl home
--confirm` return ok with `state_after: Idle` immediately and the machine
never moves. A real homing cycle takes tens of seconds and reports `Home`
while running, so `$H` is being accepted and no-opped, the same shape as
`play`-while-unhomed.

Source reading so far (stock SimpleShell + Endstops): `$H` prints `ok`
unconditionally and maps to a homing cycle in BOTH firmware modes (grbl mode
→ `G28.2`, non-grbl → `G28`, both reaching `process_home_command`), so the
dispatch is not the explanation. Inside the homing handler the plausible
silent exits are talkative — notably `WARNING: Nothing to home` — which
exposed the real defect on our side: `Motion` was DISCARDING the machine's
reply text. This firmware's consistent style is to explain refusals in prose
while still printing ok, and we were throwing the prose away.

### Prompt Context

**User prompt (verbatim):** "it marks unhomed in the UI even if I just clicked HOME

{\"ok\":true,\"sent\":[\"$H\"],\"state_after\":\"Idle\"}

---

Status is still: 

{\"connected\":true,\"state\":\"Idle\",\"homed\":false,\"machine\":[-1,-1,-1,0,0],...}

afterwards" — followed by the same result from `z1ctl home --confirm` on the CLI.

**Assistant interpretation:** `$H` is accepted and silently ignored; find out
why, and stop swallowing whatever the machine says about it.

**Inferred user intent:** A machine that homes, or at least a tool that
reports why it will not.

**Commit (code):** 3d03711 — "Motion surfaces the machine's reply text"

### What I did

- Read the stock `$H` dispatch (fetched `GcodeDispatch.cpp` and the full
  `SimpleShell.cpp` grbl-command block from the stock repo) and the homing
  handler's early exits.
- Added `MotionResult.Replies`: every reply line a motion command produces is
  now captured and surfaced — a `reply` column in the CLI table,
  `replies[]` in the web API responses.

### What didn't work

- Guessing from source alone. Three candidate silent exits exist and only
  the machine's own reply text can discriminate; the tool now shows it.

### What I learned

- Discarding command output was this session's counterpart of the earlier
  observability-lag pattern: the information existed, arrived, and was
  dropped before anyone could read it. Motion commands must surface replies
  as a matter of course.

### What warrants a second pair of eyes

- The undocumented `C:` status key (`C:3,1,0,1` on this machine) — present in
  no published client; possibly machine-state relevant to the no-op.

### What should be done in the future

- Re-run `home --confirm` and read the reply column (next action, operator
  present). If empty and still no motion: `get state`, then a machine power
  cycle as the clean experiment — state left over from the held queue is the
  standing suspect.
- Record the resolution in MZ1-001 observations if it turns out to be
  another firmware behaviour worth ground-truthing.
