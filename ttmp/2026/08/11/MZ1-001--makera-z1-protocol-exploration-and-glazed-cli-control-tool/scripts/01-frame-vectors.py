#!/usr/bin/env python3
"""
Experiment 01 — Makera frame encoder golden vectors.

Assumption under test:
  "A Makera control frame is header(0x8668) | length(2,BE) | type(1) | payload |
   crc16-ccitt(2,BE) | footer(0x55AA), where length = 1 + len(payload) + 2 and
   the CRC covers length+type+payload (NOT the header/footer)."

This script re-implements the encoder from first principles (bitwise CRC, no
lookup table) and cross-checks it against the vendored Community Controller
implementation (table-driven). If both agree on every vector, the spec written
in the design doc is correct and a Go port can be validated against these hex
strings without a machine present.

Run:
    python3 scripts/01-frame-vectors.py

Expected: every line prints "OK", final line "all vectors agree".
"""

import sys
import pathlib

VENDOR = pathlib.Path(__file__).resolve().parents[1] / "vendor" / "community-carvera-controller"
sys.path.insert(0, str(VENDOR))

from carveracontroller.protocols.framing import build_frame, crc16_ccitt  # noqa: E402

FRAME_HEADER = 0x8668
FRAME_END = 0x55AA
PTYPE_CTRL_SINGLE = 0xA1
PTYPE_CTRL_MULTI = 0xA2
PTYPE_FILE_START = 0xB0


def crc16_ccitt_bitwise(data: bytes) -> int:
    """CRC-16/CCITT (poly 0x1021, init 0x0000, no reflection, no final xor)."""
    crc = 0x0000
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc


def build_frame_reference(ptype: int, payload: bytes = b"") -> bytes:
    length = 1 + len(payload) + 2  # type + payload + crc
    body = length.to_bytes(2, "big") + bytes([ptype]) + payload
    crc = crc16_ccitt_bitwise(body)
    return (
        FRAME_HEADER.to_bytes(2, "big")
        + body
        + crc.to_bytes(2, "big")
        + FRAME_END.to_bytes(2, "big")
    )


VECTORS = [
    ("realtime '?' (status query)", PTYPE_CTRL_SINGLE, b"?"),
    ("realtime 0x18 (soft reset)", PTYPE_CTRL_SINGLE, bytes([0x18])),
    ("realtime '!' (feed hold)", PTYPE_CTRL_SINGLE, b"!"),
    ("realtime '~' (cycle start)", PTYPE_CTRL_SINGLE, b"~"),
    ("command 'version'", PTYPE_CTRL_MULTI, b"version"),
    ("command 'model'", PTYPE_CTRL_MULTI, b"model"),
    ("command 'G0 X10 Y10'", PTYPE_CTRL_MULTI, b"G0 X10 Y10"),
    ("command 'diagnose'", PTYPE_CTRL_MULTI, b"diagnose"),
    ("file-start 'upload /sd/gcodes/part.nc'", PTYPE_FILE_START, b"upload /sd/gcodes/part.nc\n"),
    ("empty payload", PTYPE_CTRL_MULTI, b""),
]


def main() -> int:
    # Known CRC self-check: CRC-16/CCITT-FALSE differs (init 0xFFFF); ours is init 0.
    assert crc16_ccitt_bitwise(b"123456789") == 0x31C3, "CRC init must be 0x0000"
    assert crc16_ccitt(b"123456789") == 0x31C3, "vendored CRC disagrees on check value"
    print('OK   crc16("123456789") == 0x31C3 (poly 0x1021, init 0x0000)')

    failures = 0
    for name, ptype, payload in VECTORS:
        mine = build_frame_reference(ptype, payload)
        theirs = build_frame(ptype, payload)
        status = "OK  " if mine == theirs else "FAIL"
        if mine != theirs:
            failures += 1
        print(f"{status} {name}")
        print(f"       payload={payload!r}")
        print(f"       frame  ={mine.hex(' ')}")
        # Structural invariants a Go port must also satisfy.
        assert mine[:2] == b"\x86\x68"
        assert mine[-2:] == b"\x55\xaa"
        declared = int.from_bytes(mine[2:4], "big")
        assert declared == 1 + len(payload) + 2, "length field must include type+crc"
        assert len(mine) == 2 + 2 + declared + 2, "total = header + len + declared + footer"

    if failures:
        print(f"\n{failures} vector(s) disagree")
        return 1
    print("\nall vectors agree")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
