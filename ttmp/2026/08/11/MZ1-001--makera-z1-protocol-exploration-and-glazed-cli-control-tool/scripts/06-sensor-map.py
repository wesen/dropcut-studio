#!/usr/bin/env python3
"""
Experiment 06 — differential sensor mapping.

Purpose: work out what each element of the diagnose `E:` vector means.

Stock Z1 firmware reports `E:` with EIGHT values where the community controller
maps only SIX (xMin, xMax, yMin, yMax, zMax, cover). The mapping may therefore be
shifted, not merely truncated — which matters because the planned `z1ctl doctor`
cover interlock reads the cover bit out of that vector. Reading the wrong index
would report "cover closed" while it is open.

Method: poll `diagnose` (and optionally the realtime `?` status) continuously and
print ONLY the fields that change. The operator then triggers one physical input
at a time — open the cover, press an endstop, touch the probe — and the index
that flips is that input. No motion is required and none is commanded: this
script sends `diagnose` and `?` and nothing else, both hard-enforced.

Usage:
    python3 scripts/06-sensor-map.py --host 192.168.0.55
    python3 scripts/06-sensor-map.py --host 192.168.0.55 --status   # also poll '?'
    python3 scripts/06-sensor-map.py --host 192.168.0.55 --keys E,I,P,A

Suggested operator sequence (announce each step out loud / in the log):
    1. baseline — touch nothing for 5 s
    2. open the cover, wait 2 s, close it
    3. press the probe / touch the tool-length sensor
    4. trigger each endstop by hand if reachable (X, Y, Z)
    5. press and release the E-stop
Ctrl-C prints a summary of every index that ever moved.
"""

import argparse
import importlib.util
import os
import signal
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))

# 05-probe.py starts with a digit, so it cannot be imported by name.
_spec = importlib.util.spec_from_file_location("probe05", os.path.join(HERE, "05-probe.py"))
probe05 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe05)

Probe = probe05.Probe
text_of = probe05.text_of


def parse_report(line: str, open_ch: str, close_ch: str):
    """Decode `<...>` or `{...}` into {key: [str, ...]}. Values kept as strings
    so a float/int change is visible exactly as the machine wrote it."""
    start, end = line.find(open_ch), line.rfind(close_ch)
    if start < 0 or end <= start:
        return None
    out = {}
    for i, chunk in enumerate(line[start + 1:end].split("|")):
        if ":" not in chunk:
            if i == 0:
                out["_state"] = [chunk]
            continue
        key, _, values = chunk.partition(":")
        out[key] = [v.strip() for v in values.split(",")]
    return out


def diff(old, new):
    """Yield (key, index, before, after) for every changed element."""
    for key, values in new.items():
        before = old.get(key)
        if before is None:
            yield (key, None, None, ",".join(values))
            continue
        if len(before) != len(values):
            yield (key, None, ",".join(before), ",".join(values))
            continue
        for i, (a, b) in enumerate(zip(before, values)):
            if a != b:
                yield (key, i, a, b)
    for key in old:
        if key not in new:
            yield (key, None, ",".join(old[key]), None)


# Fields that are expected to drift on their own (temperatures, signal strength,
# timers). Noisy by nature — muted by default so real transitions stand out.
NOISY = {
    ("S", 4), ("S", 5),   # spindle / board temperatures
    ("S", 1),             # spindle target
    ("RSSI", 0),          # wifi signal
    ("V", 1),             # analog, drifts between adjacent values on its own —
                          # observed changing during a "touch nothing" baseline
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, default=2222)
    ap.add_argument("--interval", type=float, default=0.4)
    ap.add_argument("--keys", default=None,
                    help="comma-separated keys to watch (default: all)")
    ap.add_argument("--status", action="store_true",
                    help="also poll the realtime '?' status report")
    ap.add_argument("--all-noise", action="store_true",
                    help="do not mute temperature/RSSI drift")
    args = ap.parse_args()
    watch = set(args.keys.split(",")) if args.keys else None

    # Line-buffer stdout. Without this, piping the output (or a terminal that
    # block-buffers) shows nothing while the operator is triggering inputs,
    # which defeats the entire point of a live differ.
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except AttributeError:
        pass

    p = Probe(args.host, args.port)
    print(f"connected to {args.host}:{args.port}")
    print("polling diagnose" + (" and status" if args.status else "")
          + f" every {args.interval}s — trigger ONE input at a time\n")

    prev_d = prev_s = None
    seen = {}          # (report, key, index) -> set of observed values
    t0 = time.time()
    stop = {"now": False}
    # Handle SIGTERM as well as SIGINT so `timeout 60 ...` still prints the
    # summary instead of dying silently mid-session.
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *a: stop.__setitem__("now", True))

    def handle(tag, report, prev, open_ch, close_ch):
        if report is None:
            return prev
        if prev is None:
            print(f"[baseline {tag}]")
            for k, v in report.items():
                print(f"    {k}: {','.join(v)}")
            print()
            return report
        for key, idx, before, after in diff(prev, report):
            if watch and key not in watch:
                continue
            if not args.all_noise and (key, idx) in NOISY:
                continue
            where = f"{key}[{idx}]" if idx is not None else key
            stamp = time.time() - t0
            print(f"  {stamp:7.2f}s  {tag}  {where:<10} {before} -> {after}"
                  f"      (now {key}:{','.join(report.get(key, []))})")
            seen.setdefault((tag, key, idx), set()).update(
                x for x in (before, after) if x is not None)
        return report

    try:
        while not stop["now"]:
            frames = p.command("diagnose", timeout=3.0)
            for line in text_of(frames):
                if "{" in line:
                    prev_d = handle("diag", parse_report(line, "{", "}"), prev_d, "{", "}")
            if args.status:
                for line in text_of(p.status(timeout=1.5)):
                    if "<" in line:
                        prev_s = handle("stat", parse_report(line, "<", ">"), prev_s, "<", ">")
            time.sleep(args.interval)
    finally:
        p.close()
        print("\ndisconnected")
        print(f"decoder drops: {p.dec.drops}")
        if seen:
            print("\n=== indices that moved during this session ===")
            for (tag, key, idx), values in sorted(seen.items(), key=lambda kv: str(kv[0])):
                where = f"{key}[{idx}]" if idx is not None else key
                print(f"  {tag}  {where:<10} observed values: {sorted(values)}")
            print("\nMatch each line against what you triggered, in order.")
        else:
            print("\nNothing changed. Did any input actually get triggered?")


if __name__ == "__main__":
    sys.exit(main())
