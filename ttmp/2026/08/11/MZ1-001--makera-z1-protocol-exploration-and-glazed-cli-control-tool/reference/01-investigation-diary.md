---
Title: Investigation Diary
Ticket: MZ1-001
Status: active
Topics:
    - research
    - protocol
    - cnc
DocType: reference
Intent: long-term
Owners: []
RelatedFiles: []
ExternalSources:
    - https://github.com/Carvera-Community/Carvera_Controller
Summary: "Chronological record of the MZ1-001 protocol investigation: what was cloned, what was read, which experiments were written, what they proved, which prior assumptions were corrected, and what remains unverified."
LastUpdated: 2026-08-11T17:00:00-04:00
WhatFor: "Understanding how the design guide's conclusions were reached and which of them are still unverified against hardware."
WhenToUse: "Before resuming MZ1-001, or when a claim in the design guide needs to be re-derived."
---

# MZ1-001 — Investigation Diary

## 0. The original prompt

> Create a new docmgr ticket to create a CLI tool (glazed) to control the Makera
> Z1 and explore the protocol overall (we will create a proper device control UI
> later). You can clone repositories into this workspace if you want.
>
> [Upfront research supplied: Carvera Community Controller v2.2.0-RC1 adds
> "Initial Z1 support"; MakeraInc/CarveraController has the networking in Python;
> hagmonk/carvera-cli is a small MIT CLI; GridSpace/carve-control is a Node
> proxy. UDP 3333 discovery, TCP 2222 control. Frame: header 0x8668, length,
> type, payload, CRC16, footer 0x55AA. CRC-16/CCITT poly 0x1021 init 0 over
> length+type+payload. Types A1/A2/B0 outbound, 81/82/83/84/85/90 inbound.
> Upload then `play`, XMODEM-derived transfer.]
>
> Create a detailed analysis / design / implementation guide that is for a new
> intern, explaining all the parts of the system needed to understand what it is,
> with prose paragraphs and bullet points and pseudocode and diagrams and api
> references and file references. It should be very clear and technical. Store in
> the ticket and then upload to reMarkable.

**Reading of the ask.** Two deliverables: (1) a real protocol investigation
grounded in source, not a restatement of the prompt; (2) an intern-ready design
document for a Glazed Go CLI. The upfront research was treated as a set of
hypotheses to verify, not as facts to copy — and two of them turned out to need
correction (see §6).

---

## 1. Orientation

```bash
pwd                                   # /home/manuel/workspaces/2026-08-11/cnc-control-dropcut
ls -la
docmgr status --summary-only
docmgr ticket list
docmgr vocab list
cat .ttmp.yaml go.work
```

Findings:

- Workspace contains `dropcut-studio` (TypeScript/pnpm CAM monorepo, **no
  `go.mod`**) and `glazed` (the Go framework, `go 1.26.1`). `go.work` uses only
  `./glazed`.
- docmgr root is `dropcut-studio/ttmp`; two existing tickets (CAM-001, CAM-002),
  both CAM-side.
- `AGENT.md` sets the Go conventions: cobra, `github.com/pkg/errors`, zerolog
  with `--log-level`, `errgroup`, `var _ Interface = &Foo{}`.

**Consequence for the design:** "glazed" in the prompt means the go-go-golems
Glazed CLI framework, and the new tool needs its own Go module — `dropcut-studio`
cannot host it. Recorded as §10.1 of the design guide.

---

## 2. Ticket creation

```bash
docmgr ticket create-ticket \
  --ticket MZ1-001 \
  --title "Makera Z1 protocol exploration and Glazed CLI control tool" \
  --topics cnc,protocol,cli,glazed,architecture,research
```

`architecture` was already in the vocabulary; the other five were not, so:

```bash
docmgr vocab add --category topics --slug cnc      --description "CNC machine control, motion, machine tools"
docmgr vocab add --category topics --slug protocol --description "Wire protocols, framing, transport and packet formats"
docmgr vocab add --category topics --slug cli      --description "Command-line interfaces and tooling"
docmgr vocab add --category topics --slug glazed   --description "go-go-golems Glazed CLI/structured-output framework"
docmgr vocab add --category topics --slug research --description "Technology research and evidence gathering"
```

---

## 3. Cloning the reference implementations

All four cloned shallow into `vendor/`, in parallel:

```bash
git clone --depth 1 https://github.com/MakeraInc/CarveraController.git          vendor/makera-carvera-controller
git clone --depth 1 https://github.com/Carvera-Community/Carvera_Controller.git vendor/community-carvera-controller
git clone --depth 1 https://github.com/hagmonk/carvera-cli.git                  vendor/hagmonk-carvera-cli
git clone --depth 1 https://github.com/GridSpace/carve-control.git              vendor/gridspace-carve-control
```

Community controller HEAD: `777482a` ("Merge pull request #707 from
Carvera-Community/develop"). That is the same commit the v2.2.0-RC1 release page
points at, so the clone *is* the RC.

**First good surprise.** The community fork has been refactored since the OEM
code: there is a dedicated `carveracontroller/protocols/` package —
`base.py`, `framing.py`, `makera.py`, `smoothie.py`, `detector.py`, `session.py`,
`registry.py`, `messages.py` — about 700 lines total, with an abstract
`CommunicationProtocol` strategy interface and a registry. This is by far the
cleanest description of the protocol that exists anywhere, and it became the
primary source. The OEM repo was used to confirm original intent (its comments
are in Chinese and spell out the frame layout explicitly).

---

## 4. Reading the protocol layer

Read in full: `protocols/{__init__,base,framing,messages,registry,detector,smoothie,makera,session}.py`,
`WIFIStream.py`, `USBStream.py` (transport sections), the framed halves of
`XMODEM.py` (`recv_packet`, `recv`, `send`, `_finalize_download_integrity`,
`_normalize_advertised_md5`), and targeted regions of `Controller.py`
(`executeCommand`/`executeRealtime`/`executeFileCommand`, the whole shell command
surface, `parseBracketAngle`, `parseBigParentheses`, `open`, `streamIO`,
`pauseStream`) and `main.py` (version/model regexes, upload orchestration,
`setUIForModel`, `load_machine_config_data`).

Facts extracted are in `reference/02-makera-wire-protocol-reference.md`; the
reasoning is in the design guide. Highlights as they landed:

- **`LENGTH` is not the payload length.** `framing.py:315` — `data_length = 1 +
  len(payload) + 2`. The upfront research summarised the frame as
  `HEADER | LENGTH | TYPE | PAYLOAD | CRC | FOOTER` without saying that LENGTH
  covers type + payload + CRC. This is exactly the kind of off-by-three that
  produces frames the machine silently drops.
- **Newline handling is asymmetric between frame types** (`makera.py:64-81`),
  and the upstream comment explains the failure mode: a trailing `\n` breaks
  `strtol`-based numeric parsers because the frame is already length-delimited.
- **Protocol detection is inverted from what you'd guess** (`detector.py:32-59`):
  it sends *unframed* `echo echo\n` and treats **silence** as "new protocol".
- **File transfer is machine-driven** (`XMODEM.py:740-817`). The host sends the
  MD5 and then only responds to requests. Blocks may be requested out of order
  and the host is expected to `seek`.
- **The Z1 has a firmware MD5 bug** (`XMODEM.py:487-505`): `md5sum` returns
  `default_md5_hash_value_32_bytes_`, 32 characters but not hex.

Command surface enumerated mechanically:

```bash
grep -oE 'executeCommand\(["'"'"'][^"'"'"']*' Controller.py | sed 's/.*(["'"'"']//' | sort -u
```

which produced the M-code table in the reference doc.

---

## 5. Checking which upstreams actually support the Z1

This was the decisive check of the whole investigation:

```bash
grep -rn "8668" vendor/hagmonk-carvera-cli/src           # → no output
grep -rn "8668" vendor/gridspace-carve-control/lib       # → no output
grep -rn "8668" vendor/community-carvera-controller/…    # → framing.py:8
grep -rn "8668" vendor/makera-carvera-controller/src     # → Controller.py:77, XMODEM.py:27
```

**Neither `hagmonk/carvera-cli` nor `GridSpace/carve-control` implements the
framed protocol.** Both are legacy-text-only and will not talk to a Z1 without
substantial new code. The prompt suggested `hagmonk/carvera-cli` as "probably the
easiest codebase to understand" — true, and its CLI *shape* and its echo-sentinel
completion trick are genuinely worth stealing, but its wire layer is not usable
for our target machine. This changed the recommendation from "port carvera-cli"
to "implement the framed protocol from the Community Controller's specification".

Also confirmed the Z1 support claim at the source rather than trusting the
summary — `sources/web/01-community-controller-releases.raw.md`:

```
[SergeBakharev] released this 04 Aug 22:53   v2.2.0-RC1   777482a
- Enhancement: Initial Z1 support
- Enhancement: Live camera view for the Makera Z1 …
- Fixed: On the Makera Z1 firmware every download returns same placeholder MD5 …
```

Released seven days before this ticket. Noted as a maturity risk.

---

## 6. Corrections to the upfront research

Recorded explicitly, because the guide contradicts the brief in two places:

| Upfront statement | What the source says |
|---|---|
| "LENGTH … 2 bytes" (implying payload length) | `LENGTH = 1 + len(payload) + 2` — includes the type byte and the CRC. `framing.py:315` |
| Packet types listed as A1/A2/B0 out, 81/82/83/84/85/90 in | There are also **B1 FILE_MD5, B2 FILE_VIEW, B3 FILE_DATA, B4 FILE_END, B5 FILE_CAN, B6 FILE_RETRY**, and they are bidirectional. `framing.py:11-25`. Without these the file transfer cannot be implemented at all |
| "hagmonk/carvera-cli … probably the easiest codebase to understand" | True, but it is legacy-protocol-only (§5), so it cannot be the implementation basis for a Z1 tool |
| "`hagmonk/carvera-cli` — small **MIT-licensed** Python CLI" | The cloned repository carries **no licence at all** — no `LICENSE` file, no `license` field in `pyproject.toml`, no statement in the README. Ideas are free to use; code is not, until the author clarifies (§11.1) |
| The two Makera controllers described together, licence versions undifferentiated | The community fork is **GPL-2.0**; the OEM repo is **GPL-3.0** (`COPYING` = GPLv3, README says so). Mutually incompatible — a detail that directly constrains what may be ported into a GPLv2 tree (§11.1) |

Everything else in the brief checked out: ports, header/footer magic, CRC
polynomial and init, the CRC's coverage range, and the upload-then-`play`
workflow.

---

## 7. Experiments

The point of these was to make the specification *executable* before any hardware
exists, so a Go implementation can be validated offline.

### 7.1 `scripts/01-frame-vectors.py` — frame golden vectors

Re-implements the encoder from first principles (bitwise CRC, no lookup table),
then imports the vendored `build_frame`/`crc16_ccitt` and asserts they agree on
ten vectors, plus structural invariants (`LENGTH == N+3`,
`total == 2+2+LENGTH+2`, header/footer magic).

```
$ python3 scripts/01-frame-vectors.py
OK   crc16("123456789") == 0x31C3 (poly 0x1021, init 0x0000)
OK   realtime '?'  … 86 68 00 04 a1 3f 35 33 55 aa
…
all vectors agree
```

The `0x31C3` check value is worth calling out: it confirms **init 0x0000**, not
the far more common CRC-16/CCITT-FALSE (init `0xFFFF`, check `0x29B1`). Someone
reaching for a stock CRC library will pick the wrong variant.

### 7.2 `scripts/02-goframe/` — Go codec

Dependency-free Go port: encoder, `Decoder` RX state machine, byte-at-a-time
feed. Checked against the vectors from 7.1, then attacked.

Two failures during development, both worth recording:

1. `constant 34408 overflows byte` — `byte(frameHeader)` where `frameHeader =
   0x8668`. Fixed with `byte(frameHeader & 0xFF)`. Trivial, but it is the first
   thing anyone porting this will hit.
2. **The "resync after leading garbage" test failed**, and the failure was
   correct. My junk prefix contained the bytes `86 68 01 55`, which the decoder
   read as a real header with a 341-byte length, so it swallowed the genuine
   frame behind it.

   This is not a bug in my port — the same behaviour exists in the upstream
   Python decoder, because the protocol has no byte-stuffing and therefore no way
   to distinguish a real header from the same two bytes appearing inside a
   payload. I rewrote the test into two: a benign-garbage case that must pass,
   and an explicit **known-limitation** case that asserts the frame *is* lost and
   that the decoder recovers on later frames. Documented in design guide §5.6 with
   a recommendation to log every footer/CRC drop.

Final state:

```
$ cd scripts/02-goframe && GOWORK=off go run .
ok   crc16("123456789") == 0x31C3
ok   encode … (10 vectors, byte-exact)
ok   roundtrip … (10 vectors)
ok   resync after leading garbage
ok   false header swallows the frame behind it (known limitation)
ok   decoder recovers on later frames after a false header
ok   decode survives every 2-way split (20 positions)
ok   two frames in one read
ok   bad CRC dropped, next frame still parsed
ok   oversized length rejected without wedging
PASS
```

`GOWORK=off` is required: the workspace `go.work` pins `go 1.26.1` and the
ambient toolchain in this environment is older, so the module must be built
standalone.

### 7.3 `scripts/03-discover.py` — discovery parser

Self-test mode reproduces the upstream parser and its rejection cases (too few
fields, non-numeric port, non-UTF-8), and demonstrates that trailing extra fields
are tolerated — which is what makes the record format forward-compatible.
`--listen N` mode is ready to point at real hardware.

```
$ python3 scripts/03-discover.py --self-test
… parser ok
```

### 7.4 `scripts/04-gostatus/` — report grammar

Go decoder for both `<…>` and `{…}` reports. The design decision it validates is
"decode generically into `map[string][]float64` first, interpret second" — proven
by a test that feeds an unknown future key `ZZ:9,8,7` and shows it survives.

Cases: the two documented sample lines from the upstream comments, a minimal
3-axis line (all optional keys absent), a trailing junk byte after `>`, the
first-colon split needed for `RSSI:-57`, and malformed input returning an error
rather than panicking.

```
$ cd scripts/04-gostatus && GOWORK=off go run .
… PASS  (15 checks)
```

---

## 8. Source captures

```bash
defuddle parse <url> --md -o sources/web/NN-name.raw.md
```

for the Community Controller releases page, and the three repository READMEs.
docmgr frontmatter was prepended to each capture with a short Python script so
`docmgr doctor` does not trip over raw upstream Markdown.

The releases capture is the one that matters: it is the primary evidence for
"Initial Z1 support", for the Z1 camera, for the Z1 MD5 placeholder fix, and for
the protocol-autodetection feature.

---

## 9. Glazed API verification

The design guide contains Go sketches, so the APIs were checked against the local
checkout rather than from memory:

```bash
grep -n "BareCommand interface\|WriterCommand interface\|GlazeCommand interface" glazed/pkg/cmds/cmds.go
#  352 / 357 / 362
grep -n "Type" glazed/pkg/cmds/fields/field-type.go
#  the type is fields.Type (not FieldType); TypeString, TypeInteger, TypeBool, TypeChoice, …
grep -n "^func BuildCobraCommand\|^func AddCommandsToRootCommand" glazed/pkg/cli/cobra.go
#  345 BuildCobraCommand · 354 BuildCobraCommandFromCommand · 385 AddCommandsToRootCommand
nl -ba glazed/cmd/examples/new-api-build-first-command/main.go
```

The example confirms the current idiom: `cmds.NewCommandDescription` +
`cmds.WithFlags(fields.New(...))`, `vals.DecodeSectionInto(schema.DefaultSlug,
settings)`, `types.NewRow(types.MRP(...))`, `gp.AddRow(ctx, row)`, and
registration via `cli.BuildCobraCommand` with a `CobraParserConfig`.

---

## 10. Decisions taken, and why

Full records are in design guide §12. The short version:

| # | Decision | Driver |
|---|---|---|
| 001 | Implement the protocol in Go, don't subprocess the Python controller | It is a Kivy GUI with no headless entry point; the codec is <150 lines and already works; shipping a Python + Kivy tree to run one CLI is absurd |
| 002 | Makera framed protocol first, Smoothie as a cheap fallback | Smoothie is ~40 lines and makes autodetection meaningful. Legacy *file transfer* explicitly deferred |
| 003 | One reader goroutine + explicit mode, not upstream's pause-and-spin | Deterministic; removes the race window upstream mitigates with a 1 s busy-wait |
| 004 | `-e` forms and the echo sentinel for command completion | Both are existing firmware behaviour; we invent nothing |
| 005 | No QuickLZ in phase 1 | No maintained Go QuickLZ; `.nc` files are small; compression drags in deferred-MD5 and `.lz` bookkeeping |
| 006 | Wi-Fi first, USB in phase 4 | USB resets the machine on open and needs a serial dep, for no phase-1 benefit |
| 007 | Validate advertised MD5 as 32 **hex** chars | Direct consequence of the Z1 placeholder bug |
| 008 | **GPL-2.0**, port from the community controller, attribute upstream, publish the spec | Decided by the ticket owner on 2026-08-11, reversing an MIT decision taken earlier the same day (see §11.1) |

---

## 11. What warrants a second pair of eyes

### 11.1 Licensing — resolved 2026-08-11 (after one reversal)

Raised as an open question: the implementations with the framed protocol are
GPL-licensed, so whether to implement from a specification or port directly
needed a human decision.

The ticket owner first answered **MIT**, then reversed to **GPL-2.0** within the
same session. Both are recorded here because the reversal changed the
implementation plan, not just a header.

**Final: GPL-2.0**, with the spec referenced and the projects linked. Written up
as **ADR-008** and design guide §3.5–3.6.

#### What checking the actual licence files turned up

Before rewriting, I verified every licence in the clones rather than trusting the
brief. Two things were wrong:

- **`MakeraInc/CarveraController` is GPL-3.0, not GPL-2.0.** `COPYING` is the
  GPLv3 text and the README says "released under the GNU GPL v3"
  (`sources/web/02-…:27-29`). The community fork is GPL-2.0 (`LICENSE` = GPLv2,
  `pyproject.toml: license = "GPL-2.0"`). **These two are mutually incompatible**
  — GPLv3 code cannot go into a GPLv2-only work. My earlier table had lumped both
  under "GPL", which would have led someone to port OEM code into a GPLv2 tree.
- **`hagmonk/carvera-cli` carries no licence at all.** No `LICENSE` file, no
  `license` field in `pyproject.toml`, no statement in the README. The brief
  called it "MIT-licensed"; the repository as cloned does not say so. Its ideas
  (the echo sentinel) are free to use; its code is not, until the author
  clarifies.

I also checked for an "or (at your option) any later version" grant in the
community controller — `LICENSE`, `pyproject.toml`, and the `carveracontroller/*.py`
headers. There is none, so it is effectively **GPLv2-only**.

#### What the GPL-2.0 decision changes

The MIT plan's central constraint — "implement from the spec, copy nothing" —
disappears. We may port from the community controller directly. That matters most
where the risk is:

- **Port `filexfer.go`.** The file-transfer state machines are machine-driven,
  with out-of-order block requests, retry/cancel paths and a three-way MD5
  policy. Reusing logic the community debugged on real hardware beats
  re-deriving it from a document.
- **Keep `frame.go` and `status.go` from `scripts/02` and `scripts/04`** — now a
  preference on merit (they are written and tested) rather than a legal
  requirement.
- Ported files must carry a provenance header: upstream file, commit `777482a`,
  GPL-2.0.
- `vendor/` still never becomes a dependency; porting means copying reviewed code
  into our tree with attribution.

#### Two consequences that outlive this ticket

1. **Copyleft reaches the future device control UI.** Anything linking
   `pkg/makera` is a derivative work and must be GPL. If the UI needs to be
   permissive, keep the boundary at the process (`z1ctl --format json`), or split
   out a spec-derived permissive core — the MIT plan is retained in design guide
   §3.5.3 as exactly that fallback. Worth deciding before the UI ticket starts.
2. **GPLv2-only vs GPLv2-or-later is still open**, and I recommend
   **or-later**: identical behaviour today, but it permits combining with GPLv3
   code later (including the OEM controller) by distributing under GPLv3. It goes
   into every file header, so it should be settled in Phase 0.

**Publish the specification** either way, as `docs/protocol.md`. Under MIT that
was about provenance; under GPL it is simply the most reusable artefact this
ticket produced — nobody else has written this protocol down in one place.

### 11.2 Still open

1. **The false-header desync** (§7.2). I concluded it is inherent to a protocol
   without byte-stuffing and that logging is the right mitigation. If someone
   sees a way to make resync robust (e.g. requiring a plausible type byte after
   the length before committing to `READ_DATA`), that is a cheap improvement
   worth making.
3. **The safety rules** in design guide §17 — particularly the list of commands
   that must never run without a deliberate flag (`$H`, `M3`, `M6`,
   `config-default`, firmware writes). Someone who actually operates the machine
   should review that list before phase 3.
4. **The `ls -e -s` column format.** Inferred from `hagmonk/carvera-cli`, which
   targets legacy firmware. Unverified on a Z1.

---

## 11a. Hardware session — 2026-08-11, read-only

The owner powered on the mill mid-session. Everything below was read-only; the
machine did not move and was still unhomed (`MPos: -1,-1,-1`) at the end.

### Safety approach

I wrote `scripts/05-probe.py` with the read-only constraint **enforced in code**
rather than by discipline: `assert_read_only()` checks every outbound command
against an allowlist and a motion-marker denylist and raises before a byte hits
the socket. `$H`, `$J`, `G0/G1/G2/G3`, `M3`–`M6`, `play`, `suspend`, `resume`,
`abort`, `reset`, `upload`, `download`, `rm`, `mv`, `mkdir`, `config-set`,
`config-default`, `baud` and `buffer` are all refused. The only realtime byte
permitted is `?`. `switch` is deliberately excluded even though `switch <name>`
is a query, because `switch <name> <value>` actuates and one typo is the
difference.

The script implements framing from **our specification**, not by importing
upstream — so a successful run validates the spec end to end rather than
validating someone else's code.

### Sequence

```bash
python3 scripts/03-discover.py --listen 25          # passive
python3 scripts/05-probe.py --host 192.168.0.55     # identity, status, diagnose
python3 scripts/05-probe.py --host 192.168.0.55 --hex --cmd "ls -e -s /sd/gcodes"
python3 scripts/05-probe.py --host 192.168.0.55 \
    --cmd "md5sum …" --cmd "get wcs" --cmd "get state" --cmd "get pos" \
    --cmd "progress" --cmd "mem"
```

Discovery found `Makera_Z1_012146` at `192.168.0.55:2222` on the first try.

### Result: the codec is right, the payload spec was not

**Zero decoder drops across all five sessions.** Frame layout, `LENGTH = N+3`,
CRC init `0x0000`, the `0xA2` no-trailing-newline rule, the `0xA1` realtime
encoding, silence-means-makera detection, and the echo sentinel all held up
against real firmware. That is the whole wire layer confirmed.

The *payloads* diverged in about a dozen places. Full record in
`reference/03-live-z1-observations-firmware-1-0-15.md`. The ones that mattered:

- **`ftype = nc`** — no compressed uploads on this firmware. ADR-005 stops being
  a judgement call.
- **`MPos`/`WPos` carry five axes**, not three-or-four. Confirmed twice, via the
  status report and via `get pos`.
- **No `G:` key in status** on stock firmware ⇒ the active WCS must come from
  `get wcs`, exactly the fallback upstream implements for non-community firmware.
- **Two undocumented status keys**, `E:` (5 values) and `OTA:` (2 values). `OTA`
  is a second multi-character key alongside `RSSI`, which retroactively justifies
  the split-on-first-colon rule.
- **`L:0, 0, 0, 0.0,100.0`** — values carry leading spaces. Our Go decoder
  already trims per token; a stricter parser would have failed on a live machine.
  A source-only reading would never have caught this.
- **Diagnose `E:` has 8 values, not the 6 upstream maps.** This is the one I care
  about: design guide §17.2 proposes gating job start on the cover bit inside
  `E:`, and if the mapping is shifted rather than merely truncated, a naive port
  reports "cover closed" when it is open. Flagged as blocking in both the design
  guide and `reference/03`; the fix is to open the cover and diff a capture.
- **`md5sum` returns a real digest**, not the `default_md5_hash_value_32_bytes_`
  placeholder — concatenated with the path, no separator. So the placeholder bug
  is either fixed in 1.0.15 or lives only in the framed download exchange.
  Upload verification is trustworthy; ADR-007's hex validation stays anyway
  because it costs nothing.
- **`help` is incomplete.** `model`, `ftype`, `time` and `echo` all work and none
  are listed. It did reveal a useful query family that was invisible from the
  controller source: `get pos|wcs|state|status|fk|ik`, `progress`, `mem`, `net`,
  `remount`, `cd`/`pwd`.
- **`mem` reports ~7.6 KB free RAM.** That reframes the 8 KB transfer block and
  the chunked listings as necessities, and argues for conservative command rates.

The generic "decode to a map first, interpret second" design (design guide §8.1)
is the thing I would most defend after this session: `E:` and `OTA:` arrived as
data rather than as parse failures, on the first contact with hardware.

### What this session could not touch

The framed file transfer — the highest-risk part of the implementation — is
completely unexercised, because a read-only probe cannot upload or download by
construction. Phase 3 remains where the real unknowns are.

## 12. Open questions — status after the hardware session

Answered (see §11a and `reference/03`):

1. ~~What does `help` list?~~ → `reference/03` §8, and it is incomplete.
2. ~~Exact `ls -e -s` columns and directory marking?~~ → `name size timestamp`;
   directories end with `/` and have size 0; `\r\n`-terminated.
4. ~~Does the Z1 accept `.lz`?~~ → **No.** `ftype = nc`.
5. ~~Does the MD5 placeholder affect uploads?~~ → **No** on 1.0.15 —
   `md5sum` returns a genuine digest.
7. ~~Machine geometry?~~ → partially: five axes (X, Y, Z, A, B) and the G54
   offset are known. Travel limits still need `config-get-all`.

Still open:

3. Does the Z1 emit `M485` protocol announcements? Never observed. Autodetection
   worked, so this is academic.
6. `config_z1.json` ships in the community controller but
   `load_machine_config_data` only maps `C1` and `CA1` (`main.py:5296-5302`).
   Settle by running `config-get-all -e` and diffing the key set.

New, from the hardware session:

8. **`E:` field order in the diagnose report — 8 values, not 6.** **Blocking**
   for the `z1ctl doctor` cover interlock (design guide §17.2). Open the cover,
   re-capture `diagnose`, diff.
9. `E:` in the *status* report (5 values) — meaning unknown.
10. `OTA:0,0` semantics — presumably OTA update state; harmless to pass through.
11. Does `play` take `-O` (what the community controller sends) or `-v` (what
    firmware `help` documents)? Only test on a scratch air-cut file with the
    spindle off and the operator present.
12. Does the framed **download** path return the placeholder MD5? Needs phase 3.

---

## 13. Next actions

1. **Phase 0 + Phase 1** (design guide §14) — scaffold `makera-z1-cli`, settle
   the GPLv2-only vs -or-later sub-decision, port `scripts/02-goframe` and
   `scripts/04-gostatus` into `pkg/makera` with the golden vectors as tests. The
   hardware session confirmed both are correct, so this is now a mechanical port
   of validated code. Neither step needs the machine.
2. **Fold the `reference/03` payload corrections into `status.go` as you port
   it** — five-axis `MPos`/`WPos`, the missing `G:` key, the `get wcs` fallback,
   space-padded values, and `E:`/`OTA:` passthrough. Use the verbatim captures in
   `reference/03` as test fixtures; they are real machine output.
3. **Confirm the diagnose `E:` field order** (open the cover, diff a capture)
   before anything reads the cover bit. This is the one open item that gates a
   safety feature.
4. Phase 2 is largely proven already — `scripts/05-probe.py` is a working
   prototype of `discover`/`status`/`exec`. Porting it to Glazed commands is
   mostly plumbing.
5. Phase 3 (file transfer) is where the remaining risk lives, and under ADR-008
   it can be **ported** from `CC/XMODEM.py@777482a` rather than re-derived.
6. Re-diff `vendor/community-carvera-controller/carveracontroller/protocols/`
   against `777482a` before starting each phase — Z1 support is a release
   candidate and may move.
