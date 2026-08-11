#!/usr/bin/env python3
"""
Experiment 03 — UDP discovery listener and record parser.

Assumption under test:
  "A Carvera/Z1 broadcasts a comma-separated ASCII record to UDP :3333 that
   parses as name,ip,port,busy — and discovery is passive (the host never sends
   a probe, it just binds and listens)."

Two modes:

  --self-test   Parse synthetic records offline. Proves the parser is right and
                documents the record shape. Runs with no machine present.

  --listen N    Bind 0.0.0.0:3333 and print every record seen for N seconds.
                Run this on the same L2 segment as the machine.

Run:
    python3 scripts/03-discover.py --self-test
    python3 scripts/03-discover.py --listen 10

Expected (self-test): all cases print OK, final line "parser ok".
Note: binding :3333 fails with EADDRINUSE if Makera's own controller is running.
"""

import argparse
import socket
import sys
import time

UDP_PORT = 3333
TCP_PORT = 2222
BUFFER = 128  # upstream reads 128 bytes per datagram


def parse_record(data: bytes):
    """Parse one discovery datagram. Returns a dict, or None if unparseable.

    Upstream (WIFIStream.MachineDetector.check_for_responses) splits on ',' and
    requires more than 3 fields; extra trailing fields are ignored, which is what
    makes the format forward-compatible.
    """
    try:
        fields = data.decode("utf-8").strip().split(",")
    except UnicodeDecodeError:
        return None
    if len(fields) <= 3:
        return None
    try:
        port = int(fields[2])
    except ValueError:
        return None
    return {
        "machine": fields[0],
        "ip": fields[1],
        "port": port,
        "busy": fields[3] == "1",
        "extra": fields[4:],
    }


SELF_TEST_CASES = [
    (b"Carvera_1234,192.168.1.50,2222,0", {"machine": "Carvera_1234", "ip": "192.168.1.50", "port": 2222, "busy": False, "extra": []}),
    (b"Z1_ABCDEF,10.0.0.23,2222,1", {"machine": "Z1_ABCDEF", "ip": "10.0.0.23", "port": 2222, "busy": True, "extra": []}),
    (b"Z1_ABCDEF,10.0.0.23,2222,0,somethingnew\n", {"machine": "Z1_ABCDEF", "ip": "10.0.0.23", "port": 2222, "busy": False, "extra": ["somethingnew"]}),
    (b"tooshort,1.2.3.4,2222", None),
    (b"bad,1.2.3.4,notaport,0", None),
    (b"\xff\xfe\x00", None),
]


def self_test() -> int:
    failures = 0
    for raw, expected in SELF_TEST_CASES:
        got = parse_record(raw)
        ok = got == expected
        failures += 0 if ok else 1
        print(f"{'OK  ' if ok else 'FAIL'} {raw!r}\n       -> {got}")
    if failures:
        print(f"\n{failures} case(s) failed")
        return 1
    print("\nparser ok")
    print(f"note: connect to {{ip}}:{{port}} over TCP (default {TCP_PORT}) after discovery")
    return 0


def listen(seconds: float) -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.settimeout(1.0)
    try:
        sock.bind(("0.0.0.0", UDP_PORT))
    except OSError as exc:
        print(f"bind :{UDP_PORT} failed: {exc}", file=sys.stderr)
        print("is the Makera/Community controller already running?", file=sys.stderr)
        return 1
    print(f"listening on 0.0.0.0:{UDP_PORT} for {seconds:.0f}s ...")
    seen = {}
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            data, addr = sock.recvfrom(BUFFER)
        except socket.timeout:
            continue
        rec = parse_record(data)
        print(f"from {addr[0]}: {data!r} -> {rec}")
        if rec and rec["machine"] not in seen:
            seen[rec["machine"]] = rec
    sock.close()
    print(f"\n{len(seen)} machine(s):")
    for name, rec in seen.items():
        print(f"  {name}  {rec['ip']}:{rec['port']}  busy={rec['busy']}")
    return 0 if seen else 2


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--listen", type=float, metavar="SECONDS")
    args = ap.parse_args()
    if args.listen is not None:
        return listen(args.listen)
    return self_test()


if __name__ == "__main__":
    raise SystemExit(main())
