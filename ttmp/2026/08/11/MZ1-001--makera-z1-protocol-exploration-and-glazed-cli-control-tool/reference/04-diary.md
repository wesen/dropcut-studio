---
Title: Diary
Ticket: MZ1-001
Status: active
Topics:
    - cnc
    - protocol
    - cli
    - glazed
    - research
DocType: reference
Intent: long-term
Owners: []
RelatedFiles:
    - Path: repo://dropcut-studio/ttmp/2026/08/11/MZ1-001--makera-z1-protocol-exploration-and-glazed-cli-control-tool/scripts/05-probe.py
      Note: Read-only hardware probe with the allowlist enforced before the socket write
    - Path: repo://makera-z1-cli/cmd/z1ctl/cmds/unlock.go
      Note: First authorised command and its preflight; Step 10 (commit a02251f)
    - Path: repo://makera-z1-cli/pkg/makera/client.go
      Note: Single-reader concurrency model replacing upstream's pause-and-busy-wait (commit 6d89caf)
    - Path: repo://makera-z1-cli/pkg/makera/fakemachine_test.go
      Note: Test double for behaviours only the machine can initiate; Step 11
    - Path: repo://makera-z1-cli/pkg/makera/filesystem.go
      Note: Authorised filesystem mutations; Step 12 (commit 3429f5b)
    - Path: repo://makera-z1-cli/pkg/makera/filexfer.go
      Note: Framed file transfer; Step 11 (commit 21d89ea)
    - Path: repo://makera-z1-cli/pkg/makera/safety.go
      Note: Motion guard; the over-inclusive classification discussed in Step 5 and fixed in Step 6 (commit e84d59f)
    - Path: repo://makera-z1-cli/pkg/webui/webui.go
      Note: Shared machine session behind one mutex (commit 81d775d)
ExternalSources: []
Summary: 'Chronological implementation diary for MZ1-001 and MZ1-002: protocol research, offline validation, first hardware contact, the licence reversal, the Go library and CLI, and the hardware control web page — including what failed and why.'
LastUpdated: 2026-08-11T19:00:00-04:00
WhatFor: Reconstructing how and why each decision was made, and picking the work back up.
WhenToUse: Read before resuming MZ1-001 or MZ1-002, or when a design choice needs its rationale.
---



# Diary

## Goal

Capture the implementation journey for MZ1-001 (Makera Z1 protocol and the
`z1ctl` CLI) and MZ1-002 (the hardware control page): what was built, in what
order, what failed, and which assumptions turned out to be wrong.

Backfilled in one pass at the end of the session, from the ticket artifacts,
the git history of `makera-z1-cli`, and the captured machine output.

---

## Step 1: Establish the protocol from source

The brief supplied a protocol sketch and four reference implementations. Rather
than trust the sketch, the first move was to clone all four and read the one
that turned out to matter — the Carvera Community Controller's `protocols/`
package, roughly 700 lines of well-factored Python that is by a wide margin the
clearest description of this protocol in existence.

That reading produced a specification with a file-and-line citation for every
claim, and it corrected the brief in two places that would have been fatal to an
implementation.

### Prompt Context

**User prompt (verbatim):** "Create a new docmgr ticket to create a CLI tool (glazed) to control the Makera Z1 and explore the protocol overall (we will create a proper device control UI later).

You can clone repositories into this workspace if you want.

Here's some upfront research done: [... four reference repositories, UDP 3333 discovery, TCP 2222 control, frame header 0x8668, CRC-16/CCITT poly 0x1021 init 0, packet types A1/A2/B0 outbound and 81/82/83/84/85/90 inbound, upload-then-play workflow ...]

---

Create  a detailed analysis / design / implementation guide that is for a new intern, explaining all the parts of the system needed to understand what it is, with prose paragraphs and bullet point sand pseudocode and diagrams and api references and file references. It should be very clear and technical. Store in the ticket and the nupload to remarkable."

**Assistant interpretation:** Create a docmgr ticket, do a real protocol
investigation grounded in source rather than restating the brief, and write an
intern-ready design document for a Glazed Go CLI. Publish to reMarkable.

**Inferred user intent:** Get a trustworthy, citable specification and a plan
that someone else could execute, for a machine whose only official client is a
GUI application.

### What I did

- Created ticket MZ1-001 and added five vocabulary topics.
- Cloned four reference implementations into `vendor/`.
- Read the community controller's `protocols/` package in full, plus the framed
  halves of `XMODEM.py`, the transport classes, and targeted regions of
  `Controller.py` and `main.py`.
- Enumerated the command surface mechanically:
  `grep -oE 'executeCommand\(["'"'"'][^"'"'"']*' Controller.py | sort -u`

### Why

The brief was a set of hypotheses. A protocol specification that is going to be
implemented against a machine that can break tools needs citations, not
summaries.

### What worked

The community fork has been refactored since the OEM code into a clean strategy
interface with a registry. It is essentially a written specification already,
and it made the reading fast.

### What I learned

- **`LENGTH` is not the payload length.** It is `1 + len(payload) + 2` — type
  plus payload plus CRC. Getting this wrong produces frames the machine silently
  discards, with no error and no reply.
- **The packet type list in the brief was incomplete.** It omitted `0xB1`–`0xB6`,
  the six bidirectional file-transfer types. Without them the file transfer
  cannot be implemented at all.
- **Newline handling is asymmetric by packet type**, and the upstream comment
  explains why: the firmware's numeric parsers use `strtol`, which requires
  `*end == '\0'`, so a trailing newline inside a length-delimited frame turns
  `baud 115200` into a parse failure.

### What warrants a second pair of eyes

The command-surface enumeration is from one client. The firmware may accept more
than that client sends — which turned out to be true (Step 4).

### Code review instructions

Start at `reference/02-makera-wire-protocol-reference.md`; every claim carries a
`CC/...:line` citation into `vendor/community-carvera-controller`.

---

## Step 2: Make the specification executable

A specification nobody can run is a document. Four experiments turned it into
something that fails loudly when it is wrong, all runnable with no machine
present.

### Prompt Context

**User prompt (verbatim):** (see Step 1)

**Assistant interpretation:** The guide should be technical and concrete, which
means the protocol claims need to be demonstrably correct.

**Inferred user intent:** Confidence that the specification is right before
anyone writes a client against it.

### What I did

- `scripts/01-frame-vectors.py` — a from-scratch bitwise encoder cross-checked
  against the vendored table-driven one, over ten vectors plus structural
  invariants.
- `scripts/02-goframe/` — a dependency-free Go port with adversarial receiver
  tests.
- `scripts/03-discover.py` — the discovery record parser with a self-test.
- `scripts/04-gostatus/` — the report grammar decoder.

### What worked

All four pass. The CRC check value `crc16("123456789") == 0x31C3` pins the
initial value to `0x0000` and distinguishes it from CRC-16/CCITT-FALSE
(`0x29B1`), which is what most libraries mean by "CCITT".

### What didn't work

Two failures, both instructive.

The Go port failed to compile:

```
./main.go:64:47: constant 34408 overflows byte
```

`byte(frameHeader)` where `frameHeader = 0x8668`. Fixed with
`byte(frameHeader & 0xFF)`. Trivial, but it is the first thing anyone porting
this will hit.

More interestingly, the test asserting that the decoder resynchronises after
leading garbage **failed, and the failure was correct**. My junk prefix
contained `86 68 01 55`, which the decoder read as a real header claiming a
341-byte body, so it swallowed the genuine frame behind it.

### What was tricky to build

That resynchronisation failure. The symptom was a passing decoder that dropped a
frame; the cause is that the protocol has no byte-stuffing, so the two bytes
`86 68` inside a payload are indistinguishable from a header. The upstream
Python decoder behaves identically.

There is no fix at the protocol level. The approach taken was to split the test
in two: one asserting resynchronisation after benign garbage, and one asserting
*and documenting* that a false header loses the frame behind it and that the
decoder recovers on later frames. The library then counts every rejected frame
in a `Drops` counter so a desynchronisation shows up as a number rather than as
inexplicably missing output.

### What I learned

A test that encodes a known limitation is worth more than one that quietly
avoids it. The second version of that test is the reason the limitation is
documented in three places instead of being rediscovered later.

---

## Step 3: The licence decision, reversed

The licence question was raised as an open item in the design guide, answered
MIT, and then reversed to GPL-2.0 within the same session. The reversal changed
the implementation plan, not just a header, so both answers are recorded.

### Prompt Context

**User prompt (verbatim):** "MIT. References the spec though and link to the project. what's next?"

**Second user prompt (verbatim):** "eh make it GPL-2.0"

**Assistant interpretation:** First, licence permissively and credit the
upstream projects. Then, licence under the same terms as the community
controller instead.

**Inferred user intent:** Settle how the tool is distributed and what it is
allowed to reuse.

### What I did

- Wrote the MIT version: implement strictly from the specification, copy no
  code, ship a NOTICE, publish the spec as `docs/protocol.md`.
- Verified every licence file in the clones before rewriting for GPL.
- Rewrote as ADR-008, with the GPLv2-only versus GPLv2-or-later sub-decision
  left open and a recommendation.

### What I learned

Checking the actual licence files rather than trusting the brief found two
errors:

- **`MakeraInc/CarveraController` is GPL-3.0, not GPL-2.0.** `COPYING` is the
  GPLv3 text and the README says so explicitly. GPLv3 and GPLv2-only are
  mutually incompatible, so OEM code cannot enter a GPLv2 tree. My own earlier
  table had lumped both controllers under "GPL", which would have led someone to
  port from the wrong one.
- **`hagmonk/carvera-cli` carries no licence at all** — no `LICENSE`, no
  `license` field in `pyproject.toml`, no statement in the README — despite the
  brief describing it as MIT.

### Why the reversal mattered

Under MIT the constraint was "implement from the spec, copy nothing", which
forced re-deriving the file-transfer state machines — the highest-risk component,
full of retry, cancel and out-of-order-block handling that the community
debugged on real hardware. Under GPL-2.0 that logic can be ported with a
provenance header. The plan was retargeted accordingly.

### What warrants a second pair of eyes

Copyleft reaches anything linking `pkg/makera`, including the eventual
device-control UI. The mitigation designed in is a process boundary
(`z1ctl --format json`), and MZ1-002 §6 records the options. Worth settling
before the UI ticket starts.

### What should be done in the future

Settle GPLv2-only versus GPLv2-or-later. It goes in every file header;
recommendation is "or later", which costs nothing today and preserves the option
of combining with GPLv3 code.

---

## Step 4: First hardware contact

The owner powered on the mill mid-session. This step is where the specification
met reality, and the result was a clean split: the framing was entirely right,
the payload formats were wrong in about a dozen places.

### Prompt Context

**User prompt (verbatim):** "I turned on the mill, you should be able to discover it?"

**Follow-up user prompt (verbatim):** "no moving anything without my go, right?"

**Assistant interpretation:** Find the machine on the network, and confirm that
nothing being done can move it.

**Inferred user intent:** Validate the work against real hardware, safely.

### What I did

- Ran the passive discovery listener; found `Makera_Z1_012146` at
  `192.168.0.55` immediately.
- Wrote `scripts/05-probe.py` with the read-only constraint **enforced in
  code**: `assert_read_only()` checks every outbound command against an
  allowlist and a motion denylist and raises before a byte reaches the socket.
  The only realtime byte permitted is `?`.
- Ran identity, status, diagnose, `help`, two directory listings, `md5sum`,
  `get wcs`, `get state`, `get pos`, `progress` and `mem`.
- Recorded everything in `reference/03-live-z1-observations-firmware-1-0-15.md`.

### Why enforce read-only in code

The instruction was not to move the machine. An allowlist checked before the
socket write is a mechanism. Remembering not to type the wrong command is not.
`switch` was deliberately excluded even though `switch <name>` is a query,
because `switch <name> <value>` actuates and one argument is the difference.

### What worked

**Zero decoder drops across five sessions.** Frame layout, `LENGTH = N+3`, CRC
init `0x0000`, the `0xA2` no-trailing-newline rule, the `0xA1` realtime
encoding, silence-means-makera detection, and the echo sentinel all held against
real firmware. The probe implements framing from our own specification rather
than importing upstream, so this validated the specification end to end.

### What didn't work

The payload formats. Twelve divergences; the ones that changed the design:

- **`ftype = nc`** — this firmware accepts no compressed uploads at all,
  converting a deferred decision into a closed question.
- **`MPos`/`WPos` carry five axes** (X, Y, Z, A, B), not three-or-four.
  Confirmed twice, via the status report and `get pos`.
- **No `G:` key in status** on stock firmware, so the active work coordinate
  system must come from a separate `get wcs` query.
- **Two undocumented status keys**, `E:` and `OTA:`. `OTA` is a second
  multi-character key alongside `RSSI`, retroactively justifying the
  split-on-first-colon rule.
- **`L:0, 0, 0, 0.0,100.0`** — values carry leading spaces.
- **`md5sum` returns a real digest**, concatenated with the path with no
  separator — not the placeholder upstream documents.
- **`help` is incomplete.** `model`, `ftype`, `time` and `echo` all work and
  none are listed. It did reveal a query family invisible from the controller
  source: `get pos|wcs|state|status`, `progress`, `mem`, `net`.
- **`cat` returns "File not found" for every file**, including ones `ls` has
  just listed. Reading a remote file therefore requires the framed download
  path, which explains why the community controller downloads `config.txt`
  rather than `cat`-ing it.

### What was tricky

The space-padded values are the detail that could not have been found by
reading. Python's `float()` accepts leading whitespace silently, so the Python
clients never had to handle it and their source contains no hint. The Go decoder
trims each token — written defensively, vindicated on first contact.

### What warrants a second pair of eyes

**The diagnose `E:` vector has eight elements where published clients map six.**
The planned preflight gates job start on the cover-closed bit inside it. If the
mapping is shifted rather than truncated, an implementation could report a
closed cover while it is open — precisely the failure a safety interlock exists
to prevent. This is now blocking, and `scripts/06-sensor-map.py` exists to
settle it: poll `diagnose`, print only changed fields, have an operator trigger
one input at a time.

### What I learned

The generic "decode to a map first, interpret second" design is the thing I
would most defend after this session. `E:` and `OTA:` arrived as data rather
than as parse failures, on the very first contact with hardware.

---

## Step 5: The Go library

With the specification validated, the library was mostly a port of code that
already worked. The interesting parts were the concurrency model and the safety
guard.

### Prompt Context

**User prompt (verbatim):** "Implement as much of the go side as possible, do not test writing / moving the mill. I'm going swimming so I'm not supervising the mill."

**Assistant interpretation:** Build the Go implementation now; read-only
operations against the machine are fine, nothing that writes or moves.

**Inferred user intent:** Make progress on the implementation while the machine
is unattended, without any risk to it.

**Commit (code):** `6d89caf` — "Add pkg/makera: validated Makera Z1 protocol library"

### What I did

- Scaffolded `makera-z1-cli`, added it to `go.work`, and initialised a git
  repository. `LICENSE` (GPLv2), `NOTICE`, `README.md`, and the specification
  published as `docs/protocol.md` plus `docs/observations-z1-1.0.15.md`.
- `frame.go` ported from `scripts/02-goframe`, with the golden vectors as tests.
- `protocol.go` — the `Protocol` interface with framed and legacy
  implementations.
- `report.go`, `parse.go` — the report grammar and the line-oriented parsers,
  encoding the hardware corrections from Step 4.
- `transport.go`, `discovery.go`, `detect.go`, `client.go`.
- `safety.go` — the motion guard.

### What was tricky

**The concurrency model.** The status poller and a file transfer read the same
socket, and the machine accepts one connection. Upstream sets a paused flag and
busy-waits up to a second for its reader thread to park:

```python
self.pausing = True
self.paused  = True          # set immediately — do not sleep first
deadline = time.time() + 1.0
while not self._stream_io_parked and time.time() < deadline:
    time.sleep(0.01)
```

The Go design gives the connection exactly one reader goroutine and transfers
ownership with an atomic mode flag. There is never a second consumer to race,
so the busy-wait disappears. The remaining hazard is the transfer driver failing
to drain its channel, which the buffered channel plus context cancellation
handles.

### What warrants a second pair of eyes

`safety.go`. `IsMotionCommand` is deliberately over-inclusive — a false positive
costs one explicit authorisation, a false negative costs a broken tool. The
prefix matching needs care so `model` is not read as an M-code; there is an
explicit exceptions set and a test for it.

### Code review instructions

Start at `pkg/makera/safety.go` and its test, then `frame.go`, then
`client.go:readLoop`. Validate with `go test ./... -count=1`; the tests use the
verbatim live captures as fixtures.

---

## Step 6: The CLI, and two bugs only hardware could find

Building the commands was mechanical. Running them against the machine found two
real defects that no unit test would have caught.

### Prompt Context

**User prompt (verbatim):** (see Step 5)

**Commit (code):** `e84d59f` — "Add z1ctl Glazed CLI: discover, info, status, watch, exec, fs, proto, doctor"

### What I did

- A shared connection section mounted on every command that talks to a machine.
- `discover`, `info`, `status`, `watch`, `exec`, `fs ls|stat`,
  `proto encode|decode|probe`, `doctor`.
- Ran every one of them against the live machine.

### What didn't work

Two build failures first:

```
cannot use schema.NewSection(...) (value of type *schema.SectionImpl) as *schema.Section
value in return statement: *schema.Section is pointer to interface, not interface
```

`schema.Section` is an interface; the constructor returns an implementation.
Return the interface type, not a pointer to it.

```
cmd/z1ctl/main.go:62:13: helpSystem.SetupCobraRootCommand undefined
```

The function lives in `pkg/help/cmd` and takes the help system as its first
argument, not as a receiver.

Then two real bugs, both found only by running against hardware:

1. **zerolog was writing debug lines that would corrupt `--format json`** for
   any consumer parsing the output. Fixed by routing logs to stderr at warn
   level with a `--log-level` flag.
2. **`time` was classified as always-motion**, so `Identify` silently failed
   and reported `clock_epoch: 0`. `time` reports the clock and `time <epoch>`
   sets it; `wlan -e` lists networks and `wlan <ssid> <password>` joins one.
   Added a `writeWithArgs` set for verbs that are queries bare and writes with
   arguments. `switch` stays always-refused, because there the difference is one
   argument on a command that drives real outputs.

### What was tricky

The `time` bug is a good illustration of over-inclusive safety having a cost.
The guard was right to be suspicious of `time`; it was wrong to be suspicious of
the bare form. The fix is contextual classification, which is more code and more
test surface, but the alternative — loosening the verb entirely — would have
allowed `time <epoch>` through.

### What worked

Everything, against the real machine: `discover` finds the Z1 and reports the run
state published clients discard; `info` reports the firmware and `ftype=nc`;
`status --wcs` resolves G54 through the separate query stock firmware requires;
`fs ls` parses the listing including directory marking; `doctor` returns eleven
checks and correctly reports the cover interlock as `unknown`.

Motion refusals verified end to end, exit code 2:

```
$ z1ctl exec "G0 X10" --device 192.168.0.55
z1ctl: refusing "G0 X10": command can move the machine or change its state; not authorised on this path
```

---

## Step 7: The hardware control page

A separate surface from DROPCUT Studio — Studio is the CAM application, this is
the machine pendant — styled from the same tokens so the two read as one
instrument.

### Prompt Context

**User prompt (verbatim):** "Then make a separate page for hardware control for the web UI, and serve it through the go server. Make it match the look of the current page. Write a docmgr ticket and design doc, upload to remarkable.

Write a diary (use the diary format skill, and backfill for everything you have done so far).

Commit at appropriate intervals."

**Assistant interpretation:** Build a hardware control page served by a Go
server, matching the studio app's visual design; document it in a new ticket
with a design doc and publish to reMarkable; write this diary; commit as I go.

**Inferred user intent:** A visual machine-control surface, and the project
documented and committed rather than left as loose work.

**Commit (code):** `81d775d` — "Add z1ctl serve: hardware control web page"

### What I did

- Read `dropcut-studio/apps/studio/src/styles.css` to learn the visual language,
  and copied its design tokens verbatim.
- `pkg/webui` — `net/http.ServeMux`, `go:embed` assets, one shared machine
  session behind a mutex, a 15-second listing cache.
- The page: five-axis DRO, spindle and feed, job state, and Files, Checks,
  Machine and Raw tabs.
- `z1ctl serve` with graceful shutdown so the machine's connection slot is
  released rather than left to time out.
- Verified in a browser at 1440×900 against the live machine.
- Created MZ1-002 with a design doc and uploaded it to reMarkable.

### Why "the go server" is a new one

The workspace has no Go server. `dropcut-studio` is a pure TypeScript monorepo
with no `go.mod`, and `glazed` is the framework. So the server is the one built
here, which also matches the process-boundary approach the licence decision
(Step 3) requires for any future permissive UI.

### What was tricky

**Deciding what to do about the disabled motion controls.** Omitting them makes
the page look finished and leaves a user wondering where the jog buttons are.
Including them live is not an option. The resolution was to render them disabled
with the reason stated in the page, so the layout is reviewable now and the
project's actual state is legible to whoever opens it.

**The `unknown` check severity.** The obvious design has two states, pass and
fail. The cover interlock is neither: the check cannot be performed because the
field order is unconfirmed. A preflight that shows green for a check it did not
run manufactures confidence, so a third severity exists specifically to say
"this was not verified".

### What didn't work

Two ports were already occupied by unrelated `python3` processes:

```
z1ctl: listen tcp :8099: bind: address already in use
z1ctl: listen tcp :8123: bind: address already in use
```

Confirmed with `ss -ltnp` and moved to `:8137`. Worth noting that `curl` against
the occupied port returned a *different* server's 404 page, which briefly looked
like a routing bug in our own mux.

### What I learned

The deviation from the workspace's usual web guidance (bun, React, RTK Query,
Bootstrap) is defensible here but should be stated rather than assumed: the
instruction was to match Studio's hand-written stylesheet, which Bootstrap would
work against, and one screen driven by a single JSON object does not justify
adding a build pipeline to a Go binary that has none. Recorded in MZ1-002 §3.4
with the condition under which the trade flips.

### What warrants a second pair of eyes

The single-session sharing in `webui.Server`. Every request serialises on one
mutex, so a slow directory listing blocks a status poll. The 15-second cache
mitigates it, but under a slow link the page could feel unresponsive. Worth
measuring before adding complexity.

### What should be done in the future

- Confirm the `E:` mapping, then implement the authorised motion path, a
  server-side preflight per request, and a confirmation gesture for `$H` and
  `M3` — in that order.
- Consider surfacing the Z1 camera; it is served by the ESP32 independently of
  the control connection, so it would not compete for the machine's single slot.

### Code review instructions

Start at `pkg/webui/webui.go:withClient` for the session model, then
`static/app.js` for the polling and rendering. Validate by running
`z1ctl serve --addr :8137 --device <ip>` and opening the page; every endpoint is
a GET and none can move the machine.

---

## Step 8: The vault report

A deep-dive technical write-up of the whole investigation, in the vault's
textbook style.

### Prompt Context

**User prompt (verbatim):** "also before we continue  write a detailed project report for the obsidian vault as a deep dive technical analysis blog post using a textbook writing style (no analogies, see skill).      
 Commit and push the bsidian vault when done (go-go-parc vault).   

then continue"

**Assistant interpretation:** Write the project up as a technical analysis for
the Obsidian vault in textbook style with no analogies, commit and push the
vault, then resume the implementation.

**Inferred user intent:** Preserve the reasoning durably outside the ticket, in
a form that reads as an article rather than a status report.

### What I did

- Wrote `Projects/2026/08/11/PROJ - Makera Z1 Control - Reverse-Specifying a CNC Wire Protocol.md`.
- Committed only that file — the vault had unrelated work in progress — and
  pushed to `origin/main` (`8d180e2`).

### What was tricky

Textbook style forbids analogies, which is the natural reflex when explaining a
protocol's failure modes. The substitutes are precise definitions, state
diagrams, and concrete traces. The false-header desynchronisation, for instance,
is explained by stating what the decoder does byte by byte and why no
byte-stuffing means no fix, rather than by comparison to anything.

---

## Step 9: The endstop mapping, settled by measurement

The cover-interlock bit was the one thing blocking motion. The diagnostic report
sends eight endstop values where every published client maps six, and the open
question was whether the extra fields shifted the mapping — which would make a
port read the wrong bit and report a closed cover while it was open.

The operator ran the differential script and triggered inputs one at a time.
The answer is that the vector is appended, not shifted: the cover sits at index
five exactly where published clients put it.

### Prompt Context

**User prompt (verbatim):** "ok what's next? do you need me to do something?"

**Follow-up user prompt (verbatim):** "I had to toggle some (for example open the cover to get to the probe, but they are in order [capture of scripts/06-sensor-map.py output showing E[5], P[1], I[0], G[1] and V[1] transitions]"

**Assistant interpretation:** Say what remains and what needs a human; then interpret the mapping capture they produced.

**Inferred user intent:** Unblock the work by supplying the one thing only someone standing at the machine can.

**Commit (code):** `8b50c29` — "Confirm the endstop mapping: cover is E[5], appended not shifted"

### What I did

- Smoke-tested `scripts/06-sensor-map.py` before handing it over — it had never
  been executed.
- Correlated the returned transitions against the operator's sequence.
- Implemented `Diagnose.CoverClosed()`, `EndstopTriggered()` and
  `ExtraEndstopFields()`, with the four verbatim capture lines as fixtures.
- Wired the result into `doctor` and the web page.

### Why

Design guide §17.2 gates job start on the cover bit. Guessing which index it is
would be exactly the failure a safety interlock exists to prevent.

### What worked

The correlation was unambiguous. Three cover transitions matched three `E[5]`
changes at the times the operator described, and `P[1]` and `I[0]` matched the
tool setter and emergency stop.

### What didn't work

The script printed nothing when piped. Python block-buffers stdout when it is
not a terminal, so a live differ — the entire point of which is watching values
change while toggling switches — showed an empty screen. Fixed with
`sys.stdout.reconfigure(line_buffering=True)` and by handling `SIGTERM` so
running it under `timeout` still prints the summary.

That bug would have wasted the operator's time at the machine. Smoke-testing a
script before asking someone else to run it is cheap.

### What I learned

- The mapping is **appended, not shifted**. My earlier concern was unfounded —
  but it was only *knowably* unfounded after measuring.
- `V[1]` drifted 34→33 during the deliberate do-nothing baseline window, which
  identifies it as an analog value rather than a switch. It is now muted as
  noise in the script.
- `G[1]` toggled alongside the first emergency-stop press and then independently.
  Correlated with that interaction; meaning not established. Recorded as unknown
  rather than guessed at.

### What was tricky to build

Deciding what to claim. The capture confirms `E[5]`, `P[1]` and `I[0]`. It says
nothing about `E[0..4]`, the axis limits, because triggering those requires
motion. The temptation is to treat "index 5 is where upstream says" as
validating the whole mapping. The code and the docs mark 0–4 as inherited and
unverified, which is the honest position.

### What warrants a second pair of eyes

`CoverClosed()` returns a second `known` boolean, and every caller must treat
unknown as "do not proceed" rather than as "closed". That contract is stated in
the doc comment and tested, but it is the kind of thing a future caller can get
wrong by writing `closed, _ :=`.

### Code review instructions

Start at `pkg/makera/report.go`, the endstop index block. Validate with
`go test ./pkg/makera/ -run Cover -v`; the fixtures are real machine output.

---

## Step 10: The unlock command, and the first authorised path

The emergency-stop press during mapping left the machine latched in `Alarm`, and
clearing it needed a command the safety guard refuses. The operator authorised
one attempt. Rather than a throwaway, this became the narrow authorised path the
design had been pointing at since ADR-008.

### Prompt Context

**User prompt (verbatim):** "i think it should be cleared? if not, you are allowed to clear it once."

**Assistant interpretation:** Check whether the alarm cleared itself; if not, I have permission to send the clear command exactly once.

**Inferred user intent:** Get the machine back to a usable state without granting open-ended motion authority.

**Commit (code):** `a02251f` — "Add z1ctl unlock: the first authorised command, plus the halt reason table"

### What I did

- Confirmed the machine was still in `Alarm`.
- Checked what upstream actually sends rather than assuming: `Controller.unlock()`
  sends `$X` and nothing else.
- Added `Client.Unlock`, and a `z1ctl unlock` command requiring `--confirm` with
  a full preflight.
- Ported the halt-reason table and its three recovery bands.

### Why

`$X` commands no movement, so refusing it outright is wrong; it re-enables
motion, so treating it as ordinary is also wrong. That is a third risk class and
it needed its own shape.

### What didn't work

The first run reported `cleared: false`. It had in fact worked — the status query
fired before the machine left `Alarm`, and a check moments later showed `Idle`.

Because the operator had authorised exactly one attempt, I stopped sending and
investigated instead of retrying. That turned out to be the right call for a
second reason: retrying would have masked the bug.

### What was tricky to build

The fix is a poll, and the dangerous version of a poll is a resend. The loop
re-reads status with a bounded deadline and never re-sends the command; the
comment says so, because the difference matters for anything that can move.

### What I learned

`H:13` is "emergency stop button pressed". More usefully, the halt table encodes
three recovery bands — unlock, reset, power cycle — and the band is a property of
the numeric *range*, so an unrecognised future code still routes correctly
rather than being offered an unlock that cannot work.

### What warrants a second pair of eyes

The preflight conditions in `unlock.go`. They are the model for every future
motion command's preflight, so getting the set right matters more than this one
command does.

### What should be done in the future

Clearing an alarm caused by a limit trip while the axis is still against the
limit will simply alarm again. The command's help says so, but a future version
could check.

---

## Step 11: The framed file transfer

The last real gap. Under GPL-2.0 this could have been ported from upstream, but
it was written from the published specification instead, because the
specification was already validated and a re-implementation with tests is easier
to reason about than a transliteration.

### Prompt Context

**User prompt (verbatim):** "ok wat's next?"

**Assistant interpretation:** Stop proposing and start building the largest
remaining piece.

**Inferred user intent:** Progress, not another plan.

**Commit (code):** `21d89ea` — "Add framed file transfer, a fake machine, and z1ctl fs get"

### What I did

- `FramedProtocol` interface so the transfer driver can obtain raw frames,
  including the file-transfer types the control path hides.
- Mode switching in `readLoop`, so the driver owns the frame stream.
- `filexfer.go`: both directions, with the three-case integrity policy.
- `fakemachine_test.go`: a `Transport` that plays the machine side.
- `z1ctl fs get`.

### Why a fake machine

Every interesting behaviour in this protocol is *initiated by the machine*:
out-of-order block requests, `FILE_RETRY`, cancel-as-success, a malformed
checksum. A real Z1 will not produce them on demand, so they are untestable by
driving real hardware — the opposite of the usual situation, and the reason the
test double is not optional.

### What worked

Eleven tests, then hardware on the first try: 54 B single block, 328 kB across
41 blocks in 6.9 s, and the cache-hit path, all digest-verified.

### What was tricky to build

Two things.

The frame layout for inbound data: the sequence number occupies the first four
bytes of the *payload*, and upstream's arithmetic is expressed in terms of the
frame body, so `dataLen = LENGTH - 7` translates to `payload[4:]`. Getting this
off by four bytes produces a file that is subtly corrupt rather than obviously
broken.

Making the out-of-order test actually prove something. Asserting that the
transfer completes is weak — a forward-only implementation would also complete,
just with wrong contents. The test asserts that the block the machine asked for
*first* contains the correct bytes, which is only true if the host seeked.

### What I learned

The download path returns a real digest on this firmware, not the placeholder
upstream documents. That closed the last open question about the checksum quirk.

### What warrants a second pair of eyes

The upload path was, at this point, fake-tested only. Also the stall handling:
`transferStallTimeout` is 9 s to match upstream, but that number is inherited
rather than measured.

### Code review instructions

`pkg/makera/filexfer.go`, then `fakemachine_test.go`. Validate with
`go test ./pkg/makera/ -run "Download|Upload" -v`.

---

## Step 12: Filesystem writes, and the same bug a third time

With explicit authorisation to upload and to manipulate what was uploaded, the
four write operations went in and were exercised end to end inside a scratch
directory.

### Prompt Context

**User prompt (verbatim):** "do upload, fs rm mv mkdir (with the files we uploaded). You are allowed to upload files and to manipulate the files you uploaded"

**Assistant interpretation:** Implement upload and the three filesystem
mutations, and verify them on the machine — scoped strictly to files I create.

**Inferred user intent:** Complete the filesystem surface and prove it works,
without risking pre-existing data.

**Commit (code):** `3429f5b` — "Add fs put, rm, mv, mkdir — full filesystem cycle verified on hardware"

### What I did

- `pkg/makera/filesystem.go`: authorised `RemoveFile`, `MoveFile`, `MakeDir`,
  plus `ListDir` and `RemoteMD5`.
- `z1ctl fs put|rm|mv|mkdir`, each verifying its own effect.
- Ran the full cycle on hardware in `/sd/gcodes/z1ctl-test`, then removed it.

### Why these are not behind a confirmation gate

They are a different risk class from motion: none can move an axis or start a
spindle. Requiring `--confirm` on `rm` would be theatre. What they can do is
destroy data, so instead each verifies its effect, `rm` refuses a nonexistent
path, `mv` refuses to clobber without `--force`, and `put` refuses while a job
is running.

### What didn't work

`mkdir` reported failure. The verification listed the parent directory
immediately after the command and did not find the new directory.

It had worked. Listing by hand showed it present, and a second `mkdir` returned
`LOAD_ERROR` because by then it genuinely existed.

**This is the third occurrence of the same bug**, after the unlock check and a
near-miss in the transfer completion path. The general statement is that a
command's effect and a command's observability are separate events on this
machine, separated by hundreds of milliseconds. Any verification of the shape

```
doThing(); if !observeThing() { fail }
```

is a race. Fixed with `waitForRemote`, a bounded poll that re-reads and never
re-sends.

### What was tricky to build

Reporting failures usefully. The first version of the mkdir error said the
directory was not present and swallowed the machine's own reply, which is what
made it look like a firmware limitation rather than a race. The errors now
include what the machine said.

### What I learned

- The firmware answers **nothing** on success, so an empty reply cannot
  distinguish success from a silently ignored command. Verification is mandatory,
  not defensive.
- `rm` removes an empty directory; there is no separate `rmdir`.
- `mkdir` works despite being absent from the firmware's own `help`, confirming
  again that `help` is a lower bound.
- The uploaded file came back timestamped `19800101044254`, the FAT epoch,
  corroborating the earlier finding that the machine's clock is unset.

### What warrants a second pair of eyes

`errorIndicators` in `filesystem.go` is a substring match against free-text
firmware replies. It is a heuristic. A reply containing the word "exists" in an
innocuous context would be misread as an error — acceptable because the effect
verification is the real check, but worth knowing.

### What should be done in the future

`put` has no `--overwrite` guard: it will replace a remote file without asking.
`get` has one. The asymmetry is not deliberate and should be closed.

---

## Step 13: The second vault report

A deep-dive write-up of the implementation phase, companion to the earlier
protocol note.

### Prompt Context

**User prompt (verbatim):** "write a detailed project report for the obsidian vault as a deep dive technical analysis blog post using a textbook writing style (no analogies, see skill).      
 Commit and push the bsidian vault when done (go-go-parc vault)."

**Assistant interpretation:** A second long-form note covering the
implementation, in the vault's textbook style, committed and pushed.

**Inferred user intent:** Preserve the engineering reasoning durably, in a form
that reads as an article rather than a status report.

**Commit (vault):** `51393aa`

### What I did

Wrote `PROJ - Makera Z1 Control - Building and Validating the Client.md`,
deliberately disjoint from the earlier note: architecture, the three-risk-class
safety model, the file transfer and why a fake machine was necessary, the
observability-lag pattern, the two reasoning corrections, and the verification
summary. Staged only that file — the vault had unrelated work in progress — and
pushed.

### What I learned

Writing the implementation up surfaced that the observability-lag bug had
occurred three times before I had named it as a single thing. Two of the three
were fixed independently, as if they were unrelated. Naming the pattern is what
makes the third fix general rather than another one-off.

---

## Open threads

1. **Motion and job control.** Everything else is in place. This needs the
   safety review first — the list of what stays behind an explicit gate (`$H`,
   `M3`, `M6`, firmware writes) should be read by someone who operates the
   machine.
2. **GPLv2-only versus GPLv2-or-later** is still unsettled and belongs in every
   file header. Recommendation remains or-later.
3. **Where `makera-z1-cli` lives.** It is a local git repository with no remote.
4. `put` should gain the `--overwrite` guard that `get` has.
5. **The USB transport** is unimplemented; it resets the machine on open and uses
   a 128-byte transfer block.
6. Unknown fields worth resolving opportunistically: the two appended endstop
   indices, the five-element `E:` in the *status* report, `G[1]` in the
   diagnostic report, and halt codes other than 13.
7. Whether `play` takes `-O` or `-v` on stock firmware — testable only on a
   scratch air-cut file with an operator present.
