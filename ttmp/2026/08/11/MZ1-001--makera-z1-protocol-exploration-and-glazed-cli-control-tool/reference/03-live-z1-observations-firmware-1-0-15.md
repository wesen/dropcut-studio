---
Title: Live Z1 Observations firmware 1.0.15
Ticket: MZ1-001
Status: active
Topics:
    - protocol
    - cnc
    - reference
    - research
DocType: reference
Intent: long-term
Owners: []
RelatedFiles:
    - Path: repo://dropcut-studio/ttmp/2026/08/11/MZ1-001--makera-z1-protocol-exploration-and-glazed-cli-control-tool/scripts/03-discover.py
      Note: Discovery listener that found the machine and revealed the fifth record field
    - Path: repo://dropcut-studio/ttmp/2026/08/11/MZ1-001--makera-z1-protocol-exploration-and-glazed-cli-control-tool/scripts/05-probe.py
      Note: Live read-only probe with an enforced command allowlist; produced every capture in this document
ExternalSources: []
Summary: 'Ground truth captured from a real Makera Z1 (Makera_Z1_012146, firmware 1.0.15.0.1.11) on 2026-08-11: verbatim protocol captures plus every place the live machine contradicts or extends the specification derived from upstream source.'
LastUpdated: 2026-08-11T18:00:00-04:00
WhatFor: The authoritative record of how a real Z1 actually behaves, as opposed to how upstream source suggested it would.
WhenToUse: Whenever implementing a parser for any Z1 response. This document outranks reference/02 wherever they disagree.
---


# Live Z1 Observations — firmware 1.0.15.0.1.11

**Machine:** `Makera_Z1_012146` at `192.168.0.55:2222`
**Captured:** 2026-08-11, read-only session via `scripts/05-probe.py`
**Machine state:** powered on, **not homed** (`MPos: -1,-1,-1`), tool 2 loaded, idle

> **Precedence.** `reference/02-makera-wire-protocol-reference.md` was derived
> entirely from upstream source. This document was captured from hardware.
> **Where they disagree, this one is right.**

---

## 0. The headline: the codec is correct

Across five probe sessions — identity queries, realtime status, diagnose, `help`,
two directory listings, `md5sum`, `get wcs`, `get state`, `get pos`, `progress`,
`mem` — the frame decoder reported:

```
decoder drops (bad crc/footer/length): 0
```

Every frame we built was accepted by the machine, and every frame the machine
sent was parsed. That validates, against real firmware:

- the frame layout, including `LENGTH = payload + 3` (§5.1 of the design guide);
- CRC-16/CCITT with **init `0x0000`** over length+type+payload;
- the `0xA2` "strip trailing newline" rule — every command was sent without a
  newline and every one was understood;
- the `0xA1` realtime encoding for `?`;
- protocol autodetection: three unframed `echo echo\n` probes drew **silence**,
  correctly yielding `makera`;
- the echo-sentinel completion technique (§10.4).

Nothing in the codec needs to change. Everything that follows is about the
*payloads*.

---

## 1. Discovery — there is a fifth field

```
from 192.168.0.55: b'Makera_Z1_012146,192.168.0.55,2222,0,Idle'
```

| Field | Value | Notes |
|---|---|---|
| 0 | `Makera_Z1_012146` | name, `Makera_Z1_` + 6 digits |
| 1 | `192.168.0.55` | ip |
| 2 | `2222` | tcp port |
| 3 | `0` | busy flag |
| **4** | **`Idle`** | **machine state — not in the upstream parser** |

Upstream reads fields 0–3 and discards the rest (`CC/WIFIStream.py:61-65`), so
this was invisible from source.

**Why it matters:** the discovery broadcast tells you the machine's run state
*without connecting*. Since the machine only accepts one TCP client, that is
genuinely useful — `z1ctl discover` can show `Idle` / `Run` for every machine on
the network without ever taking the connection slot away from whoever is using
it.

**Action:** emit field 4 as a `state` column in `z1ctl discover`, and keep
parsing tolerant of further fields.

Broadcast rate is roughly one datagram per 1.5 s; a 3-second sweep (upstream's
default) catches two. Keep 3 s.

---

## 2. Identity — all three lines differ from the spec

```
version = 1.0.15.0.1.11
model = Z1, 3, 1, 0, Idle
ftype = nc
time = 120
```

### 2.1 `version` has six components, not three

Upstream's regex is `version = \d+\.\d+\.\d+[a-zA-Z0-9\-_]*`
(`CC/main.py:4156`). Against `1.0.15.0.1.11` it matches only the prefix
**`1.0.15`** and silently drops `.0.1.11`. It does not crash, but any version
comparison is being done on a truncated string.

- No `c` in the version ⇒ **stock Makera firmware**, not Community firmware.
  Consistent with everything else below (`R:` and `H:` absent from status).
- **Action:** parse the version as a dotted list of arbitrary length. Do not
  assume three components.

### 2.2 `model` has five fields, not four

Upstream's regex is `model = (\w+), (\d+), (\d+), (\d+)` — four capture groups.
The real line has **five** fields, the last being the machine state again:

```
model = Z1, 3, 1, 0, Idle
        │   │  │  │  └── machine state (undocumented upstream)
        │   │  │  └───── extra
        │   │  └──────── FuncSetting  = 1
        │   └─────────── MachineModel = 3
        └─────────────── model name
```

So for this machine: `MachineModel = 3`, `FuncSetting = 1`.

### 2.3 `ftype = nc` — **this firmware does not accept compressed uploads**

Upstream enables QuickLZ compression when the `ftype` reply contains `lz`
(`CC/main.py:5598`). This machine answers **`nc`**.

**ADR-005 (skip QuickLZ in phase 1) is now not a trade-off but a fact:**
compression is unavailable on this firmware. Uploads go as raw `.nc`.

The `/sd/gcodes/.lz/` directory still exists (§5), presumably created by an
older firmware or by the controller, but the machine will not ask for `.lz`
payloads while `ftype` says `nc`.

### 2.4 `time = 120` — the clock is unset at boot

120 seconds past the epoch. The machine has no RTC battery, so after every power
cycle its clock starts near zero until a controller sends `time <epoch>`.

**Consequences:**

- `ls` timestamps on files written before a time sync are meaningless.
- Upstream syncs automatically when the machine's time differs from the host's by
  more than 10 s (`CC/main.py:4151-4154`).
- `z1ctl` should **report** clock skew but must not silently write to the machine.
  Put the sync behind `z1ctl time sync` (a write, so out of any read-only path).

---

## 3. Status report — five axes, two new keys, no `G:`

Verbatim:

```
<Idle|MPos:-1.0000,-1.0000,-1.0000,0.0000,0.0000|WPos:189.5200,192.7300,77.1609,-90.0000,0.0000|F:0.0,2000.0,100.0|S:0.0,10000.0,100.0,0,22.9,23.0,0,0,0,0|T:2,0.054,-1|L:0, 0, 0, 0.0,100.0|C:3,1,0,1|E:0,0,0,57,7610|OTA:0,0>
```

| Observation | Spec said | Reality |
|---|---|---|
| `MPos` / `WPos` component count | 3, optionally 4 (`x,y,z[,a]`) | **5** — `x,y,z,a,b`. Confirmed independently by `get pos` (§7) |
| `G:` active coordinate system | present | **absent.** Stock firmware does not report it — you must use `get wcs` (§6) |
| `R:` rotation | community firmware only | absent, as predicted |
| `H:` halt reason | community firmware only | absent, as predicted |
| `S:` | 3+ values, length-dependent | **10 values** here |
| `L:` | 5 values | 5 values, **but with spaces after commas**: `0, 0, 0, 0.0,100.0` |
| `E:` | diagnose-only (endstops, 6 values) | **also appears in status, with 5 values** — meaning unknown |
| `OTA:` | not in upstream at all | **new key**, 2 values, presumably over-the-air update state |

Two consequences that change the parser design:

1. **Multi-character keys are real.** `OTA` joins `RSSI` as a key longer than one
   character. Any parser that assumes single-letter keys is wrong. Split on the
   **first** colon (which we already specified).
2. **Values may carry leading whitespace.** `L:0, 0, 0, 0.0,100.0`. Our Go
   decoder already does `strings.TrimSpace` per token
   (`scripts/04-gostatus/main.go`), so it handles this — but a stricter
   implementation, or a naive `strconv.ParseFloat` on the raw token, would fail
   on a live machine. This is exactly the case a source-only reading would have
   missed.

The generic "decode to `map[string][]float64` first, interpret second" design
(design guide §8.1) is fully vindicated: `E:` and `OTA:` come through as data
rather than as parse errors.

`MPos: -1,-1,-1` is the **unhomed** sentinel — the machine had not been homed.
Worth surfacing in `z1ctl status` as an explicit `homed: false` rather than
printing a position that looks real.

---

## 4. Diagnose report — every vector is longer than documented

Verbatim:

```
{S:0,10000,0,0,22,23|L:0,0|V:1,27|F:0,0|G:1,0,0,0,0|T:0|C:1|E:0,0,0,0,0,1,1,0|P:0,0|I:0|RSSI:-47}
```

| Key | Spec said | Reality |
|---|---|---|
| `S` | 2 (switch, slaved) | **6** — `0,10000,0,0,22,23`; the last two look like temperatures matching the status `S` field |
| `G` | 1 (light switch) | **5** |
| `E` | 6 (xMin,xMax,yMin,yMax,zMax,cover) | **8** |
| `V` | 2 | 2 — `1,27` |
| `C` | 1 | 1 |
| `I` | 1 (e-stop) | 1 — `0`, clear |
| `RSSI` | dBm | `-47` |

**The `E` vector is the safety-critical one and it is two elements longer than
upstream reads.** Upstream maps indices 0–5 to xMin/xMax/yMin/yMax/zMax/cover
(`CC/Controller.py:1495-1501`). With 8 values on this firmware, that mapping may
be *shifted*, not merely truncated — meaning a naive port could read the wrong
bit as "cover closed".

**Do not implement a cover-open interlock against the `E` vector until the field
order is confirmed empirically** (open the cover, capture `diagnose`, diff). That
is now the first item on the hardware to-do list, because design guide §17.2
proposes gating job start on exactly this.

---

## 5. `ls -e -s` — exact format

Command sent as a `0xA2` frame with **no** trailing newline:

```
→ CTRL_MULTI 'ls -e -s /sd/gcodes'
  86 68 00 16 a2 6c 73 20 2d 65 20 2d 73 20 2f 73 64 2f 67 63 6f 64 65 73 8e f0 55 aa
```

Response, verbatim bytes:

```
← LOAD_INFO   b'.md5/ 0 20260516120042\r\nExamples/ 0 20260516120042\r\n.lz/ 0 20260520133900\r\n
               goto-pack-pos-z1.nc  54 20260522094322\r\nMakeraBadge.nc  328417 20260731185808\r\n
               pattern-tests/ 0 20260801052734\r\n ... \r\n'
← LOAD_INFO   b'cat_sample_abs_vcarve-6_20260802141842.nc  1922673 20260802141910\r\n ... \r\n'
← LOAD_FINISH b'Load directory finished.\r\n'
← NORMAL_INFO b'echo: \x04\r\n'
```

Format rules:

```
<name> <size> <timestamp>\r\n
```

- **Directories end with `/` and have size `0`.** That is the only marker. There
  is no type column. `.md5/`, `Examples/`, `.lz/`, `pattern-tests/`.
- **Files are separated from their size by TWO spaces**; directories by one.
  Verified in the raw bytes, not a display artefact. Do not rely on it — split on
  runs of whitespace instead.
- **Timestamp is `YYYYMMDDHHMMSS` local time**, not a Unix epoch.
  `20260802182430` → 2026-08-02 18:24:30. (And see §2.4: it is only meaningful if
  the clock was synced.)
- Lines are **`\r\n`**-terminated.
- **Many records arrive per `LOAD_INFO` frame**, and the split point between
  frames is not guaranteed to be record-aligned. Buffer across frames and split
  on `\r\n`; never treat one frame as one record.
- `LOAD_FINISH` (`0x84`) **carries a text payload** — `Load directory
  finished.\r\n` — it is not an empty terminator as the type name suggests.

**Recommended parse:** split each line on whitespace, take the **last two**
tokens as size and timestamp, and treat everything before as the name. This
survives the one-vs-two-space inconsistency and names containing escaped spaces
(`\x01`, which is not ASCII whitespace).

The `.md5/` directory is a sibling of `.lz/` — the machine appears to cache
digests on the SD card.

---

## 6. `md5sum` — a real digest, and no separator

```
→ md5sum /sd/gcodes/goto-pack-pos-z1.nc -e
← b66caa6121c39f971ff5d97b5158b57e/sd/gcodes/goto-pack-pos-z1.nc
```

Two findings:

1. **The digest and the path are concatenated with no separator.** Parse as
   `line[:32]` (validated as hex) and `line[32:]` as the path. A `split()` would
   return one token.
2. **This is a genuine MD5, not the `default_md5_hash_value_32_bytes_`
   placeholder** that upstream documents for stock Z1 firmware
   (`CC/XMODEM.py:487-505`).

### 6.1 Refinement to ADR-007

The upstream release note says *"every **download** returns same placeholder MD5
hash"*. Combined with what we just measured, the most likely reading is that the
placeholder appears in the **`FILE_MD5` (`0xB1`) frame of the framed transfer
protocol**, not in the `md5sum` shell command — or that it was fixed by firmware
1.0.15.0.1.11.

Practical effect on the design:

- **Upload verification is trustworthy on this firmware.** `z1ctl job run` can
  upload, then `md5sum` the remote file and compare against the local digest, and
  that check is real (design guide §13.3).
- **Download verification remains unproven.** Testing it requires actually
  running a framed download, which the read-only probe cannot do.
- **Keep ADR-007's rule anyway** — validate the advertised digest as 32
  *lowercase hex* characters and skip the check with a warning otherwise. It
  costs nothing and it is the only thing standing between us and a silently
  corrupt download on firmware that does exhibit the bug.

---

## 7. Additional read-only queries worth having

### `get wcs`

```
[current WCS: G54]
[G54:-190.5200,-193.7300,-78.2153,90.0000,0.0000]
[G55:0.0000,0.0000,0.0000,0.0000,0.0000]
... G56 … G59.3 …
[G28:0.0000,0.0000,0.0000]
[G30:0.0000,0.0000,0.0000]
[G92:0.0000,0.0000,0.0000,0.0000,0.0000]
[Tool Offset:0.0000,0.0000,0.0544]
[PRB:0.0000,0.0000,0.0000:0]
```

**This is the required substitute for the missing `G:` status key.** Since stock
firmware does not report the active coordinate system in `<...>`, `z1ctl` must
issue `get wcs` to learn it — exactly the fallback upstream implements for
non-community firmware (`CC/Controller.py:2254-2261`).

- Work offsets carry **5** components (X, Y, Z, A, B). Upstream expects a 6th
  (rotation) only on community firmware — correctly absent here.
- `G28`/`G30`/`Tool Offset` carry 3.
- `PRB` carries 3 plus a trailing `:0` success flag.

### `get state` — the full modal state in one line

```
[G0 G54 G17 G21 G90 G94 M0 M5 M9 T0 F2000.0000 S1.0000]
```

Motion mode, WCS, plane, units (G21 = mm), distance mode (G90 = absolute), feed
mode, program state, spindle off, coolant off, tool, feed and speed. This is
worth exposing as `z1ctl status --modal`; it is also precisely what a
resume-at-line feature needs.

Note `T0` here while the status report says `T:2` — the modal tool word and the
physically loaded tool are tracked separately. Do not conflate them.

### `get pos` — six position flavours, five axes

```
last C:       X:189.5200 Y:192.7300 Z:77.1609
realtime WCS: X:189.5200 Y:192.7300 Z:77.1609
MCS:          X:-1.0000 Y:-1.0000 Z:-1.0000 A:0.0000 B:0.0000
APOS:         X:-1.0000 Y:-1.0000 Z:-1.0000 A:0.0000 B:0.0000
MP:           X:-1.0000 Y:-1.0000 Z:-1.0000 A:0.0000 B:0.0000
CMP:          X:-1.0000 Y:-1.0000 Z:-1.0000
```

Independently confirms **five axes (X, Y, Z, A, B)**, matching the 5-component
`MPos`/`WPos` vectors in §3.

### `progress`

```
Not currently playing
```

A cheap, unambiguous job-state query that does not require parsing the optional
`P:` status key. Use it in `z1ctl job progress`.

### `mem` — the machine is very small

```
Unused Heap: 1456 bytes
Used Heap Size: 24424
Total Free RAM: 7596 bytes
```

**Roughly 7.6 KB of free RAM.** This reframes several design choices as
necessities rather than preferences:

- the 8192-byte transfer block is near the machine's whole memory budget;
- bulk listings are chunked because they must be;
- polling and command rates should stay conservative — do not pipeline dozens of
  commands at a Cortex-M with 7 KB free.

---

## 8. `help` is incomplete — do not treat it as the API

Firmware `help` output:

```
version · mem [-v] · ls [-s] [-e] [folder] · cd folder · pwd
cat file [limit] [-e] [-d 10] · rm file [-e] · mv file newfile [-e] · remount
play file [-v] · progress · abort · reset · dfu · break
config-get [<source>] <setting> · config-set [<source>] <setting> <value>
get [pos|wcs|state|status|fk|ik] · get temp [bed|hotend] · set_temp bed|hotend 185
switch name [value] · net · ap [channel] · wlan [ssid] [password] [-d] [-e]
diagnose · load [file] · save [file] · upload filename
calc_thermistor [-s0] T1,R1,T2,R2,T3,R3 · thermistors · md5sum file
```

**`model`, `ftype` and `time` are not listed — yet all three work** (§2). So do
`echo` (our sentinel depends on it) and, per upstream, `download`, `suspend`,
`resume`, `mkdir`, `config-get-all` and `buffer`.

`help` lists the Smoothieware base command set. The Makera extensions are
undocumented by the firmware itself. **Treat `help` as a lower bound.**

### Commands discovered here that were not in our command table

| Command | Notes |
|---|---|
| `mem [-v]` | heap stats (§7) |
| `cd` / `pwd` | there is a working directory — all our paths should stay absolute |
| `remount` | remount the SD card |
| `progress` | job progress (§7) |
| `get [pos\|wcs\|state\|status\|fk\|ik]` | the query family (§7); `fk`/`ik` are forward/inverse kinematics |
| `get temp` / `set_temp` | inherited Smoothie 3D-printer commands; irrelevant on a mill |
| `switch name [value]` | **generic actuator control** — queries with one arg, actuates with two. Dangerous; keep it off any read-only allowlist |
| `net` / `ap [channel]` | network info; access-point mode |
| `load` / `save [file]` | configuration override files |
| `calc_thermistor` / `thermistors` | Smoothie leftovers |
| `dfu` / `break` | bootloader / debugger. **Never issue these** |

Also: `play file [-v]`, not `-O`. The community controller sends `-O` for O-code
support (`CC/Controller.py:707-712`); this firmware documents `-v`. Verify which
flag stock firmware actually honours before using either.

---

## 9. The echo sentinel, confirmed on hardware

```
→ CTRL_MULTI 'ls -e -s /sd/gcodes'
→ CTRL_MULTI 'echo \x04'
← LOAD_INFO   … listing …
← LOAD_FINISH b'Load directory finished.\r\n'
← NORMAL_INFO b'echo: \x04\r\n'
```

The sentinel returns as a `NORMAL_INFO` (`0x90`) frame with the payload
`echo: \x04\r\n` — the firmware prefixes echo output with `echo: `. Detection
should look for `\x04` anywhere in a `0x90` payload, which is what
`hagmonk/carvera-cli` does (`HAG/device/manager.py:334-336`).

It worked on every command we issued, including ones that also produce a natural
EOT (`-e` forms). ADR-004 stands.

---

## 10. Open questions answered, and the ones that remain

### Answered by this session

| # | Question | Answer |
|---|---|---|
| 1 | What does `help` list? | §8 — and it is incomplete |
| 2 | Exact `ls -e -s` columns, directory marking | §5 — `name size timestamp`, dirs end in `/` |
| 4 | Does the Z1 accept `.lz`? | **No.** `ftype = nc` (§2.3) |
| 5 | Does the MD5 placeholder affect uploads? | **No** on this firmware — `md5sum` returns a real digest (§6) |
| 7 | Z1 machine dimensions | Partially: G54 offset and a 5-axis (X,Y,Z,A,B) kinematic. Travel limits still need `config-get` |

### Still open

| # | Question | How to settle it |
|---|---|---|
| 3 | Does the Z1 emit `M485` protocol announcements? | Never observed. Autodetect worked, so this is academic |
| 6 | `config_z1.json` shipped but unwired upstream | Run `config-get-all -e` and diff the key set against `CC/config_z1.json` |
| **NEW** | **`E:` field order in `diagnose` (8 values, not 6)** | **Open the cover, re-capture `diagnose`, diff. Blocks the §17.2 interlock** |
| NEW | `E:` in the *status* report (5 values) — meaning unknown | Correlate against machine activity |
| NEW | `OTA:0,0` semantics | Probably OTA update state; harmless to pass through |
| NEW | Does `play` take `-O` or `-v` on stock firmware? | Test on a scratch air-cut file, with the spindle off and the operator present — not before |
| NEW | Does the download path return the placeholder MD5? | Requires implementing the framed download (phase 3) |

---

## 11. Reproducing this session

```bash
# Passive; cannot affect the machine.
python3 scripts/03-discover.py --listen 25

# Read-only; every command is checked against an allowlist before it is sent.
python3 scripts/05-probe.py --host 192.168.0.55
python3 scripts/05-probe.py --host 192.168.0.55 --hex --cmd "ls -e -s /sd/gcodes"
python3 scripts/05-probe.py --host 192.168.0.55 \
    --cmd "md5sum /sd/gcodes/goto-pack-pos-z1.nc -e" \
    --cmd "get wcs" --cmd "get state" --cmd "get pos" --cmd "progress" --cmd "mem"
```

`scripts/05-probe.py` implements framing from our own specification rather than
importing upstream, so a successful run is an end-to-end validation of the spec,
not of upstream's code.

**Note:** the probe holds the machine's single TCP slot while it runs. Makera's
controller and the Community controller cannot connect at the same time.
