---
Title: 'Makera Z1 Protocol and Glazed CLI: Analysis, Design and Implementation Guide'
Ticket: MZ1-001
Status: active
Topics:
    - cnc
    - protocol
    - cli
    - glazed
    - architecture
    - research
DocType: design
Intent: long-term
Owners: []
RelatedFiles:
    - Path: repo://dropcut-studio/ttmp/2026/08/11/MZ1-001--makera-z1-protocol-exploration-and-glazed-cli-control-tool/scripts/02-goframe/main.go
      Note: Passing Go codec and adversarial RX tests — the direct basis for pkg/makera/frame.go
    - Path: repo://dropcut-studio/ttmp/2026/08/11/MZ1-001--makera-z1-protocol-exploration-and-glazed-cli-control-tool/scripts/04-gostatus/main.go
      Note: Passing Go report-grammar decoder — the direct basis for pkg/makera/status.go
    - Path: repo://dropcut-studio/ttmp/2026/08/11/MZ1-001--makera-z1-protocol-exploration-and-glazed-cli-control-tool/vendor/community-carvera-controller/carveracontroller/Controller.py
      Note: Command surface, status/diagnose parsers, control loop and RX pausing
    - Path: repo://dropcut-studio/ttmp/2026/08/11/MZ1-001--makera-z1-protocol-exploration-and-glazed-cli-control-tool/vendor/community-carvera-controller/carveracontroller/XMODEM.py
      Note: Both file-transfer state machines, MD5 policy and the Z1 placeholder-digest quirk
    - Path: repo://dropcut-studio/ttmp/2026/08/11/MZ1-001--makera-z1-protocol-exploration-and-glazed-cli-control-tool/vendor/community-carvera-controller/carveracontroller/protocols/framing.py
      Note: Frame layout, CRC-16/CCITT table, encoder and validator — the primary source for section 5
    - Path: repo://dropcut-studio/ttmp/2026/08/11/MZ1-001--makera-z1-protocol-exploration-and-glazed-cli-control-tool/vendor/community-carvera-controller/carveracontroller/protocols/makera.py
      Note: Framed protocol encoders, RX state machine and packet-type dispatch
ExternalSources:
    - https://github.com/Carvera-Community/Carvera_Controller
    - https://github.com/MakeraInc/CarveraController
    - https://github.com/hagmonk/carvera-cli
    - https://github.com/GridSpace/carve-control
Summary: Complete intern-facing analysis of the Makera Z1 / Carvera wire protocol (framing, CRC, command surface, status grammar, file transfer) and the design for z1ctl, a Glazed-based Go CLI that discovers, controls and feeds jobs to the machine.
LastUpdated: 2026-08-11T17:00:00-04:00
WhatFor: Teaching a new engineer the whole Makera Z1 control stack and giving them a phase-by-phase implementation plan for the Go CLI.
WhenToUse: Read before writing any code that talks to a Z1 or Carvera, and whenever a protocol detail needs a citation to upstream source.
---


# Makera Z1 Protocol and Glazed CLI

**Analysis, Design and Implementation Guide**

Ticket MZ1-001 · 2026-08-11

---

## 0. How to read this document

This is written for an engineer who has never touched a CNC machine and has
never seen this protocol. It goes in this order on purpose:

| Part | Sections | What you get |
|---|---|---|
| **I — Understand the machine** | 1–3 | What a Z1 is, what "controlling" it actually means, and why this is not GRBL |
| **II — Understand the wire** | 4–9 | A complete, citable specification of the protocol, derived from upstream source |
| **III — Build the thing** | 10–16 | Go architecture, CLI surface, decision records, phased implementation plan |
| **IV — Not getting it wrong** | 17–20 | Testing, safety, risks, onboarding checklist |

Every factual claim about the protocol has a **file:line citation** into
`vendor/` inside this ticket. Two kinds of statements are carefully separated:

- **Observed** — read directly out of upstream source or a release note.
- **Design inference** — our recommendation, not something upstream states.

If you only have twenty minutes, read §1, §4, §5, §11 and §20.

---

# Part I — Understand the machine

## 1. Executive summary

### 1.1 What we are building

A single Go binary, **`z1ctl`**, built on the
[Glazed](https://github.com/go-go-golems/glazed) command framework, that speaks
the Makera machine protocol directly. It gives us — from a terminal, a script,
or later from a GUI backend — the ability to:

```
z1ctl discover                                # find machines on the LAN
z1ctl status --format json                    # one structured status row
z1ctl watch --interval 200ms                  # streaming status rows
z1ctl exec "version"                          # run any firmware shell command
z1ctl gcode "G53 G0 Z-2"                      # send a single MDI/G-code line
z1ctl fs ls /sd/gcodes                        # list machine files as rows
z1ctl fs put part.nc --remote /sd/gcodes/     # upload with integrity check
z1ctl job play /sd/gcodes/part.nc             # start the job on the machine
z1ctl job pause | resume | abort              # job lifecycle
z1ctl monitor --diagnose                      # endstops, switches, RSSI
z1ctl proto sniff --hex                       # raw frame inspector
```

### 1.2 The single most important finding

> **The Z1 does not stream G-code line-by-line from the host.**
> You **upload** a `.nc` file into the machine's SD card, then send `play
> <path>`. The machine executes the job locally out of its own filesystem. The
> host is a supervisor, not a real-time feeder.

This is the opposite of GRBL/CNCjs, where the host meters lines into a 128-byte
serial buffer and a host stall can starve the motion planner. It makes the CLI
architecture far simpler and far safer: our job is discovery, file transport,
supervision, and MDI — not hard-real-time streaming.

Evidence: `Controller.playCommand` sends `play <file>`
(`vendor/community-carvera-controller/carveracontroller/Controller.py:707-712`)
and the upload path is a distinct, separately framed transfer
(`Controller.py:689-699`, `main.py:5594-5700`).

### 1.3 The second most important finding

> **There are two wire protocols, and the Z1 uses the newer one.**
> Older Carvera firmware speaks plain newline-delimited Smoothieware text over
> the socket. Newer firmware — including the Z1 — wraps every command in a
> binary frame with a CRC. A client must detect which one it is talking to.

Only two of the four public implementations we surveyed implement the framed
protocol. `hagmonk/carvera-cli` and `GridSpace/carve-control` — the two that
look most like what we want to build — are **legacy-text-only** and will not
work against a Z1 without significant new code. Verified by grepping both trees
for the frame header `0x8668`: zero hits (see §6.1).

### 1.4 Recommendation and posture

| Question | Answer |
|---|---|
| Which upstream is authoritative for the Z1? | `Carvera-Community/Carvera_Controller` at v2.2.0-RC1+ (`vendor/community-carvera-controller`, HEAD `777482a`) |
| Which is authoritative for the OEM framing intent? | `MakeraInc/CarveraController` (`vendor/makera-carvera-controller`) — the original Chinese-commented source |
| Language / framework | Go 1.26 + Glazed, new module, binary `z1ctl` |
| Risk posture | Protocol layer is **low risk** (fully validated offline, see §18.1). Motion commands are **high consequence** — see §17 |
| Maturity of Z1 support upstream | **Release candidate.** v2.2.0-RC1 says "Initial Z1 support", released 04 Aug 2026, one week before this ticket |

---

## 2. Problem statement and scope

### 2.1 In scope

1. A reusable Go library (`pkg/makera`) implementing discovery, both transports,
   both wire protocols, protocol autodetection, the command surface, the status
   and diagnose grammars, and both file-transfer variants.
2. A Glazed CLI (`cmd/z1ctl`) exposing that library as structured-output
   commands.
3. Enough protocol documentation (this document + `reference/02`) that a future
   device-control UI can be built against the library without re-reading Python.
4. Offline conformance tests with golden vectors so the codec can be trusted
   before any machine is available.

### 2.2 Out of scope (for this ticket)

- The device control GUI. This ticket exists to make that GUI cheap to build.
- CAM / toolpath generation. That is `dropcut-studio`'s job; `z1ctl` consumes
  the `.nc` files it emits.
- Firmware flashing. The mechanism is known (upload to `/sd/firmware.bin`, then
  `reset`) but it is a foot-gun and deserves its own ticket.
- The Z1 camera. Documented in §9.4 because it is cheap to record now, but not
  implemented in phase 1.

### 2.3 Constraints we inherit

- **One client at a time.** The machine accepts a single TCP connection on 2222.
  Upstream literally uses "can I connect?" as the busy check
  (`WIFIStream.py:29-36`). If Makera's controller or the Community controller is
  running, `z1ctl` cannot connect. This shapes the CLI: every command is
  connect → do → disconnect, and long-lived sessions are opt-in.
- **The machine drives file transfers.** We respond to its requests; we do not
  push at our own pace (§8).
- **No authentication, no encryption.** Anyone on the LAN can drive the machine.
  Treat the network segment as the security boundary.

---

## 3. Technology primer

### 3.1 What a Makera Z1 is

The Z1 is a small enclosed desktop CNC mill from Makera, the same company that
makes the Carvera and Carvera Air (CA1). Mechanically: 3 linear axes (X, Y, Z),
an optional 4th rotary axis (A), a spindle, an automatic tool changer on some
models, a work-probe, a tool-length sensor, vacuum/air/light accessories, and a
cover interlock. Electrically it is a Smoothieware-derived motion controller (an
ARM Cortex-M board running a fork of Smoothie) plus an **ESP32 Wi-Fi
co-processor** that bridges the network to the motion board's serial link and
independently serves a camera.

For our purposes the machine is:

```
                       ┌──────────────────────────────────────────┐
                       │                Makera Z1                 │
   Wi-Fi / LAN         │  ┌────────────┐        ┌──────────────┐  │
  ───────────────────► │  │   ESP32    │◄──────►│  Smoothie-   │  │
   UDP :3333 announce  │  │  Wi-Fi br. │ serial │  derived     │  │
   TCP :2222 control   │  │            │        │  motion FW   │  │
   TCP :82  camera ws  │  └────────────┘        │              │  │
   TCP :80  camera http│                        │  SD card:    │  │
                       │                        │   /sd/gcodes │  │
   USB (FTDI serial)   │                        │   /sd/config │  │
  ─────────────────────┼───────────────────────►│   /sd/.lz    │  │
                       │                        └──────────────┘  │
                       └──────────────────────────────────────────┘
```

The SD card is the important part. It is the machine's job store. Our workflow
always ends up there.

### 3.2 Vocabulary you need

| Term | Meaning |
|---|---|
| **MDI** | Manual Data Input — typing a single G-code line at the machine, as opposed to running a program |
| **MPos / WPos** | Machine position (absolute, from homing) vs Work position (relative to the active work coordinate system) |
| **WCS** | Work Coordinate System — G54…G59.3; an offset from machine zero that the part is described in |
| **WCO** | Work Coordinate Offset — `MPos - WPos`, possibly with a rotation applied |
| **TLO** | Tool Length Offset — how far the current tool sticks out, measured by the tool sensor |
| **Realtime character** | A single byte the firmware acts on *immediately*, jumping the command queue: `?` status, `!` hold, `~` resume, `0x18` soft reset |
| **Feed hold** | Decelerate and stop motion without losing position; resumable |
| **Alarm** | Latched fault state; motion refused until cleared |
| **Homing (`$H`)** | Drive each axis to its endstop to establish machine zero |
| **ATC** | Automatic Tool Changer |
| **QuickLZ / `.lz`** | The block compression the firmware accepts for uploads, to reduce transfer time |

### 3.3 The Smoothieware lineage — why the command surface looks like it does

Because the firmware descends from Smoothieware, three unrelated command
languages coexist on the same channel:

1. **G-code / M-code** — `G0 X10 Y10`, `M3 S12000`. Motion and machine functions.
   Makera adds a large private M-code block in the M4xx–M8xx range (§7.4).
2. **GRBL-style `$` commands** — `$H` home, `$J <axis><dist>` jog,
   `$X` unlock, `$F S<n>` feed override.
3. **A Unix-ish "SimpleShell"** — `ls`, `cat`, `rm`, `mv`, `mkdir`, `md5sum`,
   `config-get-all`, `upload`, `download`, `play`, `version`, `time`, `diagnose`.

There is no namespacing and no consistent reply format. This is why §7 exists.

### 3.4 Why not reuse an existing implementation?

| Project | Language | License (verified in the clone) | Framed (Z1) protocol? | Verdict |
|---|---|---|---|---|
| `Carvera-Community/Carvera_Controller` | Python/Kivy | **GPL-2.0** (`LICENSE` = GPLv2 text; `pyproject.toml: license = "GPL-2.0"`) | **Yes** | Authoritative reference for the Z1. Same licence as `z1ctl` — code may be ported directly (§3.5) |
| `MakeraInc/CarveraController` | Python/Kivy | **GPL-3.0** (`COPYING` = GPLv3 text; README states "GNU GPL v3") | **Yes** (origin of the design) | Authoritative for original framing intent. **Different GPL version** — see the compatibility note in §3.5 |
| `hagmonk/carvera-cli` | Python | **None found.** No `LICENSE` file and no `license` field in `pyproject.toml` in the cloned tree | **No** | Great CLI *shape* and the echo-sentinel idea; wire layer unusable for Z1. Treat as all-rights-reserved until a licence is confirmed |
| `GridSpace/carve-control` | Node/JS | MIT (`LICENSE`, © 2022 Stewart Allen) | **No** | Useful proxy/sniffer/spoofer concepts; wire layer unusable for Z1 |

> **Two corrections to the project brief.** The brief described the OEM repo
> alongside the community one without distinguishing licence versions — it is
> **GPLv3**, and GPLv3 and GPLv2-only are mutually incompatible (§3.5). The brief
> also called `hagmonk/carvera-cli` "MIT-licensed"; the repository as cloned
> carries **no licence text at all**. Its README documents the tool but never
> states a licence. Do not reuse its code until that is resolved with the author
> — its *ideas* (the echo sentinel, the CLI shape) are free to use regardless.

### 3.5 Licensing — decided: GPL-2.0

**`z1ctl` is GPL-2.0**, matching the Carvera Community Controller. See
**ADR-008** (§12) for the full record. This is the licence of the project we
learned the protocol from, and choosing it keeps `z1ctl` in the same family as
the ecosystem it belongs to.

*(Not legal advice. The compatibility facts below are the standard reading of
the GPL, but if `z1ctl` is going to be distributed publicly, the GPLv2-only vs
GPLv2-or-later question in §3.5.2 deserves a real answer from someone qualified.)*

#### 3.5.1 What GPL-2.0 buys us

The constraint that dominated the earlier analysis disappears: **we may port
code from `Carvera-Community/Carvera_Controller` directly**, because `z1ctl` is
under the same licence. That is a genuine engineering win, concentrated exactly
where the risk is:

- The **file-transfer state machines** (§9) are the highest-risk part of the
  implementation — machine-driven, out-of-order block requests, retry and cancel
  paths, three-way MD5 policy. Being able to port upstream's proven logic rather
  than re-derive it from a specification removes most of that risk.
- The **CRC lookup table** and the **RX state machine** can be lifted as-is
  (though see §3.5.4 — our own versions are already written and tested).

Obligations that come with it, all ordinary GPL-2.0 hygiene:

1. **Preserve copyright and licence notices** on anything ported, and mark
   modified files as changed (GPLv2 §2a).
2. **Ship the full licence text** as `LICENSE`, and offer complete corresponding
   source for any binary we distribute (GPLv2 §3). For a Go binary that means
   the release must point at the source repository.
3. **Any work that links `pkg/makera` is a derivative work.** This is the
   consequence that reaches beyond this ticket — see §3.5.3.
4. **Credit the projects and reference the published specification** (§3.6).

#### 3.5.2 GPLv2-only or GPLv2-or-later? — one decision still open

The two GPL upstreams are under **different, mutually incompatible** versions:

| Project | Version | Can we port its code into a GPLv2-**only** `z1ctl`? |
|---|---|---|
| `Carvera-Community/Carvera_Controller` | GPL-2.0 | **Yes** |
| `MakeraInc/CarveraController` | GPL-3.0 | **No** — GPLv3 code cannot be relicensed into a GPLv2-only work |

Neither the community repo's `LICENSE` nor its `pyproject.toml` contains an "or
(at your option) any later version" grant, and no source header in
`carveracontroller/*.py` carries one either (checked). So the community code is
best treated as **GPLv2-only**, which means a GPLv2-only `z1ctl` can use it but
can never absorb OEM code.

Two options:

- **GPL-2.0-only** — simplest, matches the community controller exactly. The OEM
  repo stays a read-only reference for protocol *facts* (which is all we have
  used it for so far, and facts are not copyrightable).
- **GPL-2.0-or-later** *(recommended)* — same practical effect today, but leaves
  the door open: an "or later" work can be combined with GPLv3 code by
  distributing the combination under GPLv3. If we ever need something from the
  OEM controller, or from a GPLv3 Go dependency, we are not stuck.

Recorded as an open sub-decision in ADR-008. It costs nothing to decide now and
is painful to change once there are outside contributors.

#### 3.5.3 The consequence that reaches the future UI

> The prompt says a **proper device control UI comes later**. Under GPL-2.0, any
> UI that links `pkg/makera` is a derivative work and must also be GPL-2.0.

That is fine if the UI is a GPL desktop app or a GPL web backend. It is a problem
if it is meant to be proprietary, or to be embedded in `dropcut-studio` under a
permissive licence. Two ways out, if that becomes a requirement:

- Keep the boundary at the **process**, not the library: the UI shells out to
  `z1ctl` and speaks JSON (`--format json` / `--format jsonl` make this pleasant,
  which is one more reason the CLI is designed that way). The mere-aggregation
  reading of the GPL is much friendlier to separate processes than to linking.
- Or split the repo: a **spec-derived, permissive `pkg/makera`** with no ported
  code, plus a GPL `z1ctl` that may port freely. This is the MIT plan from the
  previous revision, kept in reserve — it costs the file-transfer risk reduction
  described in §3.5.1.

Flagging it now because it is cheap to plan for and expensive to unwind later.

#### 3.5.4 Practical guidance for contributors

- **Ported code must be marked.** Any file or function derived from upstream
  carries a header saying which file it came from, at which commit
  (`777482a`), and that upstream is GPL-2.0. Reviewers should be able to tell
  ported code from original code at a glance.
- **The already-written pieces stay ours.** `scripts/02-goframe/main.go` and
  `scripts/04-gostatus/main.go` were written from the specification, are tested,
  and carry no upstream provenance. Use them for `frame.go` and `status.go` —
  not because we must, but because they already pass and their tests came with
  them. Use the bitwise CRC (§5.2) for the same reason, not out of caution.
- **Port where it earns its keep:** `filexfer.go`. That is where upstream's
  scar tissue is worth more than our re-derivation.
- **`vendor/` still never becomes a dependency.** It is research evidence living
  inside this ticket. `makera-z1-cli` must not import it or ship it — porting
  means copying reviewed code into our tree with attribution, not depending on
  the clone.
- **`hagmonk/carvera-cli` has no licence** (§3.4). Its *ideas* are free to use;
  its code is not, until the author clarifies. We only wanted the echo-sentinel
  concept anyway (§10.4).

### 3.6 Attribution and the published specification

Ship this as `dropcut-studio/makera-z1-cli/NOTICE`, linked from the README:

```markdown
## Attribution

z1ctl speaks the Makera / Carvera machine protocol. The protocol was documented
by reading the open-source projects below, and this tool would not exist without
them. z1ctl is licensed GPL-2.0, matching the Carvera Community Controller.

- Carvera Community Controller — https://github.com/Carvera-Community/Carvera_Controller
  (GPL-2.0) The authoritative reference for the framed protocol and for Makera Z1
  support. Its `carveracontroller/protocols/` package is the clearest description
  of this protocol that exists. Portions of z1ctl's file-transfer implementation
  are derived from this project; derived files say so in their headers.
  That project in turn credits bCNC (GPL-2.0, Vasilis Vlachoudis) and the
  XMODEM library (MIT, Wijnand Modderman / Jeff Quast / Kris Hardy), whose
  lineage the file-transfer code carries.
- MakeraInc CarveraController — https://github.com/MakeraInc/CarveraController
  (GPL-3.0) The original controller and the origin of the framing design. Used
  as a factual reference only; no code from it appears in z1ctl.
- hagmonk/carvera-cli — https://github.com/hagmonk/carvera-cli
  For the command-line shape and the echo-sentinel completion technique. Ideas
  only; the repository carries no licence text, so no code was reused.
- GridSpace/carve-control — https://github.com/GridSpace/carve-control (MIT)
  For protocol inspection, proxying and machine-spoofing patterns.

The protocol specification this implementation follows is published at
`docs/protocol.md`.
```

**Publish the specification.** Ship
`reference/02-makera-wire-protocol-reference.md` in the repository as
`docs/protocol.md`, and reference it from `--help` long text, from the
`z1ctl proto` command group description, and from the README. Under GPL-2.0 this
is no longer about establishing provenance — it is simply the most reusable
artefact this ticket produced. Nobody else has written this protocol down in one
place, and anyone implementing a Z1 client in any language benefits.

---

# Part II — Understand the wire

## 4. Transports and discovery

### 4.1 The three network ports

| Port | Proto | Direction | Purpose |
|---|---|---|---|
| 3333 | UDP | machine → broadcast | Machine announcement / discovery |
| 2222 | TCP | host → machine | The control channel (commands + file transfer, multiplexed) |
| 80 | TCP | host → machine | ESP32 HTTP, camera resolution control (Z1) |
| 82 | TCP | host → machine | ESP32 WebSocket, camera MJPEG-ish stream (Z1) |

Observed: `WIFIStream.py:12-13` (`TCP_PORT = 2222`, `UDP_PORT = 3333`),
`addons/camera/Z1Camera.py:33-42` (ports 82 and 80).

### 4.2 Discovery is passive

The host does **not** send a probe. It binds `0.0.0.0:3333` and listens for the
machine's periodic broadcast. Each datagram is a comma-separated ASCII record:

```
machine_name,ip_address,tcp_port,busy[,future_fields...]
     │            │          │      │
     │            │          │      └─ "1" = busy, anything else = free
     │            │          └──────── usually 2222
     │            └─────────────────── dotted quad
     └──────────────────────────────── e.g. "Z1_ABCDEF"
```

Observed: `WIFIStream.py:52-72`. Upstream reads 128 bytes per datagram, splits
on `,`, requires **more than 3 fields**, and ignores extras — so the format is
forward-compatible. It dedupes by machine name and collects for ~3 seconds.

Validated offline by `scripts/03-discover.py --self-test`, which reproduces the
parser and its rejection cases.

**Gotcha:** binding UDP 3333 fails with `EADDRINUSE` if Makera's controller is
already running. Set `SO_REUSEADDR` (our script does) and still expect
contention.

### 4.3 The busy check is a connect attempt

```python
def is_machine_busy(self, addr):
    try:
        with socket.create_connection((addr, "2222"), timeout=1):
            return False        # we got in ⇒ nobody else has it
    except (OSError, socket.timeout):
        return True             # refused ⇒ someone else is connected
```

Observed: `WIFIStream.py:29-36`. This confirms the single-client constraint. Note
the side effect: **the busy check itself takes the connection slot** for the
duration of the probe.

### 4.4 The TCP control channel

Connect to `ip:port`, default 2222. Upstream uses a 2-second connect timeout and
then drops to a **0.3 s** socket timeout for steady-state operation
(`WIFIStream.py:105-112`). Reads are 1024 bytes at a time (`BUFFER_SIZE = 1024`,
`WIFIStream.py:14`).

Everything — status polls, MDI, shell commands, and the entire file transfer —
is multiplexed over this one socket. There is no second channel and no request
ID. That single fact drives most of the client design (§10.3).

### 4.5 The USB transport

A USB-serial (FTDI) link to the motion board, opened at **115200 baud** by
default (`USBStream.py:71-80`), with a 0.3 s read/write timeout. Two behaviours
differ from Wi-Fi:

- **Opening the port toggles DTR and resets the machine.** Upstream sleeps 2.0 s
  after open before probing, and grants a 20 s heartbeat grace period versus 5 s
  for Wi-Fi (`Controller.py:1568-1571`, `1591`).
- **File transfer block size is 128 bytes, not 8192.** `USBStream` constructs
  `XMODEM(..., "xmodem")`; `WIFIStream` constructs `XMODEM(..., "xmodem8k")`
  (`USBStream.py:21`, `WIFIStream.py:84`, sizes at `XMODEM.py:464-473`).

There is also a post-connect baud upgrade path (`baud 115200` → higher) that
upstream had to fix specifically for the framed protocol; see §5.5 for the
newline bug it exposed.

**Design inference:** implement Wi-Fi first. USB adds a serial dependency, a
reset-on-open hazard, and a different block size for no phase-1 benefit.

---

## 5. The framed Makera protocol

This is the core of the ticket. Everything here has been re-derived from scratch
and cross-checked against upstream (§18.1) — the vectors in this section are
byte-exact and can be pasted into a test.

### 5.1 Frame layout

```
 ┌────────┬────────┬──────┬───────────────┬────────┬────────┐
 │ HEADER │ LENGTH │ TYPE │    PAYLOAD    │ CRC16  │ FOOTER │
 │ 0x8668 │   NN   │  TT  │   N bytes     │  CCCC  │ 0x55AA │
 │ 2 bytes│ 2 bytes│1 byte│               │ 2 bytes│ 2 bytes│
 └────────┴────────┴──────┴───────────────┴────────┴────────┘
   big-endian throughout

           └──────── CRC is computed over THIS ────────┘
              (LENGTH + TYPE + PAYLOAD — not header, not footer)

  LENGTH = 1 (type) + N (payload) + 2 (crc)
  Total frame size on the wire = 2 + 2 + LENGTH + 2
```

Observed: `protocols/framing.py:303-318` (encoder),
`protocols/framing.py:329-344` (validator), and the original Chinese-commented
spec at `vendor/makera-carvera-controller/src/Controller.py:241-282`:

```
# [帧头][数据长度][指令类型][数据内容][CRC16][帧尾]
# - 帧头: 0x8668 (2字节，不参与CRC计算)     header, excluded from CRC
# - 数据长度: 数据内容长度 (2字节)           length
# - 指令类型: 0xA1 (1字节)                  type
# - CRC16: 计算范围(数据长度 + 指令类型 + 数据内容)
# - 帧尾: 0x55AA (2字节，不参与CRC计算)      footer, excluded from CRC
```

> **Correction to a common summary.** The `LENGTH` field is *not* the payload
> length. It includes the type byte and the CRC bytes. `LENGTH = N + 3`. Getting
> this wrong produces frames the machine silently drops.

`MAX_FRAME_DATA_LENGTH = 8200` (`framing.py:27`) bounds the declared length. That
number is not arbitrary: the largest legitimate frame is a Wi-Fi file-data block
— 8192 payload + 4 sequence bytes + 1 type + 2 CRC = 8199.

### 5.2 CRC-16/CCITT, exactly

- Polynomial `0x1021`
- **Initial value `0x0000`** (this is *not* CRC-16/CCITT-FALSE, which inits to
  `0xFFFF`)
- No input or output reflection, no final XOR
- Check value: `crc16("123456789") == 0x31C3`

Upstream uses a 256-entry lookup table (`framing.py:30-300`). A bitwise
implementation is nine lines and produces identical output — proven in
`scripts/01-frame-vectors.py` and `scripts/02-goframe/main.go`:

```go
func crc16CCITT(data []byte) uint16 {
    var crc uint16                    // init 0x0000 — NOT 0xFFFF
    for _, b := range data {
        crc ^= uint16(b) << 8
        for i := 0; i < 8; i++ {
            if crc&0x8000 != 0 {
                crc = (crc << 1) ^ 0x1021
            } else {
                crc <<= 1
            }
        }
    }
    return crc
}
```

### 5.3 Packet types

| Value | Name | Direction | Meaning |
|---|---|---|---|
| `0xA1` | `CTRL_SINGLE` | host → machine | One realtime control byte |
| `0xA2` | `CTRL_MULTI` | host → machine | A text command (G-code, `$`, shell) |
| `0xB0` | `FILE_START` | host → machine | `upload <path>` / `download <path>` |
| `0xB1` | `FILE_MD5` | both | MD5 digest exchange |
| `0xB2` | `FILE_VIEW` | both | File layout: packet count + packet size |
| `0xB3` | `FILE_DATA` | both | Data block, or a request for block *n* |
| `0xB4` | `FILE_END` | both | Transfer complete |
| `0xB5` | `FILE_CAN` | both | Cancel transfer |
| `0xB6` | `FILE_RETRY` | both | Resend last frame |
| `0x81` | `STATUS_RES` | machine → host | Response to `?` |
| `0x82` | `DIAG_RES` | machine → host | Response to `diagnose` |
| `0x83` | `LOAD_INFO` | machine → host | Chunk of a bulk listing (`ls -e`, `cat -e`, config dump) |
| `0x84` | `LOAD_FINISH` | machine → host | End of bulk listing |
| `0x85` | `LOAD_ERROR` | machine → host | Bulk listing failed |
| `0x90` | `NORMAL_INFO` | machine → host | Unsolicited informational text (MDI console output) |

Observed: `protocols/framing.py:11-25`; OEM subset and Chinese glosses at
`vendor/makera-carvera-controller/src/Controller.py:76-88`.

**Note the asymmetry that trips people up:** `0x81`, `0x82` and `0x90` all carry
*plain text* payloads and are all treated identically by the parser — they all
become one line of machine output (`protocols/makera.py:149-157`). The type byte
tells you *why* the line arrived, not how to parse it. The actual structure lives
in the text: `<...>` for status, `{...}` for diagnose (§7.5, §7.6).

### 5.4 Golden vectors

Produced by `scripts/01-frame-vectors.py`, which cross-checks a from-scratch
encoder against the vendored implementation, and consumed as test data by
`scripts/02-goframe/main.go`:

```
realtime '?'        86 68 00 04 a1 3f 35 33 55 aa
realtime 0x18       86 68 00 04 a1 18 61 b6 55 aa
realtime '!'        86 68 00 04 a1 21 c6 cc 55 aa
realtime '~'        86 68 00 04 a1 7e 6d d6 55 aa
command 'version'   86 68 00 0a a2 76 65 72 73 69 6f 6e cc a0 55 aa
command 'model'     86 68 00 08 a2 6d 6f 64 65 6c 52 01 55 aa
command 'G0 X10 Y10'86 68 00 0d a2 47 30 20 58 31 30 20 59 31 30 9f fe 55 aa
command 'diagnose'  86 68 00 0b a2 64 69 61 67 6e 6f 73 65 76 c5 55 aa
upload (FILE_START) 86 68 00 1d b0 75 70 6c 6f 61 64 20 2f 73 64 2f
                    67 63 6f 64 65 73 2f 70 61 72 74 2e 6e 63 0a a4 fc 55 aa
empty payload       86 68 00 03 a2 c0 fb 55 aa
```

Read the first one: header `8668`, length `0004` (= type 1 + payload 1 + crc 2),
type `a1`, payload `3f` (`'?'`), CRC `3533`, footer `55aa`.

### 5.5 Newline handling — the rule that has burned people

Three encoders, three different newline rules:

| Encoder | Newline rule | Source |
|---|---|---|
| Makera `CTRL_MULTI` (`0xA2`) | **Strips** trailing `\r\n` | `protocols/makera.py:64-70` |
| Makera `FILE_START` (`0xB0`) | **Appends** `\n` if missing | `protocols/makera.py:75-81` |
| Smoothie (legacy text) | **Appends** `\n` if missing | `protocols/smoothie.py:20-26` |

The comment upstream explains why, and it is worth reading twice:

> Match OEM Makera framing: CTRL_MULTI payloads are not newline-terminated. A
> trailing `\n` breaks numeric parsers such as baud (`strtol` requires
> `*end == '\0'`).

So `baud 115200\n` inside a `0xA2` frame parses as a *failure* on the firmware
side, because the frame is length-delimited and the firmware's `strtol` sees the
newline as trailing garbage. The framing supplies the boundary; the newline is
redundant and harmful. In the legacy text protocol the newline **is** the
boundary, so it is required. Get this backwards and you will chase a bug for a
day.

### 5.6 The receive state machine

Byte-at-a-time, four states. Reproduced from `protocols/makera.py:89-133`:

```
        ┌──────────────┐  sliding 2-byte window == 0x8668
        │ WAIT_HEADER  │──────────────────────────────────┐
        └──────────────┘                                  ▼
               ▲                                  ┌──────────────┐
               │                                  │ READ_LENGTH  │ 2 bytes
               │ length out of range              └──────────────┘
               ├──────────────────────────────────────────┤
               │                                          ▼
               │                                  ┌──────────────┐
               │                                  │  READ_DATA   │ LENGTH bytes
               │                                  └──────────────┘
               │                                          ▼
               │  footer != 0x55AA  or  CRC mismatch  ┌──────────────┐
               └──────────────────────────────────────│ CHECK_FOOTER │ 2 bytes
                          emit frame ◄────────────────└──────────────┘
```

Properties we verified experimentally in `scripts/02-goframe/main.go`:

- ✅ Survives **every** 2-way split of a frame (a TCP socket will split anywhere).
- ✅ Handles multiple frames in one read.
- ✅ Drops a CRC-corrupted frame and still parses the next one.
- ✅ Rejects an oversized `LENGTH` without wedging.
- ⚠️ **Known limitation, shared with upstream:** if garbage on the wire happens
  to contain the bytes `86 68` followed by a plausible length, the decoder locks
  onto the false header and swallows however many bytes that length claims —
  losing the real frames behind it. It recovers when the footer check fails, but
  data is lost. There is no escaping or byte-stuffing in this protocol, so this
  is unavoidable; **log it** when a footer/CRC check fails so the loss is visible
  rather than mysterious.

---

## 6. Protocol detection and switching

### 6.1 Why detection is needed at all

Old firmware: raw newline-delimited text. New firmware (Z1): framed. Same port,
same socket, no version handshake. The client must figure it out.

We verified which upstreams handle this by grepping for the frame header:

```bash
$ grep -rn "8668" vendor/hagmonk-carvera-cli/src        # (no output)
$ grep -rn "8668" vendor/gridspace-carve-control/lib    # (no output)
$ grep -rn "8668" vendor/community-carvera-controller/carveracontroller
  .../protocols/framing.py:8:FRAME_HEADER = 0x8668
$ grep -rn "8668" vendor/makera-carvera-controller/src
  .../Controller.py:77:FRAME_HEADER = 0x8668  # 2字节帧头
  .../XMODEM.py:27:FRAME_HEADER = 0x8668
```

### 6.2 The active probe

Observed: `protocols/detector.py:11-59`.

```
1. Drain the RX buffer (read with a 10 ms timeout until empty).
2. Up to 3 times:
     send the RAW ASCII bytes  b"echo echo\n"      (deliberately unframed)
     sleep 100 ms
     read up to 10 bytes with a 100 ms timeout
     if the reply contains b"echo"  →  protocol = "smoothie", done
3. If all 3 attempts time out       →  protocol = "makera"
```

The logic is elegant: an old machine echoes back because raw text is its native
language. A new machine sees `echo echo\n` as a malformed frame — no `0x8668`
header — and silently discards it. **Silence is the signal.** The default on any
failure is `makera` (`registry.py:16`, `session.py:112-120`), which is the right
bias for new hardware.

### 6.3 Two passive switch triggers

Detection is not one-shot. `ProtocolSession.feed` (`session.py:131-148`) also
switches mid-session:

1. **Wire-level:** if we currently believe "smoothie" and the raw bytes contain
   `86 68`, switch to makera immediately.
2. **Announcement-level:** firmware emits protocol announcements in response to
   `M485` / `M485.1` / `M485.2`. Text containing `makera communication protocol`
   or `current communication protocol: makera` (and the smoothie equivalents)
   flips the session (`session.py:31-44`).

Critically, both are suppressed during file transfer (`allow_wire_switch=False`),
because XMODEM binary payload can trivially contain `86 68` by chance
(`Controller.py:2225-2226`).

### 6.4 Design inference for `z1ctl`

Implement all three mechanisms, but add a `--protocol {auto,makera,smoothie}`
flag. Autodetection costs up to 300 ms on every connect, and a CLI that runs
twenty times in a script should be able to skip it. Default `auto`; document
`--protocol makera` as the fast path for a known Z1.

---

## 7. The command surface

### 7.1 Three sending modes

Everything the host says falls into exactly one of three buckets, and each maps
to a different frame type:

| Mode | Frame type | Example | Upstream entry point |
|---|---|---|---|
| **Realtime** — one byte, jumps the queue | `0xA1` | `?`, `!`, `~`, `0x18` | `Controller.executeRealtime:267` |
| **Command** — a text line | `0xA2` | `G0 X10`, `$H`, `ls -e -s /sd` | `Controller.executeCommand:233` |
| **File initiation** | `0xB0` | `upload /sd/gcodes/a.nc` | `Controller.executeFileCommand:290` |

In the legacy protocol all three collapse to "write the bytes, newline-terminated".

### 7.2 Realtime bytes

| Byte | Name | Effect |
|---|---|---|
| `?` (0x3F) | Status query | Machine replies with a `<...>` report |
| `!` (0x21) | Feed hold | Decelerate and stop; resumable |
| `~` (0x7E) | Cycle start / resume | Resume from feed hold |
| `0x18` | Soft reset (Ctrl-X) | Reset the motion controller state |
| `0x1A` | Jog keepalive (Ctrl-Z), **Makera protocol only** | Continuous-jog watchdog |
| `'1'` | Jog keepalive, **Smoothie protocol only** | Same role, different byte |

Observed: `Controller.softReset:1765-1766` (0x18), `Controller.viewStatusReport:1729-1742`
(the `?` / keepalive digram).

The keepalive detail is worth understanding because it is the one place the two
protocols differ *semantically*, not just in framing:

```python
if self.comms.uses_framed_transfer:
    self.executeRealtimeSequence(ord("?"), 0x1A)   # Makera
else:
    self.executeRealtimeSequence(ord("?"), ord("1"))  # Smoothie
```

And the comment above it explains why they are sent in **one** write:

> Sending `?` and `1` as separate writes races with other commands and leaves
> orphaned `1` bytes in the firmware command buffer (seen as `111…$J …`).

Lesson for the Go client: **a realtime sequence must be one `Write` call.**

### 7.3 Shell commands

Complete list of shell verbs used by the community controller (grepped from
`Controller.py`; the firmware may accept more):

| Command | Purpose | Reply shape |
|---|---|---|
| `version` | Firmware version | `version = 1.0.5c` line |
| `model` | Machine model | `model = Z1, <id>, <func>, <extra>` |
| `time` / `time <epoch>` | Read / set the clock | `time = <epoch>` |
| `ftype` | Accepted upload file types | `ftype = lz` (or similar) |
| `diagnose` | Sensor/switch snapshot | `{...}` report (§7.6) |
| `ls -e -s <dir>` | Directory listing | Bulk `LOAD_INFO` chunks, `name size timestamp` per line |
| `cat <file> -e` | Read a file | Bulk `LOAD_INFO` chunks |
| `rm <file> -e` | Delete | |
| `mv <a> <b> -e` | Rename/move | |
| `mkdir <dir> -e` | Create directory | |
| `md5sum <file> -e` | Digest | 32-char digest — **but see §9.3 for the Z1 quirk** |
| `upload <path>` | Begin an upload (`0xB0` frame) | Starts the transfer state machine |
| `download <path>` | Begin a download (`0xB0` frame) | Starts the transfer state machine |
| `play <path> [-O]` | Run a job from SD | Progress reported via `P:` in status |
| `suspend` / `resume` | Pause / continue a job | |
| `abort` | Abort the running job | |
| `reset` | Reset the controller | **Blocked over USB upstream** — leaves the board in a zombie state (`Controller.py:240-243`) |
| `config-get-all -e` | Dump every config key | Bulk transfer |
| `config-set sd <key> <value>` | Set a config key | |
| `config-restore` / `config-default` | Restore backup / factory defaults | |
| `wlan -e` | List networks | |
| `wlan <ssid> <pass> -e` | Join a network | |
| `wlan -d disconnect` | Disconnect | |
| `buffer <cmd>` | Queue a command behind motion instead of executing it immediately | |
| `echo <text>` | Echo — used as a completion sentinel (§10.4) | |
| `help` | Firmware's own command list | |

The `-e` suffix means "terminate the response with EOT". That is how the client
knows a variable-length listing has ended. In the framed protocol this maps onto
`LOAD_INFO` chunks followed by `LOAD_FINISH` (`0x84`); in the legacy protocol it
is a literal `0x04` byte (`protocols/smoothie.py:38-42`).

### 7.4 Argument escaping — mandatory, easy to forget

Because the machine's parser is whitespace-and-punctuation sensitive and because
`?`/`!`/`~` are realtime bytes that must never appear literally inside a command
line, filenames and arguments are escaped before sending:

| Character | Escaped as |
|---|---|
| space | `0x01` |
| `?` | `0x02` |
| `&` | `0x03` |
| `!` | `0x04` |
| `~` | `0x05` |

Observed: `Controller.escape:627-629` (space handled per-call at each call site,
e.g. `Controller.lsCommand:631-635`), and confirmed with the inverse in
`vendor/hagmonk-carvera-cli/src/carvera_cli/device/manager.py:110-122`.

Responses containing filenames must be **unescaped** symmetrically. Note that
Windows-style `\` separators are converted to `/` at every call site
(`Controller.py:633-634` and friends) — the machine only understands `/`.

### 7.5 Makera M-code block

Not exhaustive, but these are the ones the controller actually issues. Treat this
as the "machine functions" API:

| Code | Meaning |
|---|---|
| `M220 S<n>` | Feed override % |
| `M223 S<n>` | Spindle override % |
| `M321` / `M322` | Laser mode on / off |
| `M323` / `M324` | Laser test on / off |
| `M325 S<n>` | Laser power scale |
| `M331` / `M332` (+`.3`) | Vacuum / external-output mode selection |
| `M370` | Clear auto-leveling |
| `M471` | Pair wireless probe |
| `M490.1/.2/.4` | Tool clamp / unclamp / change |
| `M491` | Drop tool |
| `M493.2 T<n>` | Set current tool |
| `M494` | Z probe (legacy path, commented out upstream) |
| `M495 X<x> Y<y>` | Auto-leveling |
| `M495.3 H<h> D<d>` | XYZ probe, height + probe diameter |
| `M496.1` … `M496.5` | Go to clearance / work origin / anchor1 / anchor2 / path origin |
| `M801 S<n>` / `M802` | Vacuum on at power / off |
| `M811 S<n>` / `M812` | Spindle fan on / off |
| `M821` / `M822` | Light on / off |
| `M831` / `M832` | Tool sensor power on / off |
| `M841` / `M842` | Probe charger on / off |
| `M851 S<n>` / `M852` | External control PWM on / off |
| `M6 T<n>` | Tool change |
| `M3 S<rpm>` / `M5` | Spindle on / off |
| `M7` / `M9` | Air on / off |

Observed by enumerating `executeCommand("...")` literals in `Controller.py`
(§ evidence in the diary) plus the named methods at `Controller.py:456-625`.

### 7.6 GRBL-ish `$` commands

| Command | Meaning |
|---|---|
| `$H` | Home all axes (`Controller.home:1779-1780`) |
| `$J <axis><delta> [F<feed>]` | Jog (`Controller.jog:1865-1875`) |
| `$F S<n>` | Feed override |
| `$O S<n>` | Spindle/other override |
| `$X` | Unlock after alarm (standard GRBL; not directly issued upstream) |

And two convenience movement idioms worth stealing verbatim:

```go
// Safe Z: 2 mm below the homing point, in MACHINE coordinates.
// Upstream uses -2 rather than 0 because X-sag compensation on some models
// can be a whole millimetre.  Controller.gotoSafeZ:1889-1891
"G53 G0 Z-2"

// Park at machine home, Z first.  Controller.gotoMachineHome:1893-1896
"G53 G0 Z-2"
"G53 G0 X-2 Y-2"
```

**Always retract Z before moving XY.** That ordering is not a style preference;
it is the difference between a park move and a broken tool.

---

## 8. Status and diagnose reports

### 8.1 A single generic grammar

Both reports are the same shape and can be decoded by one function:

```
<STATE|KEY:v[,v...]|KEY:v[,v...]|...>      status,   reply to '?'
{KEY:v[,v...]|KEY:v[,v...]|...}            diagnose, reply to 'diagnose'
```

Rules that matter, all learned from upstream's scar tissue:

1. Find the **outermost** delimiters (`indexOf('<')`, `lastIndexOf('>')`). A junk
   byte after the closer must not poison the last field
   (`Controller.py:1317-1323`).
2. Split the body on `|`.
3. Split each chunk on the **first** `:` only — `RSSI:-57` and future keys demand
   it (`Controller.py:1469`).
4. Values are a comma-separated numeric vector.
5. **Every key is optional and the vectors grow over firmware versions.** Upstream
   is full of `if len(d["S"]) > 3` guards. Decode generically into
   `map[string][]float64` first, interpret second. A fixed regex will break on
   the next firmware.

Our Go implementation of exactly this is `scripts/04-gostatus/main.go`, with
tests covering the documented sample lines, minimal 3-axis lines, trailing junk,
unknown future keys and malformed input.

### 8.2 Status report fields

Documented sample line (`Controller.py:1315`):

```
<Idle|MPos:68.9980,-49.9240,40.0000,12.3456|WPos:68.9980,-49.9240,40.0000,5.3
     |R:0.0|G:0|F:12345.12,100.0|S:1.2,100.0|T:1|L:0>
```

| Key | Vector | Meaning |
|---|---|---|
| *(state)* | word | `Idle`, `Run`, `Tool`, `Alarm`, `Home`, `Hold`, `Wait`, `Disable`, `Sleep`, `Pause` (`Controller.py:58-70`) |
| `MPos` | x, y, z[, a] | Machine position |
| `WPos` | x, y, z[, a] | Work position |
| `R` | angle | WCS rotation, degrees. Presence implies community firmware (`can_rotate_wcs`) |
| `G` | n | Active coordinate system index; 0 = G54 |
| `C` | model, funcSetting, inchMode, absoluteMode | Machine capability word; `inchMode == 1` ⇒ scale 25.4 |
| `F` | cur, target, override%[, spindleTemp] | Feed. The 4th element is a legacy analog-spindle temperature on FW ≤ 2.1.0 |
| `S` | cur, target, override%[, vacuumMode, temp, …, extOutMode] | Spindle. Length-dependent semantics — read `Controller.py:1390-1400` before adding fields |
| `T` | tool, tlo[, targetTool, colletType] | Tool state. Absent ⇒ tool = −1 |
| `W` | voltage | Wireless probe battery |
| `L` | mode, state, testing, power, scale | Laser |
| `P` | lines, percent, seconds[, isPlaying] | **Job progress.** Absent ⇒ not playing |
| `A` | n | ATC state |
| `O` | delta | Max leveling delta |
| `H` | reason | Halt reason code |

Observed: `Controller.parseBracketAngle:1310-1449`.

**Deriving WCO.** Because the WCS can be rotated on community firmware, the
offset is not a plain subtraction (`Controller.py:1366-1383`):

```
wcox = mx - (cos(θ)·wx − sin(θ)·wy)
wcoy = my - (sin(θ)·wx + cos(θ)·wy)
wcoz = mz - wz
θ = rotation_angle in degrees, from R:
```

With `θ = 0` this collapses to the familiar `wco = mpos − wpos`.

### 8.3 Diagnose report fields

Documented sample line (`Controller.py:1452`):

```
{S:0,5000|L:0,0|F:1,0|V:0,1|G:0|T:0|E:0,0,0,0,0,0|P:0,0|A:1,0|RSSI:-57}
```

| Key | Vector | Meaning |
|---|---|---|
| `S` | switch, slaved | Spindle |
| `L` | switch, slaved | Laser |
| `F` | switch, slaved | Spindle fan |
| `V` | switch, slaved | Vacuum |
| `G` | switch | Light |
| `T` | switch | Tool sensor power |
| `R` | switch | Air |
| `C` | switch | Probe charger power |
| `E` | xMin, xMax, yMin, yMax, zMax, cover | **Endstops and cover interlock** |
| `P` | probe, calibrate | Probe / calibration inputs |
| `A` | atcHome, toolSensor | ATC home and tool-sensor inputs |
| `I` | eStop | Emergency stop |
| `RSSI` | dBm | Wi-Fi signal |

Observed: `Controller.parseBigParentheses:1451-1513`.

`E` and `I` are the safety-relevant ones. A `z1ctl doctor` command that reads
these and refuses to jog when the cover is open is cheap and worth building
(§17.2).

### 8.4 Polling cadence

Upstream's control loop (`Controller.streamIO:2193-2246`):

- Status `?` every **0.2 s** (`STREAM_POLL`)
- `diagnose` every **0.5 s** (`DIAGNOSE_POLL`), only when the diagnostics panel is open
- **Both suppressed** while a file transfer or bulk load is in flight
  (`sendNUM > 0 || loadNUM > 0 || pausing`)
- Adaptive backoff: when a read returns data, delay 0; otherwise ramp 0 → 0.1 s
  in 0.01 s steps

Copy the cadence and the suppression rule. The suppression is not an
optimisation — a `?` injected into the middle of a file transfer will be parsed
as file-transfer garbage.

### 8.5 Firmware identity lines

Two lines identify the machine; both arrive as ordinary text and are matched by
regex (`main.py:4156-4185`):

```
version = 1.0.5c              →  regex: version = \d+\.\d+\.\d+[a-zA-Z0-9\-_]*
model = Z1, 2, 3, 0           →  regex: model = (\w+), (\d+), (\d+), (\d+)
                                          │      │    │    └ extra
                                          │      │    └───── FuncSetting bitfield
                                          │      └────────── MachineModel id
                                          └───────────────── model name: Z1 | C1 | CA1
```

- A `c` anywhere in the version string means **Community firmware**
  (`main.py:4160`).
- The model name is what tells you it is a Z1. `z1ctl` should issue `version` and
  `model` right after connecting and cache both for the session.

---

## 9. File transfer

### 9.1 The shape of it

The transfer is **machine-driven**. After the host sends the `0xB0` initiation
frame, the host's job is to sit in a loop, read frames, and answer whatever the
machine asks for. The host never decides what to send next.

That is the single biggest departure from classic XMODEM, despite the name and
the shared vocabulary. Upstream reuses the `XMODEM` class name and file, but the
framed path (`XMODEM.send`, `XMODEM.recv`) is a different protocol from the
legacy path (`XMODEM.send_legacy`, `XMODEM.recv_legacy`).

### 9.2 Upload sequence

Observed: `XMODEM.send:740-817`, orchestration at `main.py:5594-5700`.

```
 HOST                                              MACHINE
   │                                                  │
   │  0xB0  "upload /sd/gcodes/part.nc\n"             │
   ├─────────────────────────────────────────────────►│
   │                                                  │
   │  ── pause the RX status loop here (critical) ──  │
   │                                                  │
   │  0xB1 FILE_MD5  <32-char local digest>           │
   ├─────────────────────────────────────────────────►│
   │                                                  │  digest matches
   │                          0xB5 FILE_CAN           │  what's on SD?
   │◄─────────────────────────────────────────────────┤  ⇒ cancel = SUCCESS
   │                             (cache hit — done)   │     (nothing to do)
   │                                                  │
   │                          0xB2 FILE_VIEW (req)    │  otherwise:
   │◄─────────────────────────────────────────────────┤
   │  0xB2 FILE_VIEW  u32 packetCount ‖ u16 blockSize │
   ├─────────────────────────────────────────────────►│
   │                                                  │
   │                     0xB3 FILE_DATA  u32 seq=1    │  machine REQUESTS
   │◄─────────────────────────────────────────────────┤  block 1
   │  0xB3 FILE_DATA  u32 seq=1 ‖ <blockSize bytes>   │
   ├─────────────────────────────────────────────────►│
   │                     0xB3 FILE_DATA  u32 seq=2    │
   │◄─────────────────────────────────────────────────┤
   │                        ... repeat ...            │
   │                          0xB4 FILE_END           │
   │◄─────────────────────────────────────────────────┤  transfer complete
   │  ── resume the RX status loop ──                 │
```

Details that matter:

- `packetCount = ceil(fileSize / blockSize)`; `blockSize` is **8192 over Wi-Fi**,
  **128 over USB** (`XMODEM.py:464-473`, `776-778`).
- Sequence numbers are **1-based**, big-endian `u32`.
- If the machine re-requests the sequence we just sent (`seq == lastseq`), resend
  the same bytes. If it requests a non-consecutive `seq`, **seek** to
  `(seq-1) * blockSize` and send from there (`XMODEM.py:789-801`). Random access
  is expected; do not assume a forward-only stream.
- `0xB6 FILE_RETRY` from the machine means "resend the last frame you sent",
  whatever it was (`XMODEM.py:765-766`).
- Timeout: if 9 seconds pass with no frame, send `FILE_CAN` and fail
  (`XMODEM.py:811-817`).
- The MD5 sent up front is the digest of the **uncompressed** file, even when the
  payload being transferred is the compressed `.lz` version
  (`main.py:5624` — `md5 = Utils.md5(displayname)` where `displayname` has the
  `.lz` suffix stripped).

### 9.3 Download sequence

Observed: `XMODEM.recv:609-738`. Three states: `WAIT_MD5` → `WAIT_FILE_VIEW` →
`READ_FILE_DATA`.

```
 HOST                                              MACHINE
   │  0xB0  "download /sd/gcodes/part.nc\n"           │
   ├─────────────────────────────────────────────────►│
   │                     0xB1 FILE_MD5 <digest>       │
   │◄─────────────────────────────────────────────────┤
   │                                                  │
   │  if digest == our cached local digest:           │
   │  0xB5 FILE_CAN   (we already have it — success)  │
   ├─────────────────────────────────────────────────►│
   │                                                  │
   │  else: 0xB2 FILE_VIEW (request)                  │
   ├─────────────────────────────────────────────────►│
   │                0xB2 FILE_VIEW  u32 totalPackets  │
   │◄─────────────────────────────────────────────────┤
   │  0xB3 FILE_DATA  u32 seq=1   (request block 1)   │
   ├─────────────────────────────────────────────────►│
   │            0xB3 FILE_DATA u32 seq ‖ <data>       │
   │◄─────────────────────────────────────────────────┤
   │  0xB3 FILE_DATA  u32 seq+1   (ack + request)     │
   ├─────────────────────────────────────────────────►│
   │                     ... until seq == total ...   │
   │  0xB4 FILE_END                                   │
   ├─────────────────────────────────────────────────►│
```

Payload layout of an inbound `FILE_DATA` frame — note the offsets are into the
*body* (length+type+payload+crc), not the payload
(`XMODEM.py:640-651`):

```
 body[0..1]  declared LENGTH
 body[2]     type = 0xB3
 body[3..6]  u32 sequence (big-endian)
 body[7..]   file data,  dataLen = LENGTH - 7
                                   └─ 1 type + 4 seq + 2 crc
```

### 9.4 MD5 policy, and the Z1 quirk you must handle

`XMODEM._finalize_download_integrity:507-554` implements a three-way policy:

| Condition | Action |
|---|---|
| Advertised digest is not 32 lowercase hex chars | **Skip the check.** Log it |
| Payload begins with `\x00\x00` (QuickLZ) | **Defer** the check until after decompression |
| Otherwise | Require an exact match; reject the download on mismatch |

The reason the first row exists is a Z1 firmware bug, spelled out in the upstream
docstring (`XMODEM.py:487-505`):

> Stock Z1 firmware answers `md5sum` with the fixed placeholder
> `default_md5_hash_value_32_bytes_`, which is exactly 32 characters long but is
> not a digest, so length alone cannot tell the two apart.

Confirmed in the release notes: *"Fixed: On the Makera Z1 firmware every download
returns same placeholder MD5 hash instead of a digest failing the MD5 check"*
(`sources/web/01-community-controller-releases.raw.md:105`).

**Therefore `z1ctl` must validate that the advertised digest is 32 characters
*and* all of them are hex digits.** A naive length check will happily accept
`default_md5_hash_value_32_bytes_` and then fail every Z1 download.

### 9.5 Compression

If the `ftype` response contains `lz`, uploads are QuickLZ-compressed before
transfer (`main.py:5598-5602`), block by block (`main.py:5485`). The machine
decompresses on arrival and reports progress via `decompart = <percent>` lines
(`main.py:4191-4193`). Compressed copies live in a `.lz` subdirectory alongside
the originals (`main.py:5658-5666`).

**Design inference:** skip compression in phase 1. Send the raw `.nc` and let the
transfer take longer. There is no maintained Go QuickLZ package we would want to
depend on, `.nc` files are small (hundreds of KB), and 8 KB blocks over Wi-Fi are
fast. Revisit only if upload latency becomes a real complaint. Record this as
**ADR-005**.

### 9.6 Pausing the read loop is mandatory

The status poller and the file transfer read from the same socket. Upstream stops
the RX loop and *waits for it to acknowledge the stop* before the transfer starts
(`Controller.pauseStream:2140-2152`):

```python
self.pausing = True
self.paused  = True          # set immediately — do not sleep first
deadline = time.time() + 1.0
while not self._stream_io_parked and time.time() < deadline:
    time.sleep(0.01)         # wait for the reader to actually park
```

The comment says exactly why: *"Pause RX immediately — do not wait before setting
paused, or framed file-transfer packets (MD5/etc.) can be consumed by streamIO."*

In Go this is much cleaner: give the connection **one** reader goroutine and route
frames through a mode switch, rather than having two things race for the socket
(§10.3).

### 9.7 The Z1 camera (for the future UI, not phase 1)

Documented here because it was cheap to record while the source was open
(`addons/camera/Z1Camera.py:1-66`):

- Served by the **ESP32**, not the motion firmware — so it works even when the
  control socket is busy.
- WebSocket `ws://<host>:82/ws_video`; send the text `start_stream`; the machine
  then pushes **one whole JPEG per binary message**.
- Resolution is set over plain HTTP on port 80 at `/api/camera/resolution`, using
  Espressif `framesize_t` values: 10 = 640×480 (~20 fps) … 15 = 1600×1200
  (~10 fps). Out-of-range values return HTTP 200 and are then ignored.
- No exposure/gain/white-balance controls exist. Upstream grades frames on the
  host instead.

---

# Part III — Build the thing

## 10. System design

### 10.1 Where the code lives

**Design inference.** The workspace currently holds `dropcut-studio` (a
TypeScript/pnpm CAM monorepo — no Go module) and `glazed` (the Go framework).
`go.work` uses only `./glazed`. So `z1ctl` gets a **new Go module** added to the
workspace:

```
cnc-control-dropcut/
├── go.work                     # add:  use ./makera-z1-cli
├── glazed/                     # framework (already here)
├── dropcut-studio/             # CAM, TypeScript — produces the .nc files
└── makera-z1-cli/              # ← NEW
    ├── go.mod                  # module github.com/go-go-golems/makera-z1-cli
    ├── Makefile
    ├── cmd/z1ctl/
    │   ├── main.go             # root cobra command, logging, help system
    │   └── cmds/
    │       ├── discover.go
    │       ├── status.go       # status, watch
    │       ├── exec.go         # exec, gcode, realtime
    │       ├── fs.go           # ls, get, put, rm, mv, mkdir, stat
    │       ├── job.go          # play, pause, resume, abort, progress
    │       ├── config.go       # config get / set / dump
    │       └── proto.go        # sniff, frame encode/decode helpers
    └── pkg/makera/
        ├── frame.go            # §5  encoder, decoder, CRC
        ├── frame_test.go       #     golden vectors from scripts/01
        ├── protocol.go         # §6  Protocol interface, Makera + Smoothie impls
        ├── detect.go           # §6.2 active probe + passive switches
        ├── transport.go        # §4  Transport interface
        ├── transport_tcp.go
        ├── transport_serial.go # phase 4
        ├── discovery.go        # §4.2 UDP listener
        ├── client.go           # §10.3 the session object
        ├── status.go           # §8  report grammar + typed views
        ├── commands.go         # §7  typed wrappers over the command surface
        ├── escape.go           # §7.4
        ├── filexfer.go         # §9  upload / download state machines
        └── testdata/
```

Why a separate module and not a subdirectory of `dropcut-studio`: that repo is a
pnpm workspace with no `go.mod`, and mixing toolchains there would be a
maintenance tax for zero benefit.

### 10.2 Layering

```
 ┌────────────────────────────────────────────────────────────┐
 │  cmd/z1ctl/cmds  — Glazed commands: flags in, rows out      │
 │  Knows nothing about frames. Talks only to Client.          │
 ├────────────────────────────────────────────────────────────┤
 │  pkg/makera.Client — session: connect, detect, request/      │
 │  response correlation, status cache, file transfer driver   │
 ├──────────────────────────┬─────────────────────────────────┤
 │  Protocol (interface)    │  Reports (status/diagnose)      │
 │   ├ MakeraProtocol       │  Commands (typed wrappers)      │
 │   └ SmoothieProtocol     │  Escape / unescape              │
 ├──────────────────────────┴─────────────────────────────────┤
 │  Transport (interface):  TCPTransport | SerialTransport      │
 │  Raw bytes in / out. No protocol knowledge.                 │
 └────────────────────────────────────────────────────────────┘
```

Each boundary is testable without the layer below: `Protocol` against golden
byte vectors, `Client` against an in-memory fake `Transport`, commands against a
fake `Client`.

### 10.3 The Client: one reader, one mode

The hardest problem is that one socket carries asynchronous machine chatter,
solicited command replies, and a binary file transfer — with no request IDs. The
Go answer is a single reader goroutine plus an explicit mode:

```go
type Mode int

const (
    ModeControl  Mode = iota // normal: frames become lines/status/events
    ModeTransfer             // file transfer owns the frame stream
)

type Client struct {
    tr    Transport
    proto Protocol

    frames  chan Frame      // reader → whoever currently owns the stream
    events  chan Event      // control-mode: parsed lines, status, load chunks
    mode    atomic.Int32

    mu      sync.Mutex
    status  *Status         // last status, refreshed by the poller
    info    MachineInfo     // version, model, firmware flavour
}

// readLoop is the ONLY goroutine that touches tr.Read.
func (c *Client) readLoop(ctx context.Context) error {
    buf := make([]byte, 4096)
    for {
        n, err := c.tr.Read(buf)          // honours ctx via SetReadDeadline
        if err != nil { return err }
        for _, f := range c.proto.Feed(buf[:n]) {
            if Mode(c.mode.Load()) == ModeTransfer {
                select {
                case c.frames <- f:       // transfer driver consumes
                case <-ctx.Done():  return ctx.Err()
                }
                continue
            }
            c.dispatchControl(f)          // status / line / load chunk / event
        }
    }
}
```

Compare this to upstream's pause-and-spin (`Controller.pauseStream`). We get the
same exclusion for free, deterministically, with no sleep loop — because there is
only ever one reader and it hands the stream to the transfer driver by flipping a
flag.

### 10.4 Knowing when a command is done

There is no request ID and no universal terminator. Three strategies, in order of
preference:

1. **`-e` commands** (`ls -e`, `cat -e`, `config-get-all -e`) terminate with EOT.
   In the framed protocol that is a `LOAD_FINISH` (`0x84`) frame; in legacy it is
   a literal `0x04`. Deterministic — always prefer this form.
2. **The echo sentinel.** For commands with no `-e` form, send the command and
   *immediately* send `echo \x04` in the same write. When the sentinel comes
   back, the earlier command's output has been fully flushed, because the
   firmware processes the line queue in order.

   ```
   send: "version"
   send: "echo \x04"
   read: "version = 1.0.5c"
   read: "\x04"          ← our sentinel: everything before it belongs to `version`
   ```

   This is `hagmonk/carvera-cli`'s trick
   (`vendor/hagmonk-carvera-cli/src/carvera_cli/device/manager.py:286-288`) and it
   is the single best idea in that codebase. Steal it.
3. **`ok` for G-code.** Motion commands answer `ok`. Combine with the sentinel:
   wait for the sentinel, then assert `ok` appeared
   (`manager.py:395-399`).

Everything gets a deadline. Upstream's default command timeout is 15 s
(`manager.py:13`); mirror that and make it a `--timeout` flag.

### 10.5 Core Go types

```go
// ---------- transport ----------

type Transport interface {
    Open(ctx context.Context, addr string) error
    Read(p []byte) (int, error)
    Write(p []byte) (int, error)
    Close() error
    // BlockSize is the file-transfer block size: 8192 for TCP, 128 for serial.
    BlockSize() int
}

// ---------- protocol ----------

type Protocol interface {
    Name() string                       // "makera" | "smoothie"
    UsesFramedTransfer() bool
    EncodeCommand(b []byte) []byte      // 0xA2 — strips trailing \r\n
    EncodeRealtime(c ...byte) []byte    // 0xA1 — MUST be one write
    EncodeFileCommand(b []byte) []byte  // 0xB0 — appends \n
    Feed(b []byte) []Message            // incremental RX
    Reset()
}

type MessageKind int
const (
    MessageLine MessageKind = iota  // ordinary text (status/diag/normal)
    MessageLoadChunk                // part of a bulk listing
    MessageLoadEOF
    MessageLoadError
)

type Message struct {
    Kind MessageKind
    Text string          // newline-trimmed
    Type byte            // original frame type, for diagnostics
}

// ---------- reports ----------

type Report struct {                       // generic decode, do this first
    State  string
    Fields map[string][]float64
}

type Status struct {                       // typed view, second
    State             string
    Machine, Work     Vec4                 // X Y Z A
    WCO               Vec4                 // derived, rotation-aware
    RotationAngle     float64
    ActiveCoordSystem int
    Feed              Rate                 // current, target, override
    Spindle           Rate
    Tool              int
    ToolLengthOffset  float64
    Playing           *Playback            // nil when no job is running
    HaltReason        int
    Raw               Report                // always keep the generic map
}

type Playback struct{ Lines, Percent, Seconds int; Active bool }

type Diagnose struct {
    Endstops  Endstops   // xMin xMax yMin yMax zMax cover
    EStop     bool
    Probe     bool
    Switches  map[string]bool
    RSSI      int
    Raw       Report
}

// ---------- machine identity ----------

type MachineInfo struct {
    Model        string   // "Z1" | "C1" | "CA1"
    ModelID      int
    FuncSetting  int
    Version      string   // "1.0.5c"
    Community    bool     // version contains 'c'
    FileTypes    string   // from `ftype`
    Protocol     string   // negotiated
}
```

Keeping `Raw Report` on every typed view is deliberate: when firmware adds a
field, `z1ctl status --format json` still shows it even before we write a
mapping for it.

---

## 11. CLI design

### 11.1 Glazed shape

Every read-style command is a `cmds.GlazeCommand` emitting rows, so it inherits
`--format table|json|jsonl|csv|tsv|yaml`, `--output-fields` and
`--max-output-rows` for free. Action-style commands (`play`, `abort`) are
`BareCommand`s that print a single confirmation, or `GlazeCommand`s emitting one
result row when a machine-readable result is useful.

Verified against the local checkout: `glazed/pkg/cmds/cmds.go:352-380` for the
interfaces, `glazed/cmd/examples/new-api-build-first-command/main.go` for the
canonical shape, `glazed/pkg/cmds/fields/field-type.go:8-46` for field types.

### 11.2 Connection flags as a reusable section

Connection settings belong in a Glazed **section**, mounted on every command that
talks to a machine, so they are declared once:

```go
func NewConnectionSection() (*schema.Section, error) {
    return schema.NewSection(
        "connection",
        "Machine connection",
        schema.WithFields(
            fields.New("device", fields.TypeString,
                fields.WithHelp("Machine address host[:port], or a name from discovery")),
            fields.New("transport", fields.TypeChoice,
                fields.WithChoices("auto", "wifi", "usb"),
                fields.WithDefault("auto"),
                fields.WithHelp("Transport to use")),
            fields.New("protocol", fields.TypeChoice,
                fields.WithChoices("auto", "makera", "smoothie"),
                fields.WithDefault("auto"),
                fields.WithHelp("Wire protocol; 'auto' probes and costs ~300ms")),
            fields.New("timeout", fields.TypeString,
                fields.WithDefault("15s"),
                fields.WithHelp("Per-command timeout")),
            fields.New("connect-timeout", fields.TypeString,
                fields.WithDefault("2s")),
        ),
    )
}
```

Resolution order for `--device` (design inference): explicit flag → `Z1CTL_DEVICE`
env → single machine found by a 3-second discovery sweep → error listing the
candidates.

### 11.3 Command reference

#### `z1ctl discover`

```
z1ctl discover [--timeout 3s] [--all]
```

Binds UDP 3333, collects announcements, emits one row per machine. `--all` keeps
listening for the full timeout instead of returning on the first hit.

```
name          ip             port   busy   seen
Z1_A1B2C3     192.168.1.42   2222   false  1
```

#### `z1ctl status` / `z1ctl watch`

```
z1ctl status                              # one row, exit 0
z1ctl status --format json                # machine-readable
z1ctl watch --interval 200ms --for 30s    # a row per poll, streams as jsonl
```

`status` connects, sends `?`, parses one report, disconnects. `watch` holds the
connection and emits a row per poll — this is where `--format jsonl` shines,
because each line is independently parseable by a downstream process.

Row fields: `time, state, mx, my, mz, ma, wx, wy, wz, wa, feed, feed_target,
feed_ovr, spindle, spindle_target, spindle_ovr, tool, tlo, wcs, playing,
played_lines, played_percent, played_seconds, halt_reason`.

#### `z1ctl exec` / `z1ctl gcode` / `z1ctl realtime`

```
z1ctl exec "version"                  # shell command; prints the reply
z1ctl exec "ls -e -s /sd/gcodes"      # -e form: deterministic termination
z1ctl gcode "G53 G0 Z-2"              # MDI line; waits for 'ok'
z1ctl gcode --file moves.txt          # a line at a time, stop on first error
z1ctl realtime hold|resume|reset|status
```

`exec` is the escape hatch that makes the tool useful during protocol
exploration: anything we have not modelled can still be sent.

`realtime` uses names rather than raw bytes so nobody types `0x18` into a shell
by accident.

#### `z1ctl fs …`

```
z1ctl fs ls /sd/gcodes                       # rows: name, size, timestamp, is_dir
z1ctl fs stat /sd/gcodes/part.nc             # + md5, compressed size
z1ctl fs get /sd/gcodes/part.nc -o ./part.nc
z1ctl fs put ./part.nc --remote /sd/gcodes/  # trailing / ⇒ keep basename
z1ctl fs rm /sd/gcodes/old.nc
z1ctl fs mv /sd/gcodes/a.nc /sd/gcodes/b.nc
z1ctl fs mkdir /sd/gcodes/project
z1ctl fs cat /sd/config.txt
```

`get`/`put` show a progress bar on stderr when stdout is not a TTY-free pipe, so
`--format json` output stays clean.

#### `z1ctl job …`

```
z1ctl job play /sd/gcodes/part.nc [--ocodes]   # -O flag for O-code support
z1ctl job run ./part.nc --remote /sd/gcodes/   # upload + verify + play
z1ctl job pause | resume | abort
z1ctl job progress --watch                     # rows from the P: field
```

`job run` is the ergonomic composite and the command most people will use. It
must refuse to start if the machine is not `Idle` (§17.2).

#### `z1ctl config …`

```
z1ctl config dump                      # config-get-all -e, one row per key
z1ctl config get <key>
z1ctl config set <key> <value>         # config-set sd <key> <value>
```

#### `z1ctl proto …` — the exploration tool

```
z1ctl proto sniff --hex                # decode every frame, annotate the type
z1ctl proto encode --type 0xA2 "version"   # print the frame we WOULD send
z1ctl proto decode 866800 0aa2...          # decode a hex frame from a capture
z1ctl proto probe                          # run detection, report the verdict
```

This group is why the ticket says "explore the protocol overall". `sniff` is the
tool you reach for when the machine does something we do not understand yet.

### 11.4 A worked example command

```go
package cmds

type StatusCommand struct{ *cmds.CommandDescription }

type StatusSettings struct {
    Diagnose bool `glazed:"diagnose"`
}

var _ cmds.GlazeCommand = &StatusCommand{}

func NewStatusCommand() (*StatusCommand, error) {
    connSection, err := NewConnectionSection()
    if err != nil {
        return nil, err
    }
    return &StatusCommand{cmds.NewCommandDescription(
        "status",
        cmds.WithShort("Query one machine status report"),
        cmds.WithLong(`Connect, send the realtime '?' query, emit one row.

Examples:
  z1ctl status
  z1ctl status --format json
  z1ctl status --output-fields state,mx,my,mz`),
        cmds.WithFlags(
            fields.New("diagnose", fields.TypeBool,
                fields.WithDefault(false),
                fields.WithHelp("Also send 'diagnose' and merge sensor fields")),
        ),
        cmds.WithSections(connSection),
    )}, nil
}

func (c *StatusCommand) RunIntoGlazeProcessor(
    ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
    s := &StatusSettings{}
    if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
        return errors.Wrap(err, "decode settings")
    }
    conn := &ConnectionSettings{}
    if err := vals.DecodeSectionInto("connection", conn); err != nil {
        return errors.Wrap(err, "decode connection settings")
    }

    client, err := makera.Dial(ctx, conn.ToOptions()...)
    if err != nil {
        return errors.Wrap(err, "connect to machine")
    }
    defer client.Close()

    st, err := client.QueryStatus(ctx)
    if err != nil {
        return errors.Wrap(err, "query status")
    }

    row := types.NewRow(
        types.MRP("state", st.State),
        types.MRP("mx", st.Machine.X), types.MRP("my", st.Machine.Y),
        types.MRP("mz", st.Machine.Z), types.MRP("ma", st.Machine.A),
        types.MRP("wx", st.Work.X), types.MRP("wy", st.Work.Y),
        types.MRP("wz", st.Work.Z), types.MRP("wa", st.Work.A),
        types.MRP("feed", st.Feed.Current),
        types.MRP("spindle", st.Spindle.Current),
        types.MRP("tool", st.Tool),
        types.MRP("wcs", wcsName(st.ActiveCoordSystem)),
    )
    if st.Playing != nil {
        row.Set("played_percent", st.Playing.Percent)
        row.Set("played_lines", st.Playing.Lines)
    }
    if s.Diagnose {
        d, err := client.QueryDiagnose(ctx)
        if err != nil {
            return errors.Wrap(err, "query diagnose")
        }
        row.Set("cover_open", d.Endstops.Cover)
        row.Set("estop", d.EStop)
        row.Set("rssi", d.RSSI)
    }
    return gp.AddRow(ctx, row)
}
```

Registration in `main.go` follows the local example
(`glazed/cmd/examples/new-api-build-first-command/main.go:140-167`): build each
command with `cli.BuildCobraCommand` (or `cli.AddCommandsToRootCommand` for the
whole set), install the logging section with
`logging.AddLoggingSectionToRootCommand`, and wire the embedded help system.

---

## 12. Decision records

### ADR-001 — Implement the wire protocol in Go rather than shelling out to Python

**Context.** The Community Controller already speaks the Z1 protocol. We could
drive it as a subprocess.
**Options.** (a) Go implementation. (b) Subprocess the Python controller.
(c) Embed a Python runtime.
**Decision.** (a).
**Rationale.** The controller is a Kivy GUI application, not a library with a
stable API; there is no headless entry point. The protocol is small — the codec
is under 150 lines of Go, already written and passing (§18.1). Shipping a Python
runtime and a Kivy dependency tree to run one CLI is also absurd on its own
terms, independent of licensing.
**Consequences.** We own protocol correctness. Mitigated by golden vectors, by
this document's citations, and — since ADR-008 put `z1ctl` under the same licence
as the community controller — by the option to port upstream logic where
re-derivation is riskier than reuse. **Status: accepted.**

### ADR-002 — Target the framed Makera protocol first; support Smoothie as a fallback

**Context.** Two protocols exist. The Z1 is the target machine.
**Decision.** Implement `MakeraProtocol` fully in phase 1; implement
`SmoothieProtocol` (which is trivial — append `\n`, split on `\n`) at the same
time because it costs almost nothing and makes autodetection meaningful.
**Rationale.** Autodetection without a second implementation is theatre; and the
Smoothie path is ~40 lines.
**Consequences.** Legacy file transfer (`send_legacy`/`recv_legacy`, real XMODEM
with SOH/STX/ACK/NAK) is deliberately **not** implemented in phase 1. Legacy
machines get commands and status but not file transfer. Documented limitation.
**Status: accepted.**

### ADR-003 — One reader goroutine with an explicit mode, instead of pause-and-spin

**Context.** Upstream pauses its RX thread and busy-waits up to 1 s for it to
park before a file transfer (`Controller.py:2140-2152`).
**Options.** (a) Port the pause/park pattern. (b) Single reader + mode switch.
(c) Separate connections for transfer.
**Decision.** (b). (c) is impossible — the machine accepts one connection.
**Rationale.** Deterministic, no sleeps, no window where two consumers can race
the socket. The mode flag is checked in exactly one place.
**Consequences.** The transfer driver must always drain `c.frames`, or the reader
blocks. Enforce with a buffered channel plus context cancellation.
**Status: accepted.**

### ADR-004 — Use the `-e` form and the echo sentinel for command completion

**Context.** No request IDs, no universal terminator.
**Decision.** Prefer `-e` (EOT-terminated) command forms; otherwise append an
`echo \x04` sentinel in the same write; for G-code additionally assert `ok`.
**Rationale.** Both mechanisms are already firmware behaviour, so we are not
inventing a protocol. The sentinel is proven in `hagmonk/carvera-cli`.
**Consequences.** Every command needs a deadline anyway, because a machine in an
alarm state may answer nothing. Default 15 s, overridable.
**Status: accepted.**

### ADR-005 — No QuickLZ compression in phase 1

**Context.** Firmware accepts `.lz` uploads when `ftype` says so.
**Decision.** Upload raw files. Revisit if upload time is a real complaint.
**Rationale.** No maintained Go QuickLZ; `.nc` files are small; 8 KB Wi-Fi blocks
are fast; compression adds a whole failure mode (deferred MD5, `.lz` directory
bookkeeping, `decompart` progress tracking).
**Consequences.** Slower uploads for large files. Downloads must still *handle*
receiving `.lz` payloads (detect the `\x00\x00` prefix, defer the MD5 check, and
report that decompression is unsupported rather than writing a corrupt file).
**Status: accepted.**

### ADR-006 — Wi-Fi transport first, USB second

**Context.** Both transports exist; USB has reset-on-open and a different block
size.
**Decision.** Ship TCP in phase 1; serial in phase 4.
**Rationale.** TCP has no external dependency, no reset hazard, and the 8 KB block
size makes transfer testing faster. USB matters mainly for recovery scenarios.
**Consequences.** No recovery path when Wi-Fi is misconfigured, until phase 4.
**Status: accepted.**

### ADR-007 — Validate the advertised MD5 as 32 *hex* characters, not 32 characters

**Context.** Z1 firmware returns `default_md5_hash_value_32_bytes_`.
**Decision.** Require `^[0-9a-f]{32}$` after lowercasing; anything else means "no
digest advertised" and the integrity check is skipped with a warning.
**Rationale.** Directly matches upstream's fix and the Z1 release note.
**Consequences.** Z1 downloads are unverified until firmware is fixed. `z1ctl`
must say so on stderr rather than silently passing.
**Status: accepted.**

### ADR-008 — License `z1ctl` under GPL-2.0; port from the community controller, attribute upstream, publish the spec

**Context.** Of the four reference implementations, only the two GPL ones support
the Z1's framed protocol: `Carvera-Community/Carvera_Controller` (**GPL-2.0**)
and `MakeraInc/CarveraController` (**GPL-3.0** — verified in the clone, not
GPL-2.0 as the brief implied). The remaining two are legacy-protocol-only, and
`hagmonk/carvera-cli` turns out to carry no licence text at all. The licence
choice determines whether we may port upstream code or must re-derive everything
from a specification.

**Options.**
(a) MIT, implemented strictly from a written specification, no upstream code.
(b) **GPL-2.0**, matching the community controller, free to port from it.
(c) MIT with a GPL subprocess dependency on the Python controller.

**Decision.** (b) — **GPL-2.0**. Ship the licence text, credit the upstream
projects in a `NOTICE`, mark every ported file with its provenance, and publish
the protocol specification in the repository as `docs/protocol.md`.

**Rationale.** Matching the community controller's licence puts `z1ctl` in the
same family as the ecosystem that produced the protocol knowledge, and removes
the constraint that shaped the earlier plan: upstream's file-transfer state
machines — the highest-risk part of the implementation, full of retry, cancel
and out-of-order-block handling that took the community real machine time to get
right — can now be ported rather than re-derived. Option (a) forced us to
re-invent exactly the code we least want to re-invent. Option (c) was already
rejected by ADR-001 on engineering grounds and drags GPL into the distribution
anyway.

**Open sub-decision: GPLv2-only vs GPLv2-or-later.** The community controller
carries no "or any later version" grant, so it is effectively GPLv2-only, and a
GPLv2-only `z1ctl` can never absorb GPLv3 OEM code. **Recommendation:
GPL-2.0-or-later**, which behaves identically today but permits combining with
GPLv3 code later by distributing the combination under GPLv3. Cheap now, painful
to change once there are outside contributors. See §3.5.2.

**Consequences.**
- **Any work that links `pkg/makera` is a derivative work and must be GPL.** This
  reaches the future device control UI. If that UI needs to be permissive, keep
  the boundary at the process (`z1ctl --format json`) or split out a
  spec-derived permissive core. Planned for in §3.5.3.
- Ported code must carry a header naming the upstream file and commit
  (`777482a`) and stating that upstream is GPL-2.0. Reviewers must be able to
  distinguish ported from original code.
- Port `filexfer.go`, where upstream's scar tissue is worth more than our
  re-derivation. Keep the already-written, already-tested `frame.go` and
  `status.go` from `scripts/02` and `scripts/04` — a preference on merit now, not
  a legal requirement.
- The community controller's own `NOTICE` credits bCNC (GPL-2.0) and the XMODEM
  library (MIT); that lineage must be carried forward into ours if we port the
  file-transfer code.
- **No code from `MakeraInc/CarveraController` (GPL-3.0)** unless the "or later"
  sub-decision goes that way. It remains a factual reference, which is all we
  have used it for.
- **No code from `hagmonk/carvera-cli`** until its author clarifies the licence.
  Its ideas remain free to use.
- `vendor/` stays research evidence inside the ticket and never becomes a
  dependency — porting means copying reviewed code into our tree with
  attribution, not importing the clone.
- Someone must keep `docs/protocol.md` in sync with `reference/02` as hardware
  testing corrects it.

**Status: accepted** (decided by the ticket owner, 2026-08-11). Supersedes an
earlier MIT decision taken and reversed the same day; the MIT plan is retained in
§3.5.3 as the fallback if a permissive core is ever required.

---

## 13. Core flows

### 13.1 Connect

```
 1. resolve --device
      explicit flag → env Z1CTL_DEVICE → discovery sweep (3 s)
 2. TCP dial ip:2222, connect timeout 2 s
      connection refused ⇒ "machine busy (another controller is connected)"
 3. set read deadline behaviour to 0.3 s steady state
 4. protocol detect  (--protocol auto)
      drain RX
      3 × { send raw b"echo echo\n"; sleep 100 ms; read ≤10 B, 100 ms }
      any reply containing "echo"  ⇒ smoothie
      otherwise                    ⇒ makera
 5. start readLoop goroutine in ModeControl
 6. identity: send "version", "model", "ftype" with echo sentinels
      cache MachineInfo{Model, ModelID, FuncSetting, Version, Community, FileTypes}
 7. (optional) start the status poller at 200 ms
```

### 13.2 Send a G-code line and wait for `ok`

```
 encode:  frame(0xA2, strip_trailing_newlines("G53 G0 Z-2"))
 write:   one Write call
 write:   frame(0xA2, "echo \x04")          ← sentinel, same tick
 loop until sentinel or deadline:
    line = next control-mode message
    if line == "ok"                      → sawOK = true
    if line starts with "error"/"ALARM"  → collect, will fail
    if line contains \x04                → done
 result: sawOK && no error lines
```

### 13.3 Upload and run a job (`z1ctl job run`)

```
 ┌ preflight ─────────────────────────────────────────────────────┐
 │  status.State must be "Idle"          else refuse              │
 │  diagnose.Endstops.Cover must be closed  else refuse (--force) │
 │  local file must parse as text and be non-empty                │
 └────────────────────────────────────────────────────────────────┘
        │
        ▼
   md5 = md5sum(local file)
   remote = join(--remote, basename(local))
        │
        ▼
   mode = ModeTransfer
   send frame(0xB0, "upload <escaped remote>\n")
   run the upload state machine (§9.2), 8192-byte blocks over Wi-Fi
   mode = ModeControl
        │
        ▼
   verify: exec "md5sum <remote> -e"
     digest is 32 hex chars and matches   → verified
     digest is the Z1 placeholder         → warn "integrity unverified (Z1 fw)"
     mismatch                              → fail, do NOT play
        │
        ▼
   send "play <escaped remote>"
        │
        ▼
   poll status every 200 ms; emit a progress row per change of P:
   exit 0 when state returns to Idle and P: disappears
   exit non-zero on state == Alarm, with H: halt reason
```

### 13.4 Failure and recovery

| Symptom | Likely cause | Response |
|---|---|---|
| TCP connect refused | Another controller holds the socket | Report "machine busy"; suggest closing the other app |
| Detection returns `smoothie` on a Z1 | The probe raced firmware boot | Retry once after 1 s; expose `--protocol makera` |
| Repeated CRC/footer failures | False-header lock-on (§5.6) or a genuinely noisy link | Log each drop with a hex dump; reset the parser; if >N in a window, reconnect |
| Transfer stalls | Machine stopped requesting blocks | 9 s no-frame timeout → send `FILE_CAN`, fail cleanly, leave the partial remote file alone |
| `ok` never arrives | Machine in Alarm | Surface the last `ALARM`/`error` line; suggest `$X` |
| Status shows `Alarm` mid-job | Endstop, probe fault, cover opened | Report `H:` halt reason; do not auto-resume |

---

## 14. Implementation plan

Phases are ordered so that **every phase ends with something demonstrable**, and
the first two need no machine at all.

### Phase 0 — Scaffolding (no machine needed)

- `dropcut-studio/makera-z1-cli/go.mod`, `Makefile`, add to `go.work`.
- `LICENSE` (full GPL-2.0 text), `NOTICE` with the attribution text from §3.6,
  README linking both and the upstream projects (ADR-008). Settle the
  GPLv2-only vs GPLv2-or-later sub-decision here (§3.5.2) — it goes in every
  file header, so decide before there are file headers.
- `docs/protocol.md` — a copy of `reference/02-makera-wire-protocol-reference.md`,
  published as the specification this implementation follows.
- `cmd/z1ctl/main.go`: cobra root, `logging.AddLoggingSectionToRootCommand`,
  embedded help system.
- One placeholder command so `go run ./cmd/z1ctl --help` works.

**Done when:** `GOWORK=off go build ./... && go vet ./...` is clean,
`z1ctl --help` prints, and `LICENSE`/`NOTICE`/`docs/protocol.md` are in place.

### Phase 1 — Codec and reports (no machine needed)

- `pkg/makera/frame.go` — port `scripts/02-goframe/main.go` verbatim; it already
  passes.
- `pkg/makera/frame_test.go` — the golden vectors from
  `scripts/01-frame-vectors.py`, plus the split/garbage/CRC/oversize cases.
- `pkg/makera/status.go` — port `scripts/04-gostatus/main.go`; add `Status`,
  `Diagnose` typed views and the rotation-aware WCO derivation.
- `pkg/makera/escape.go` + round-trip tests.
- `z1ctl proto encode|decode` so a human can eyeball frames.

**Done when:** `go test ./pkg/makera/...` passes and
`z1ctl proto encode --type 0xA2 version` prints
`8668000aa276657273696f6ecca055aa`.

### Phase 2 — Discovery and read-only control (first machine contact)

- `discovery.go` — UDP listener, 3 s sweep, dedupe by name.
- `transport_tcp.go`, `client.go` (readLoop, ModeControl only), `detect.go`.
- Commands: `discover`, `status`, `watch`, `exec`, `proto sniff`, `proto probe`.

**Done when:** `z1ctl discover` finds the Z1, `z1ctl status --format json` prints
a real report, and `z1ctl exec version` shows the firmware version. **Nothing in
this phase can move the machine.** That is deliberate.

### Phase 3 — File system and job control

- `filexfer.go` — upload and download state machines, `ModeTransfer`.
- Bulk-listing reassembly (`LOAD_INFO` → `LOAD_FINISH`) for `ls`/`cat`/config.
- Commands: `fs ls|stat|get|put|rm|mv|mkdir|cat`, `config dump|get|set`,
  `job play|pause|resume|abort|progress|run`, `gcode`, `realtime`.
- MD5 policy per ADR-007.

**Done when:** `z1ctl job run ./demo.nc` uploads, verifies (or warns), plays, and
streams progress rows to completion on a real Z1 — **with the spindle disabled
and an air cut**. See §17.

### Phase 4 — USB transport and polish

- `transport_serial.go` (115200, 2 s post-open settle, 128-byte blocks).
- `--protocol smoothie` end-to-end validation if a legacy machine is available.
- `z1ctl doctor` (§17.2), shell completions, `glaze help` documentation pages.

### Phase 5 — Deferred / separate tickets

Camera (§9.4), firmware upload, QuickLZ, the device-control UI.

### Effort sketch (design inference)

| Phase | Rough size |
|---|---|
| 0 | half a day |
| 1 | 1–2 days (the hard part is already done in `scripts/`) |
| 2 | 2–3 days |
| 3 | 3–5 days — the file-transfer state machines carry the risk |
| 4 | 2–3 days |

---

## 15. Testing and validation strategy

### 15.1 Offline (must pass before touching hardware)

| Level | What |
|---|---|
| **Golden vectors** | Encoder output byte-compared against `scripts/01` vectors |
| **Fuzz-ish decode** | Every 2-way split of every vector; random garbage prefixes; truncated frames; oversized lengths |
| **CRC** | Check value `crc16("123456789") == 0x31C3` |
| **Round-trip** | encode → decode → identical type and payload for every vector |
| **Report grammar** | Documented sample lines, minimal lines, trailing junk, unknown keys, malformed input (all in `scripts/04`) |
| **Escaping** | escape → unescape round-trip over a filename containing every special character |
| **Newline rules** | `0xA2` strips, `0xB0` appends, smoothie appends — one test each |

### 15.2 Fake-machine integration tests

Build a `fakemachine` test double implementing `Transport` that:

- answers `?` with a canned status line,
- answers the echo sentinel,
- drives a complete upload conversation (`FILE_MD5` → `FILE_VIEW` → N ×
  `FILE_DATA` → `FILE_END`), including a deliberate out-of-order block request
  and one `FILE_RETRY`,
- answers `md5sum` with the Z1 placeholder, so ADR-007 is exercised,
- can inject garbage bytes and CRC errors on demand.

This is where most of the real bugs will be caught. `GridSpace/carve-control`
implements a machine *spoofer* (`spoof=1`) for exactly this reason — worth
reading `vendor/gridspace-carve-control/lib/c-spoof.js` before writing ours.

### 15.3 Hardware bring-up, in this order

1. `z1ctl discover` — passive, cannot affect the machine.
2. `z1ctl proto probe` — sends `echo echo`, harmless.
3. `z1ctl status`, `z1ctl exec version|model|ftype` — read-only.
4. `z1ctl fs ls /sd/gcodes`, `z1ctl fs get` — read-only bulk transfer.
5. `z1ctl fs put` of a small text file to a scratch directory — first write.
6. `z1ctl gcode "G53 G0 Z-2"` — **first motion.** Z only, retracting, machine
   coordinates. Hand on the E-stop.
7. `z1ctl job run` of an air-cutting program with the spindle off.
8. Only then, a real job.

### 15.4 Command validation

Run from `dropcut-studio/makera-z1-cli/`:

```bash
gofmt -w .
GOWORK=off go test ./... -count=1
GOWORK=off go build ./...
GOWORK=off go vet ./...
GOWORK=off make glazed-lint
git diff --check
```

Then confirm the structured-output group on a representative command contains
only `--format`, `--output-fields`, `--max-output-rows`:

```bash
go run ./cmd/z1ctl status --help
```

---

## 16. Observability

Use zerolog, with a `--log-level` flag, per the workspace conventions in
`AGENT.md`.

| Level | What to log |
|---|---|
| `trace` | Every frame, hex-dumped, with direction and decoded type |
| `debug` | Every command sent and every line received; protocol detection verdict; transfer block numbers |
| `info` | Connect/disconnect with transport and address; protocol selected; machine model and firmware; transfer start/finish with byte counts |
| `warn` | CRC/footer drops; MD5 skipped because the machine advertised a placeholder; retries |
| `error` | Transfer aborted; machine entered Alarm; connection lost |

Upstream logs connect and manual disconnect with method and address
(release note, `sources/web/01-...:` "Log connect and manual disconnect with the
connection method and address"). Match that — it makes support conversations
tractable.

`z1ctl proto sniff --hex` should print a frame log that a human can diff against
a Wireshark capture:

```
16:04:22.113 → 0xA1 CTRL_SINGLE   len=4    3f                     "?"
16:04:22.147 ← 0x81 STATUS_RES    len=78   3c 49 64 6c 65 ...     "<Idle|MPos:...>"
16:04:22.313 → 0xA1 CTRL_SINGLE   len=4    3f                     "?"
```

---

# Part IV — Not getting it wrong

## 17. Safety

This section is not boilerplate. A CNC mill moves a spinning cutter at a
kilowatt-scale power level, and a bug in a command-line tool becomes a broken
tool, a ruined workpiece, or an injury.

### 17.1 Rules for the implementation

1. **No motion command is issued without an explicit user action.** Never as a
   side effect of a status query, a retry, or a reconnect.
2. **Never auto-resume.** If a job halts, report the halt reason and stop. The
   human decides.
3. **Never auto-retry a motion command.** Retrying `G0` after a timeout can
   execute the move twice.
4. **Retract Z before any XY move.** Follow upstream's `G53 G0 Z-2` idiom
   (§7.6).
5. **`reset` over USB is blocked.** Upstream refuses it and directs the user to
   the power switch, because a soft reset over USB leaves the board in a zombie
   state (`Controller.py:240-243`). Mirror that refusal.
6. **`--force` exists for preflight overrides, and prints what it is overriding.**
7. **Exit codes are meaningful.** 0 success; 1 usage/connection error; 2 machine
   refused / preflight failed; 3 job ended in Alarm. Scripts depend on this.

### 17.2 `z1ctl doctor` — the preflight command

> **Blocked on a hardware check.** This command's cover/endstop lines read the
> `E:` vector of the diagnose report, which has **8 values on real Z1 firmware,
> not the 6 that upstream maps** (`reference/03` §4). The field order is
> unconfirmed, so a naive implementation could read the wrong bit and report
> "cover: closed" when it is open. **Confirm the mapping empirically — open the
> cover, capture `diagnose`, diff — before implementing any interlock on it.**

A single command that answers "is it safe to start?":

```
z1ctl doctor
  ✓ discovered Z1_A1B2C3 at 192.168.1.42:2222
  ✓ protocol: makera (framed)
  ✓ firmware: 1.0.5c (community), model Z1
  ✓ state: Idle
  ✓ cover: closed
  ✓ e-stop: clear
  ✓ endstops: all clear
  ! md5sum returns the Z1 placeholder — upload integrity cannot be verified
  ✓ wifi rssi: -57 dBm
```

Each line is a row when `--format json` is used, so CI or a wrapper script can
gate on it.

### 17.3 What this tool must never do without a very deliberate flag

- Home the machine (`$H`) — homing moves all axes at speed.
- Start the spindle (`M3`).
- Run a tool change (`M6`).
- Write to `/sd/firmware.bin`.
- Issue `config-default` (factory reset).

Put these behind a `--i-know-what-this-does` style confirmation or leave them out
of phase 1 entirely.

---

## 18. Evidence and what we validated

### 18.1 Experiments in this ticket

| Script | Assumption tested | Result |
|---|---|---|
| `scripts/01-frame-vectors.py` | Frame layout, `LENGTH = N+3`, CRC init 0 over length+type+payload | **PASS** — a from-scratch encoder matches the vendored implementation on all 10 vectors; `crc16("123456789") == 0x31C3` |
| `scripts/02-goframe/main.go` | The codec ports to dependency-free Go; the RX state machine survives real TCP behaviour | **PASS** — encode matches vectors byte-for-byte; round-trip; every 2-way split; two frames per read; CRC corruption dropped; oversized length rejected; false-header limitation reproduced and documented |
| `scripts/03-discover.py` | Discovery record grammar `name,ip,port,busy[,…]` and its rejection cases | **PASS** (offline self-test). Live `--listen` mode is ready for hardware |
| `scripts/04-gostatus/main.go` | One generic decoder handles both `<...>` and `{...}`; optional keys degrade safely | **PASS** — documented sample lines, minimal lines, trailing junk, `RSSI:-57` first-colon split, unknown future keys, malformed input |

Reproduce everything:

```bash
cd <ticket>
python3 scripts/01-frame-vectors.py
python3 scripts/03-discover.py --self-test
( cd scripts/02-goframe  && GOWORK=off go run . )
( cd scripts/04-gostatus && GOWORK=off go run . )
```

### 18.2 Validated against real hardware — 2026-08-11

A read-only session against `Makera_Z1_012146` (firmware `1.0.15.0.1.11`)
confirmed the **entire wire layer** of this document:

| Claim | Result |
|---|---|
| Frame layout, `LENGTH = payload + 3` | ✅ every frame we built was accepted |
| CRC-16/CCITT, init `0x0000`, over length+type+payload | ✅ **zero decoder drops** across five sessions |
| `0xA2` must not carry a trailing newline | ✅ every command sent without one was understood |
| `0xA1` realtime `?` | ✅ status returned |
| Detection: unframed `echo echo` → silence → `makera` | ✅ silence on all three probes |
| Echo sentinel terminates command output | ✅ returned as `0x90` with payload `echo: \x04\r\n` |
| Discovery record grammar | ✅ (and it has a fifth field — see below) |
| Generic report decoding before interpretation (§8.1) | ✅ vindicated — two undocumented keys came through as data, not errors |

**The payload formats are a different story.** Ten-plus divergences from the
source-derived spec were found, several of which would have produced wrong
results in production. They are recorded in
**`reference/03-live-z1-observations-firmware-1-0-15.md`**, which is
authoritative wherever it disagrees with this guide or with `reference/02`.

The ones that change the design:

- **`ftype = nc`** — this firmware accepts **no** compressed uploads. ADR-005 is
  now a statement of fact rather than a trade-off.
- **`MPos`/`WPos` carry five axes** (X, Y, Z, A, B), not three or four.
  Independently confirmed by `get pos`.
- **The status report has no `G:` key** on stock firmware, so the active
  coordinate system must be read with **`get wcs`**. §11.3's `status` command
  needs that extra round trip.
- **The diagnose `E:` vector has 8 values, not 6.** Since §17.2 proposes gating
  job start on the cover bit inside `E:`, **that interlock cannot be implemented
  until the field order is confirmed on hardware** (open the cover, diff the
  capture). This is now the first hardware task.
- **`md5sum` returns a genuine digest** concatenated with the path and no
  separator — so upload verification (§13.3) is trustworthy on this firmware.
  Keep ADR-007's hex validation anyway; the download path is still unproven.
- **`help` is incomplete** — `model`, `ftype`, `time` and `echo` all work but are
  unlisted. It also reveals a useful query family (`get pos|wcs|state`,
  `progress`, `mem`, `net`) that was invisible from the controller source.
- **The machine has ~7.6 KB of free RAM** (`mem`). Keep command rates
  conservative; the 8 KB transfer block is near its whole budget.

### 18.3 Still not validated

- **The framed file transfer (§9) has not been exercised at all.** It is the
  highest-risk part of the implementation and the probe is read-only by
  construction. Phase 3 is where the real unknowns are.
- Whether the download path returns the placeholder MD5 (§9.4).
- Whether `config_z1.json` keys apply as-is — run `config-get-all -e` and diff.
- The legacy Smoothie protocol, for want of a legacy machine.

---

## 19. Risks, gaps and open questions

### 19.1 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Z1 support upstream is a **release candidate**, one week old | Behaviour may change under us | Pin the vendored clone (`777482a`); re-diff `protocols/` before each phase |
| Firmware differences between stock Z1 and Community firmware | Fields present/absent, `R:` and `H:` only on community | Generic report decoding (§8.1); never index a vector without a length check |
| The false-header desync (§5.6) | Silent frame loss | Log every CRC/footer drop; reconnect after N drops in a window |
| Single-connection constraint | `z1ctl` fights the GUI controller | Detect "connection refused" and say *why*; keep sessions short |
| No auth on the control port | Anyone on the LAN can move the machine | Out of our control; document it. Do not add a network listener to `z1ctl` |
| GPL provenance of the reference implementations | Licensing | **Resolved (ADR-008):** `z1ctl` is GPL-2.0, matching the community controller, so porting from it is permitted with notices and provenance headers (§3.5). Residual risks: (a) the GPLv2-only vs -or-later sub-decision is still open (§3.5.2); (b) OEM code is GPLv3 and must stay out; (c) `hagmonk/carvera-cli` has no licence at all |
| Copyleft reaches the future device control UI | A permissive or proprietary UI cannot link `pkg/makera` | Keep the boundary at the process — the UI shells out to `z1ctl` and reads `--format json`. Fallback is a spec-derived permissive core (§3.5.3). Decide before the UI ticket starts, not during it |

### 19.2 Open questions — resolve these with hardware

1. What does `help` list on Z1 firmware? Are there commands nobody has documented?
2. What are the exact `ls -e -s` columns on the Z1 (and how are directories
   marked)?
3. Does the Z1 emit `M485` protocol announcements, or is the active probe the only
   detection path?
4. Does the Z1 accept `.lz` uploads (what does `ftype` return)?
5. Does the placeholder-MD5 bug also affect `md5sum` used for *upload*
   verification, or only the download digest exchange?
6. `config_z1.json` exists in the community controller
   (`carveracontroller/config_z1.json`) but `load_machine_config_data` only maps
   `C1` and `CA1` (`main.py:5296-5302`) — so the Z1 config schema is shipped but
   **not wired up**. Is that an upstream oversight, or does the Z1 config surface
   differ enough that it was deliberately left out?
7. What are the Z1's actual soft limits and machine dimensions? The controller
   only records rotary geometry for it (`rotation_base_width = 263`,
   `rotation_head_width = 50`, `main.py:5115-5117`).

---

## 20. Intern onboarding checklist

### Day 1 — read

1. This document, §1, §4, §5, §7 (about 45 minutes).
2. `vendor/community-carvera-controller/carveracontroller/protocols/` — all seven
   files, about 700 lines total. This is the cleanest description of the protocol
   that exists.
3. `reference/02-makera-wire-protocol-reference.md` in this ticket — the terse
   version to keep open while coding.
4. Skim `reference/01-investigation-diary.md` to see how these conclusions were
   reached (and which ones were corrections).

### Day 1 — run

```bash
cd <ticket>
python3 scripts/01-frame-vectors.py        # see the frames
( cd scripts/02-goframe && GOWORK=off go run . )   # see the Go codec pass
( cd scripts/04-gostatus && GOWORK=off go run . )  # see the report parser pass
python3 scripts/03-discover.py --self-test
```

Then, if hardware is on the network:

```bash
python3 scripts/03-discover.py --listen 15
```

### Day 2 — write

Start at **Phase 0**, then **Phase 1** (§14). Phase 1 is a port of two files that
already work — you will have a tested Go codec by lunchtime and can spend the
afternoon on `z1ctl proto encode/decode`, which makes everything after it easier
to debug.

### Things that will bite you, ranked

1. `LENGTH` is `payload + 3`, not `payload` (§5.1).
2. CRC init is `0x0000`, not `0xFFFF` (§5.2).
3. `0xA2` frames must **not** end in `\n`; `0xB0` frames **must** (§5.5).
4. A realtime digram (`?` + keepalive) must be a **single** write (§7.2).
5. Filenames must be escaped — space → `0x01`, `?` → `0x02`, … (§7.4).
6. File transfer is **machine-driven**; you answer requests, you do not push (§9.1).
7. Sequence numbers are **1-based** and may arrive out of order (§9.2).
8. The Z1's `md5sum` placeholder is 32 characters but not hex (§9.4).
9. Status keys are all optional and their vectors grow — never index blindly (§8.1).
10. Only one client can hold the socket (§4.3).

---

## 21. References

### Local — this ticket

| Path | What it is |
|---|---|
| `reference/02-makera-wire-protocol-reference.md` | Terse protocol spec for use while coding |
| `reference/01-investigation-diary.md` | Chronological record of how these conclusions were reached |
| `scripts/01-frame-vectors.py` | Frame golden vectors; cross-checks against upstream |
| `scripts/02-goframe/main.go` | Go codec + RX state machine, with adversarial tests |
| `scripts/03-discover.py` | Discovery parser self-test and live listener |
| `scripts/04-gostatus/main.go` | Report grammar decoder + typed status view |
| `sources/web/01-…releases.raw.md` | Community Controller release notes (Z1 support, 04 Aug 2026) |
| `sources/web/02-…makera-oem…raw.md` | OEM controller repository overview |
| `sources/web/03-…hagmonk…raw.md` | `carvera-cli` README |
| `sources/web/04-…gridspace…raw.md` | `carve-control` README |

### Vendored upstream — the citations in this document

| Path | Why it matters |
|---|---|
| `vendor/community-carvera-controller/carveracontroller/protocols/framing.py` | Frame layout, CRC table, encoder, validator |
| `…/protocols/makera.py` | Framed protocol: encoders, RX state machine, type dispatch |
| `…/protocols/smoothie.py` | Legacy text protocol |
| `…/protocols/detector.py` | Active protocol probe |
| `…/protocols/session.py` | Session ownership, mid-session switching, M485 announcements |
| `…/WIFIStream.py` | Discovery, TCP transport, busy check |
| `…/USBStream.py` | Serial transport, baud, timeouts |
| `…/XMODEM.py` | Both file-transfer protocols; MD5 policy; the Z1 placeholder quirk |
| `…/Controller.py` | Command surface, status/diagnose parsers, control loop, pause/resume |
| `…/main.py` | Upload orchestration, compression, version/model regexes |
| `…/addons/camera/Z1Camera.py` | Z1 camera transport |
| `…/config_z1.json` | Z1 configuration schema (shipped but unwired) |
| `vendor/makera-carvera-controller/src/Controller.py` | OEM framing with the original Chinese specification comments |
| `vendor/hagmonk-carvera-cli/src/carvera_cli/device/manager.py` | Echo sentinel, escaping, `ls`/`stat` parsing (legacy protocol) |
| `vendor/gridspace-carve-control/lib/` | Discovery, proxy and machine-spoofing patterns |

### Glazed — verified against the local checkout

| Path | What |
|---|---|
| `glazed/pkg/cmds/cmds.go:352-380` | `BareCommand`, `WriterCommand`, `GlazeCommand` |
| `glazed/cmd/examples/new-api-build-first-command/main.go` | Canonical command + registration shape |
| `glazed/pkg/cmds/fields/field-type.go:8-46` | Field types |
| `glazed/pkg/cli/cobra.go:345-400` | `BuildCobraCommand`, `AddCommandsToRootCommand` |
| `glazed/pkg/doc/topics/32-structured-output.md` | The three universal output flags |
| `glazed/pkg/doc/topics/sections-guide.md` | Custom sections (used for connection flags) |

### External

- Carvera Community Controller — https://github.com/Carvera-Community/Carvera_Controller
- MakeraInc CarveraController — https://github.com/MakeraInc/CarveraController
- hagmonk/carvera-cli — https://github.com/hagmonk/carvera-cli
- GridSpace/carve-control — https://github.com/GridSpace/carve-control
- Glazed — https://github.com/go-go-golems/glazed
