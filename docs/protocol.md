# Makera Wire Protocol

The specification `z1ctl` implements. Derived by reading the open-source
clients listed in NOTICE, then validated against a Makera Z1 running firmware
1.0.15.0.1.11. See `docs/observations-z1-1.0.15.md` for hardware ground truth,
which outranks this document wherever they disagree.



# Makera Wire Protocol Reference

Companion to `design/01-…-analysis-design-and-implementation-guide.md`. That
document explains *why*; this one is the lookup table.

> ## ⚠ Read `reference/03-live-z1-observations-firmware-1-0-15.md` first
>
> **This document was derived entirely from upstream source.** On 2026-08-11 it
> was checked against a real Z1 (firmware `1.0.15.0.1.11`). The framing, CRC,
> newline rules, protocol detection and echo sentinel all held up — **zero
> decoder drops**. Several *payload* formats did not. Where the two documents
> disagree, `reference/03` is authoritative.
>
> Known divergences on stock Z1 firmware `1.0.15.0.1.11`:
>
> | Here | On the real machine |
> |---|---|
> | discovery record has 4 fields | **5** — field 4 is the machine state (`Idle`) |
> | `model = <name>, <id>, <func>, <extra>` | **5 fields** — trailing machine state |
> | `version = X.Y.Z[suffix]` | **six components** (`1.0.15.0.1.11`); upstream's regex truncates to `1.0.15` |
> | `ftype` may be `lz` | **`nc`** — this firmware accepts **no compressed uploads** |
> | `MPos` / `WPos` = `x,y,z[,a]` | **`x,y,z,a,b`** — five axes |
> | status includes `G:` (active WCS) | **absent** — you must call `get wcs` |
> | status keys are documented | plus undocumented **`E:`** (5 values) and **`OTA:`** (2 values) |
> | diagnose `E:` has 6 values | **8** — field order unconfirmed, so **do not build the cover interlock on it yet** |
> | diagnose `S:` 2, `G:` 1 | **6** and **5** |
> | `md5sum` returns a placeholder on Z1 | returns a **real digest**, concatenated with the path, no separator |
> | `ls` columns unverified | `name size timestamp`; **directories end in `/`**, size 0; `\r\n`-terminated |

All paths below are relative to this ticket. `CC/` = `vendor/community-carvera-controller/carveracontroller/`,
`OEM/` = `vendor/makera-carvera-controller/src/`, `HAG/` = `vendor/hagmonk-carvera-cli/src/carvera_cli/`.

---

## 1. Ports

| Port | Proto | Purpose | Source |
|---|---|---|---|
| 3333 | UDP | machine broadcast announcement | `CC/WIFIStream.py:13` |
| 2222 | TCP | control channel (single client) | `CC/WIFIStream.py:12` |
| 80 | TCP | ESP32 HTTP, camera resolution (Z1) | `CC/addons/camera/Z1Camera.py:41-42` |
| 82 | TCP | ESP32 WebSocket `/ws_video` (Z1) | `CC/addons/camera/Z1Camera.py:33-35` |

Discovery record: `name,ip,port,busy[,extra…]`, `busy == "1"`, >3 fields required,
128-byte read. `CC/WIFIStream.py:52-72`.

Busy check = attempt TCP connect; success means *not* busy. `CC/WIFIStream.py:29-36`.

---

## 2. Frame

```
 HEADER(2)  LENGTH(2)  TYPE(1)  PAYLOAD(N)  CRC(2)  FOOTER(2)
 0x8668       N+3        TT        ...       CCCC   0x55AA
             └────────── CRC covers this ──────────┘
 big-endian throughout ·  total on wire = N + 9
```

- `LENGTH = 1 + N + 2` (type + payload + crc). **Not** the payload length.
- CRC-16/CCITT: poly `0x1021`, **init `0x0000`**, no reflection, no final XOR.
  Check value `crc16("123456789") == 0x31C3`.
- `MAX_FRAME_DATA_LENGTH = 8200` (largest legit frame: 8192 data + 4 seq + 1 type + 2 crc).

Source: `CC/protocols/framing.py:8-27, 290-344`; OEM spec comments `OEM/Controller.py:241-282`.

### Packet types

| Hex | Name | Dir | Meaning |
|---|---|---|---|
| A1 | CTRL_SINGLE | → | one realtime byte |
| A2 | CTRL_MULTI | → | text command |
| B0 | FILE_START | → | `upload …` / `download …` |
| B1 | FILE_MD5 | ↔ | digest exchange |
| B2 | FILE_VIEW | ↔ | packet count (+ block size on upload) |
| B3 | FILE_DATA | ↔ | data block, or request for block *n* |
| B4 | FILE_END | ↔ | complete |
| B5 | FILE_CAN | ↔ | cancel |
| B6 | FILE_RETRY | ↔ | resend last frame |
| 81 | STATUS_RES | ← | reply to `?` — text `<…>` |
| 82 | DIAG_RES | ← | reply to `diagnose` — text `{…}` |
| 83 | LOAD_INFO | ← | bulk listing chunk |
| 84 | LOAD_FINISH | ← | bulk listing EOF |
| 85 | LOAD_ERROR | ← | bulk listing failed |
| 90 | NORMAL_INFO | ← | unsolicited text |

`CC/protocols/framing.py:11-25`.

81 / 82 / 90 all carry plain text and are handled identically by the RX parser
(`CC/protocols/makera.py:149-157`). Structure lives in the text, not the type.

### Golden vectors

```
?            86 68 00 04 a1 3f 35 33 55 aa
0x18         86 68 00 04 a1 18 61 b6 55 aa
!            86 68 00 04 a1 21 c6 cc 55 aa
~            86 68 00 04 a1 7e 6d d6 55 aa
version      86 68 00 0a a2 76 65 72 73 69 6f 6e cc a0 55 aa
model        86 68 00 08 a2 6d 6f 64 65 6c 52 01 55 aa
G0 X10 Y10   86 68 00 0d a2 47 30 20 58 31 30 20 59 31 30 9f fe 55 aa
diagnose     86 68 00 0b a2 64 69 61 67 6e 6f 73 65 76 c5 55 aa
(empty)      86 68 00 03 a2 c0 fb 55 aa
```

Generated and cross-checked by `scripts/01-frame-vectors.py`.

### RX state machine

`WAIT_HEADER → READ_LENGTH(2) → READ_DATA(LENGTH) → CHECK_FOOTER(2) → emit`

Reset to `WAIT_HEADER` on out-of-range length, wrong footer, or CRC mismatch.
`CC/protocols/makera.py:89-133`.

**Known desync:** garbage containing `86 68` + a plausible length locks the
decoder onto a false frame and swallows the real frames behind it until the
length runs out. No byte-stuffing exists. Log every drop. Reproduced in
`scripts/02-goframe/main.go`.

---

## 3. Newline rules

| Encoder | Rule | Source |
|---|---|---|
| `0xA2` CTRL_MULTI | **strip** trailing `\r\n` | `CC/protocols/makera.py:64-70` |
| `0xB0` FILE_START | **append** `\n` if absent | `CC/protocols/makera.py:75-81` |
| smoothie (text) | **append** `\n` if absent | `CC/protocols/smoothie.py:20-26` |

Reason a trailing `\n` in `0xA2` is harmful: firmware numeric parsers use
`strtol`, which requires `*end == '\0'`; `baud 115200\n` fails to parse.

---

## 4. Protocol detection

Active probe — `CC/protocols/detector.py:11-59`:

```
drain RX (getc(1, timeout=0.01) until empty)
repeat 3×:
    send RAW ASCII b"echo echo\n"     # deliberately unframed
    sleep 0.1 s
    read ≤10 bytes, timeout 0.1 s
    if b"echo" in reply  →  "smoothie"
all timed out            →  "makera"
```

Default on any failure: `makera` (`CC/protocols/registry.py:16`).

Passive switches — `CC/protocols/session.py:131-148`:

1. currently smoothie **and** raw bytes contain `86 68` → switch to makera
2. a line containing `makera communication protocol` /
   `smoothie communication protocol` /
   `current communication protocol: <name>` → switch (M485 family)

Both suppressed during file transfer (`allow_wire_switch=False`,
`CC/Controller.py:2225-2226`).

---

## 5. Argument escaping

| Char | → | | Char | → |
|---|---|---|---|---|
| space | `0x01` | | `!` | `0x04` |
| `?` | `0x02` | | `~` | `0x05` |
| `&` | `0x03` | | | |

`CC/Controller.py:627-629` (+ per-call-site space handling); inverse at
`HAG/device/manager.py:110-122`. `\` → `/` at every call site.

---

## 6. Realtime bytes (`0xA1`)

| Byte | Meaning |
|---|---|
| `?` 0x3F | status query |
| `!` 0x21 | feed hold |
| `~` 0x7E | cycle start / resume |
| 0x18 | soft reset (Ctrl-X) — `CC/Controller.py:1765-1766` |
| 0x1A | jog keepalive, **makera only** |
| `'1'` | jog keepalive, **smoothie only** |

Keepalive is sent as the digram `? + keepalive` in **one write**; separate writes
leave orphaned bytes in the firmware command buffer.
`CC/Controller.py:1729-1742, 1271-1288`.

---

## 7. Command surface

### Shell

`version` · `model` · `time [epoch]` · `ftype` · `diagnose` · `help`
`ls -e -s <dir>` · `cat <f> -e` · `rm <f> -e` · `mv <a> <b> -e` · `mkdir <d> -e` · `md5sum <f> -e`
`upload <path>` · `download <path>` (both as `0xB0`)
`play <path> [-O]` · `suspend` · `resume` · `abort`
`config-get-all -e` · `config-set sd <k> <v>` · `config-restore` · `config-default`
`wlan -e` · `wlan <ssid> <pw> -e` · `wlan -d disconnect`
`buffer <cmd>` · `echo <text>` · `reset` (**blocked over USB**, `CC/Controller.py:240-243`)
`baud <rate>`

`-e` suffix = terminate the reply with EOT (`LOAD_FINISH` 0x84 framed / literal
`0x04` legacy).

### GRBL-style

`$H` home · `$J <axis><delta> [F<feed>]` jog · `$F S<n>` feed ovr · `$O S<n>` ovr · `$X` unlock
`CC/Controller.py:1779-1780, 1865-1875`.

### Makera M-codes

| Code | Meaning | | Code | Meaning |
|---|---|---|---|---|
| M220 S | feed override % | | M801 S / M802 | vacuum on / off |
| M223 S | spindle override % | | M811 S / M812 | spindle fan on / off |
| M321 / M322 | laser mode on / off | | M821 / M822 | light on / off |
| M323 / M324 | laser test on / off | | M831 / M832 | tool sensor pwr on / off |
| M325 S | laser power scale | | M841 / M842 | probe charger on / off |
| M331/.3, M332/.3 | vacuum / ext-out mode | | M851 S / M852 | ext control PWM on / off |
| M370 | clear auto-leveling | | M3 S / M5 | spindle on / off |
| M471 | pair wireless probe | | M7 / M9 | air on / off |
| M490.1/.2/.4 | clamp / unclamp / change | | M6 T\<n\> | tool change |
| M491 | drop tool | | M493.2 T\<n\> | set current tool |
| M495 X Y | auto-leveling | | M495.3 H D | XYZ probe |
| M496.1…M496.5 | goto clearance / work origin / anchor1 / anchor2 / path origin | | | |

### Safe movement idioms

```
G53 G0 Z-2                       # safe Z, machine coords, 2 mm below home
G53 G0 Z-2 ; G53 G0 X-2 Y-2      # park at machine home, Z first
```

`CC/Controller.py:1889-1896`. Always retract Z before XY.

---

## 8. Status report `<…>`

```
<STATE|KEY:v[,v…]|KEY:v[,v…]|…>
```

Parse: outermost `<` … `>`, split `|`, split each chunk on the **first** `:`,
values are comma-separated floats. Every key optional; vectors grow with
firmware. `CC/Controller.py:1310-1449`.

| Key | Vector |
|---|---|
| *(state)* | Idle · Run · Tool · Alarm · Home · Hold · Wait · Disable · Sleep · Pause |
| MPos | x, y, z[, a] |
| WPos | x, y, z[, a] |
| R | rotation angle (community fw) |
| G | active WCS index (0 = G54) |
| C | model, funcSetting, inchMode, absoluteMode |
| F | feedCur, feedTarget, feedOvr%[, spindleTemp (fw ≤2.1.0)] |
| S | rpmCur, rpmTarget, rpmOvr%[, vacuumMode, temp, …, extOutMode] |
| T | tool, tlo[, targetTool, colletType] — absent ⇒ tool = −1 |
| W | wireless-probe voltage |
| L | laserMode, laserState, laserTesting, laserPower, laserScale |
| P | playedLines, percent, seconds[, isPlaying] — absent ⇒ not playing |
| A | ATC state |
| O | max leveling delta |
| H | halt reason |

Rotation-aware work offset:

```
wcox = mx − (cos θ · wx − sin θ · wy)
wcoy = my − (sin θ · wx + cos θ · wy)
wcoz = mz − wz          θ = R, degrees
```

`inchMode == 1` ⇒ unit scale 25.4.

---

## 9. Diagnose report `{…}`

```
{S:0,5000|L:0,0|F:1,0|V:0,1|G:0|T:0|E:0,0,0,0,0,0|P:0,0|A:1,0|RSSI:-57}
```

`CC/Controller.py:1451-1513`. Same grammar, all integers, first-colon split
required for `RSSI:-57`.

| Key | Vector |
|---|---|
| S / L / F / V | switch, slaved — spindle / laser / spindle fan / vacuum |
| G | light switch |
| T | tool sensor power |
| R | air |
| C | probe charger power |
| **E** | xMin, xMax, yMin, yMax, zMax, **cover** |
| P | probe, calibrate |
| A | atcHome, toolSensor |
| **I** | eStop |
| RSSI | dBm |

---

## 10. Firmware identity lines

```
version = 1.0.5c     regex  version = \d+\.\d+\.\d+[a-zA-Z0-9\-_]*
model = Z1, 2, 3, 0  regex  model = (\w+), (\d+), (\d+), (\d+)
                            name, MachineModel id, FuncSetting, extra
time = 1754937600
ftype = lz
decompart = 42
```

`CC/main.py:4151-4193`. A `c` in the version ⇒ Community firmware
(`CC/main.py:4160`). Model names seen: `Z1`, `C1`, `CA1` (`CC/main.py:5112-5124`).

---

## 11. Polling cadence

| What | Interval | Source |
|---|---|---|
| `?` status | 0.2 s | `STREAM_POLL`, `CC/Controller.py:35` |
| `diagnose` | 0.5 s (only when panel open) | `DIAGNOSE_POLL`, `CC/Controller.py:36` |
| both | **suspended** while `sendNUM>0 \|\| loadNUM>0 \|\| pausing` | `CC/Controller.py:2209-2220` |

Adaptive backoff: data received ⇒ delay 0; otherwise ramp 0 → 0.1 s in 0.01 s
steps (`CC/Controller.py:2228-2233`).

---

## 12. File transfer (framed)

Block size: **8192** over Wi-Fi (`xmodem8k`), **128** over USB (`xmodem`).
`CC/XMODEM.py:464-473`, `CC/WIFIStream.py:84`, `CC/USBStream.py:21`.
Sequence numbers are 1-based big-endian `u32`.

### Upload — `CC/XMODEM.py:740-817`

```
→ 0xB0 "upload <escaped path>\n"
→ 0xB1 FILE_MD5  <32 hex digest of the UNCOMPRESSED file>
← 0xB5 FILE_CAN                       cache hit ⇒ SUCCESS, done
← 0xB2 FILE_VIEW (request)
→ 0xB2 FILE_VIEW  u32 packetCount ‖ u16 blockSize     (ceil(size/blockSize))
← 0xB3 FILE_DATA  u32 seq                             machine REQUESTS seq
→ 0xB3 FILE_DATA  u32 seq ‖ <block bytes>
   ... seq == lastseq      ⇒ resend the same bytes
   ... seq != lastseq + 1  ⇒ seek to (seq−1)*blockSize
← 0xB6 FILE_RETRY                     ⇒ resend the last frame sent
← 0xB4 FILE_END                       ⇒ SUCCESS
   no frame for 9 s        ⇒ send FILE_CAN, fail
```

### Download — `CC/XMODEM.py:609-738`

States `WAIT_MD5 → WAIT_FILE_VIEW → READ_FILE_DATA`.

```
→ 0xB0 "download <escaped path>\n"
← 0xB1 FILE_MD5 <digest>
   digest == our cached local digest ⇒ → 0xB5 FILE_CAN, SUCCESS (already have it)
→ 0xB2 FILE_VIEW (request)
← 0xB2 FILE_VIEW  u32 totalPackets
→ 0xB3 FILE_DATA  u32 1               request block 1
← 0xB3 FILE_DATA  u32 seq ‖ <data>
→ 0xB3 FILE_DATA  u32 seq+1           ack + request next
   ... until seq == totalPackets
→ 0xB4 FILE_END
```

Inbound `FILE_DATA` body layout (offsets into length+type+payload+crc):

```
body[0..1] LENGTH   body[2] type=0xB3   body[3..6] u32 seq   body[7..] data
dataLen = LENGTH − 7          (1 type + 4 seq + 2 crc)
```

### MD5 policy — `CC/XMODEM.py:487-554`

| Advertised digest | Action |
|---|---|
| not `^[0-9a-f]{32}$` | **skip** the check, log it |
| payload starts `\x00\x00` (QuickLZ) | **defer** until after decompress |
| otherwise | require exact match, else reject |

> **Z1 quirk:** stock Z1 firmware answers `md5sum` with the literal
> `default_md5_hash_value_32_bytes_` — 32 characters, not hex. A length-only
> check accepts it and then fails every download.
> `CC/XMODEM.py:487-505`; release note in `sources/web/01-…:105`.

### Compression

Enabled when `ftype` contains `lz`. QuickLZ, block-wise (`CC/main.py:5485`).
Compressed copies live in a `.lz/` subdirectory. Machine reports progress via
`decompart = <percent>`.

### RX exclusion

The status poller and the transfer share one socket. Upstream sets `paused=True`
**immediately** and then waits for the reader to park before touching RX
(`CC/Controller.py:2140-2152`). In Go: one reader goroutine, an explicit
`ModeControl` / `ModeTransfer` switch.

---

## 13. Transports

| | Wi-Fi | USB |
|---|---|---|
| Address | `ip[:2222]` | serial device |
| Connect timeout | 2 s, then 0.3 s steady | 0.3 s |
| Read chunk | 1024 B | 1 B (`serial.read()`) |
| Transfer block | 8192 | 128 |
| Open side effects | none | **DTR toggle resets the machine**; sleep 2.0 s |
| Heartbeat grace | 5 s | 20 s |
| Baud | — | 115200, upgradable post-connect |

`CC/WIFIStream.py:12-14, 105-112`; `CC/USBStream.py:10, 21, 71-80`;
`CC/Controller.py:1568-1591`.

---

## 14. Z1-specific facts

| Fact | Source |
|---|---|
| Model string is `Z1` | `CC/main.py:5115` |
| Rotary geometry: base 263 mm, head 50 mm | `CC/main.py:5116-5117` |
| `md5sum` returns `default_md5_hash_value_32_bytes_` | `CC/XMODEM.py:487-505` |
| Camera: ESP32, `ws://host:82/ws_video`, send `start_stream`, one JPEG per binary message | `CC/addons/camera/Z1Camera.py:1-35` |
| Camera resolution: HTTP port 80 `/api/camera/resolution`, framesize 10 (640×480, ~20 fps) … 15 (1600×1200, ~10 fps); out-of-range returns 200 and is ignored | `CC/addons/camera/Z1Camera.py:37-62` |
| No exposure / gain / white-balance controls exist | `CC/addons/camera/Z1Camera.py:37-41` |
| `config_z1.json` ships but `load_machine_config_data` only maps C1 and CA1 | `CC/config_z1.json`, `CC/main.py:5296-5302` |
| "Initial Z1 support" landed in v2.2.0-RC1, 04 Aug 2026 | `sources/web/01-…:30-73` |
