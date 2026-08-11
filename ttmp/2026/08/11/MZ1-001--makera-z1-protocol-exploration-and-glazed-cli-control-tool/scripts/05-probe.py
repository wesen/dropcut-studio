#!/usr/bin/env python3
"""
Experiment 05 — live read-only probe against a real machine.

Assumptions under test (all previously derived from source only):
  1. Our from-spec frame encoder produces frames the machine accepts.
  2. Our from-spec frame decoder parses what the machine sends back.
  3. Protocol detection works: unframed `echo echo` gets silence on a Z1.
  4. The echo sentinel (`echo \\x04`) reliably terminates a command's output.
  5. The status `<...>` and diagnose `{...}` grammars match the real thing.

SAFETY: this script cannot move the machine. Every outbound command is checked
against a read-only allowlist, and the only realtime byte permitted is '?'
(status query). Anything else raises before a byte reaches the socket.

Run:
    python3 scripts/05-probe.py --host 192.168.0.55
    python3 scripts/05-probe.py --host 192.168.0.55 --hex        # frame dump
    python3 scripts/05-probe.py --host 192.168.0.55 --cmd help
"""

import argparse
import select
import socket
import sys
import time

TCP_PORT = 2222

FRAME_HEADER = 0x8668
FRAME_END = 0x55AA
PTYPE_CTRL_SINGLE = 0xA1
PTYPE_CTRL_MULTI = 0xA2
MAX_FRAME_DATA_LENGTH = 8200

PTYPE_NAMES = {
    0xA1: "CTRL_SINGLE", 0xA2: "CTRL_MULTI", 0xB0: "FILE_START",
    0xB1: "FILE_MD5", 0xB2: "FILE_VIEW", 0xB3: "FILE_DATA",
    0xB4: "FILE_END", 0xB5: "FILE_CAN", 0xB6: "FILE_RETRY",
    0x81: "STATUS_RES", 0x82: "DIAG_RES", 0x83: "LOAD_INFO",
    0x84: "LOAD_FINISH", 0x85: "LOAD_ERROR", 0x90: "NORMAL_INFO",
}

# --- safety -----------------------------------------------------------------

# Verbs confirmed read-only against Z1 firmware 1.0.15.0.1.11 (`help`, 2026-08-11).
# 'switch' is deliberately excluded: `switch name` queries but `switch name value`
# actuates, and one typo is the difference.
READ_ONLY_VERBS = {
    "version", "model", "time", "ftype", "diagnose", "help",
    "ls", "cat", "md5sum", "config-get-all", "config-get", "echo", "wlan",
    "get", "pwd", "mem", "net", "progress", "thermistors",
}

MOTION_MARKERS = ("$h", "$j", "$x", "g0", "g1", "g2", "g3", "g28", "g53",
                  "m3", "m4", "m5", "m6", "play", "suspend", "resume",
                  "abort", "reset", "upload", "download", "rm", "mv",
                  "mkdir", "config-set", "config-default", "config-restore",
                  "baud", "buffer")


def assert_read_only(cmd: str) -> None:
    """Refuse anything that could move the machine or mutate its state."""
    stripped = cmd.strip()
    low = stripped.lower()
    verb = low.split()[0] if low.split() else ""
    if verb in MOTION_MARKERS or any(low.startswith(m) for m in MOTION_MARKERS):
        raise SystemExit(f"REFUSED: {stripped!r} is not read-only")
    if verb not in READ_ONLY_VERBS:
        raise SystemExit(
            f"REFUSED: {stripped!r} — verb {verb!r} is not on the read-only "
            f"allowlist {sorted(READ_ONLY_VERBS)}"
        )
    # 'wlan' with arguments joins a network; only the bare listing form is safe.
    if verb == "wlan" and low.replace("-e", "").strip() != "wlan":
        raise SystemExit(f"REFUSED: {stripped!r} — only bare 'wlan -e' is read-only")


# --- framing (written from our own spec, not copied from upstream) -----------

def crc16_ccitt(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def build_frame(ptype: int, payload: bytes = b"") -> bytes:
    length = 1 + len(payload) + 2
    body = length.to_bytes(2, "big") + bytes([ptype]) + payload
    return (FRAME_HEADER.to_bytes(2, "big") + body
            + crc16_ccitt(body).to_bytes(2, "big") + FRAME_END.to_bytes(2, "big"))


class Decoder:
    def __init__(self):
        self.state = "hdr"
        self.body = bytearray()
        self.hdr = bytearray(2)
        self.ftr = bytearray(2)
        self.needed = 2
        self.drops = 0

    def feed(self, data: bytes):
        out = []
        for b in data:
            f = self._byte(b)
            if f is not None:
                out.append(f)
        return out

    def _byte(self, b: int):
        if self.state == "hdr":
            self.hdr[0], self.hdr[1] = self.hdr[1], b
            if (self.hdr[0] << 8 | self.hdr[1]) == FRAME_HEADER:
                self.state, self.needed = "len", 2
                self.body.clear()
        elif self.state == "len":
            self.body.append(b)
            self.needed -= 1
            if self.needed == 0:
                n = self.body[0] << 8 | self.body[1]
                if 0 <= n <= MAX_FRAME_DATA_LENGTH:
                    self.state, self.needed = "data", n
                else:
                    self.state, self.drops = "hdr", self.drops + 1
        elif self.state == "data":
            self.body.append(b)
            self.needed -= 1
            if self.needed == 0:
                self.state, self.needed = "ftr", 2
        elif self.state == "ftr":
            self.ftr[0], self.ftr[1] = self.ftr[1], b
            self.needed -= 1
            if self.needed == 0:
                self.state = "hdr"
                if (self.ftr[0] << 8 | self.ftr[1]) != FRAME_END:
                    self.drops += 1
                    return None
                body = bytes(self.body)
                if len(body) < 5:
                    self.drops += 1
                    return None
                want = body[-2] << 8 | body[-1]
                if crc16_ccitt(body[:-2]) != want:
                    self.drops += 1
                    return None
                return (body[2], body[3:-2])
        return None


ESCAPE = {" ": "\x01", "?": "\x02", "&": "\x03", "!": "\x04", "~": "\x05"}


def escape(value: str) -> str:
    for a, b in ESCAPE.items():
        value = value.replace(a, b)
    return value


def unescape(value: str) -> str:
    for a, b in ESCAPE.items():
        value = value.replace(b, a)
    return value


# --- session ----------------------------------------------------------------

class Probe:
    def __init__(self, host, port=TCP_PORT, hexdump=False):
        self.hexdump = hexdump
        self.dec = Decoder()
        self.sock = socket.create_connection((host, port), timeout=2)
        self.sock.settimeout(0.3)

    def close(self):
        self.sock.close()

    def _send(self, raw: bytes, label: str):
        if self.hexdump:
            print(f"  → {label:<26} {raw.hex(' ')}")
        self.sock.sendall(raw)

    def drain(self, seconds=0.3):
        deadline = time.time() + seconds
        while time.time() < deadline:
            r, _, _ = select.select([self.sock], [], [], 0.02)
            if r:
                if not self.sock.recv(4096):
                    break

    def detect(self, attempts=3):
        """Unframed probe. A reply containing 'echo' means legacy Smoothie."""
        self.drain(0.3)
        for i in range(attempts):
            self.sock.sendall(b"echo echo\n")
            time.sleep(0.1)
            r, _, _ = select.select([self.sock], [], [], 0.1)
            if r:
                data = self.sock.recv(64)
                if b"echo" in data:
                    return "smoothie", data
                if self.hexdump and data:
                    print(f"  ← probe {i} non-echo reply: {data.hex(' ')}")
        return "makera", b""

    def collect(self, timeout=6.0, sentinel=True):
        """Read frames until the echo sentinel arrives or we go quiet."""
        frames, deadline, last = [], time.time() + timeout, time.time()
        while time.time() < deadline:
            r, _, _ = select.select([self.sock], [], [], 0.05)
            if not r:
                if sentinel is False and time.time() - last > 0.6:
                    break
                continue
            data = self.sock.recv(4096)
            if not data:
                break
            last = time.time()
            for ptype, payload in self.dec.feed(data):
                if self.hexdump:
                    name = PTYPE_NAMES.get(ptype, f"0x{ptype:02X}")
                    print(f"  ← {name:<26} {payload[:900]!r}")
                if sentinel and b"\x04" in payload:
                    return frames
                frames.append((ptype, payload))
        return frames

    def command(self, cmd: str, timeout=6.0):
        assert_read_only(cmd)
        self._send(build_frame(PTYPE_CTRL_MULTI, cmd.encode()), f"CTRL_MULTI {cmd!r}")
        self._send(build_frame(PTYPE_CTRL_MULTI, b"echo \x04"), "CTRL_MULTI sentinel")
        return self.collect(timeout=timeout)

    def status(self, timeout=2.0):
        self._send(build_frame(PTYPE_CTRL_SINGLE, b"?"), "CTRL_SINGLE '?'")
        return self.collect(timeout=timeout, sentinel=False)


def text_of(frames):
    return [p.decode(errors="replace").rstrip("\r\n") for _, p in frames if p]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, default=TCP_PORT)
    ap.add_argument("--hex", action="store_true", dest="hexdump")
    ap.add_argument("--cmd", action="append", default=None,
                    help="extra read-only command (repeatable)")
    args = ap.parse_args()

    print(f"connecting to {args.host}:{args.port} ...")
    p = Probe(args.host, args.port, hexdump=args.hexdump)
    print("connected (we now hold the machine's single connection slot)\n")

    try:
        name, reply = p.detect()
        print(f"== protocol detection ==\n  verdict: {name}"
              + (f"  (reply {reply!r})" if reply else "  (silence on all 3 probes)") + "\n")
        if name != "makera":
            print("  machine is speaking legacy text; this probe only speaks framed.")
            return 1

        print("== identity ==")
        for cmd in ("version", "model", "ftype", "time"):
            for line in text_of(p.command(cmd)):
                print(f"  {cmd:<8} | {line}")
        print()

        print("== status (realtime '?') ==")
        for line in text_of(p.status()):
            print(f"  {line}")
        print()

        print("== diagnose ==")
        for line in text_of(p.command("diagnose")):
            print(f"  {line}")
        print()

        for cmd in (args.cmd or []):
            print(f"== {cmd} ==")
            for line in text_of(p.command(cmd, timeout=10.0)):
                print(f"  {unescape(line)}")
            print()

        print(f"decoder drops (bad crc/footer/length): {p.dec.drops}")
    finally:
        p.close()
        print("disconnected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
