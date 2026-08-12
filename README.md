# z1ctl

A command-line tool and Go library for controlling a Makera Z1 (and other
Carvera-family machines) over its native network protocol.

```
z1ctl discover                                # find machines on the LAN
z1ctl status --format json                    # one structured status row
z1ctl watch --interval 200ms                  # streaming status rows
z1ctl exec "version"                          # run a firmware shell command
z1ctl fs ls /sd/gcodes                        # list machine files as rows
z1ctl doctor                                  # preflight checks
z1ctl proto encode --type 0xA2 version        # inspect the wire format
z1ctl serve                                   # hardware control web page
```

Every read-oriented command is a Glazed command, so it accepts
`--format table|json|jsonl|csv|tsv|yaml`, `--output-fields` and
`--max-output-rows` without any per-command work. That is what makes the tool
scriptable and what lets the web interface consume machine state without
linking the library.

## The one thing to know about this machine

**The Z1 does not stream G-code.** You upload a `.nc` file to the machine's SD
card and send `play <path>`; the machine executes the job locally from its own
filesystem. The host is a supervisor, not a real-time feeder. A host crash
mid-job does not stop the job.

This is the opposite of GRBL/CNCjs and it makes the client much simpler: no
line-buffer accounting, no flow control, no real-time deadline on the host.

## Safety

A spindle at ten thousand RPM with a carbide cutter can destroy the workpiece,
the tool, and the operator's hand. The library enforces this rather than
trusting the caller to remember it:

- `Client.Command` **refuses** every verb that could move the machine, start or
  stop a job, or mutate its filesystem. The check runs before a byte reaches the
  socket. See `pkg/makera/safety.go` and its tests.
- The only realtime bytes permitted on unauthorised paths are the status query
  and the jog keepalive. Feed hold, cycle start and soft reset are refused.
- Motion is not implemented yet. When it is, it goes behind a distinctly named
  entry point so that every call site reads as a deliberate decision, and it
  will never retry — re-sending a `G0` after a timeout can execute the move
  twice.

## Status

Working and validated against a real machine (firmware `1.0.15.0.1.11`, zero
frame-decoder failures across five sessions):

- frame codec, protocol strategies, autodetection
- UDP discovery, TCP transport, session with deterministic command completion
- status / diagnose report parsing, directory listings, checksums, WCS queries
- endstop and cover interlock mapping, confirmed empirically
- alarm clearing (`z1ctl unlock`), the first authorised command
- framed **download** — verified on hardware over 1 block, 41 blocks, and the
  cache-hit path
- framed **upload**, and `fs rm|mv|mkdir` — a full create / upload / download /
  rename / delete cycle verified on hardware inside a scratch directory, with a
  byte-identical round trip

Not implemented:

- motion, job control
- the USB serial transport

## Documentation

- `docs/protocol.md` — the wire protocol specification this implementation
  follows: framing, CRC, packet types, detection, command surface, report
  grammars, file transfer.
- `docs/observations-z1-1.0.15.md` — ground truth captured from a real Z1,
  including roughly a dozen places where real firmware differs from what the
  published clients assume. **This outranks the specification wherever they
  disagree.**

## Building

```bash
go build ./...
go test ./...
go vet ./...
```

The module resolves `glazed` through the workspace `go.work` and a `replace`
directive pointing at the sibling checkout.

## Licence

**GPL-2.0.** The licence applies to every file in this directory tree. See
`LICENSE` for the full text and `NOTICE` for attribution to the projects this
protocol documentation was derived from.

Individual source files deliberately carry **no per-file licence header**. The
licence is stated here, in `LICENSE`, and in `NOTICE`; repeating it at the top of
every file adds noise without adding information. Contributors should not add
SPDX headers.

One consequence to keep in mind: `MakeraInc/CarveraController` is GPL-**3.0**,
which is incompatible with GPL-2.0-only, so no code from it may be incorporated.
It remains usable as a factual reference, which is all it has been used for.

Because this is GPL, anything that links `pkg/makera` is a derivative work and
must also be GPL. A permissively licensed or proprietary user interface should
therefore talk to `z1ctl` as a subprocess and read `--format json`, keeping the
boundary at the process rather than at the link step.
