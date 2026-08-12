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
    - Path: repo://dropcut-studio/ttmp/2026/08/11/MZ1-003--motion-and-job-control-with-a-manual-control-ui/analysis/01-implementation-review-the-client-the-cli-and-the-mz1-003-design.md
      Note: Step 1's deliverable — the pre-implementation review whose amendments drive the code
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
