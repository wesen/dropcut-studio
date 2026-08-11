---
Title: Hardware Control Web Page Design
Ticket: MZ1-002
Status: active
Topics:
    - cnc
    - cli
    - architecture
    - frontend
    - protocol
DocType: design
Intent: long-term
Owners: []
RelatedFiles:
    - Path: repo://dropcut-studio/apps/studio/src/styles.css
      Note: The Studio stylesheet these tokens were taken from
    - Path: repo://makera-z1-cli/cmd/z1ctl/cmds/serve.go
      Note: The serve command and graceful shutdown
    - Path: repo://makera-z1-cli/pkg/webui/static/app.css
      Note: Page styling; carries DROPCUT Studio's design tokens
    - Path: repo://makera-z1-cli/pkg/webui/webui.go
      Note: Server, single shared machine session, routes and JSON payloads
ExternalSources: []
Summary: 'Design and implementation record for the z1ctl hardware control page: a read-only machine telemetry surface served from the Go binary with go:embed, styled to match DROPCUT Studio, with motion controls deliberately disabled until the endstop mapping is confirmed.'
LastUpdated: 2026-08-11T18:30:00-04:00
WhatFor: Understanding why the control page is shaped the way it is before extending it, particularly before enabling motion.
WhenToUse: Before adding any control to the page, and before deciding how a future device-control UI relates to z1ctl.
---


# Hardware Control Web Page

Ticket MZ1-002 · 2026-08-11 · builds on MZ1-001

---

## 1. What this is

`z1ctl serve` starts an HTTP server that renders a single hardware control page
for a Makera Z1. It is a separate surface from DROPCUT Studio — Studio is the
CAM application, this is the machine pendant — but the two are styled from the
same design tokens so they read as one instrument rather than two applications.

```
z1ctl serve                                    # discovers the machine, serves :8080
z1ctl serve --addr :9090 --device 192.168.0.55
```

The page shows machine position, spindle and feed with overrides, tool and tool
length offset, job progress, the machine's file listing, preflight checks, and
the raw status report exactly as the machine sent it.

**Everything on this page is read-only.** Every endpoint is a `GET`; none of
them can move the machine, start a job, or write to the SD card.

---

## 2. Why a page at all, when there is a CLI

The CLI is complete for scripting. A page exists for three things the CLI is bad
at:

1. **Continuous observation.** Watching a job run means looking at a number that
   updates. `z1ctl watch --format jsonl` produces that data, but a terminal
   scrolling coordinates is not a readout.
2. **Being visible from across the shop.** A large amber DRO at 16px monospace
   is legible from further away than a table in a terminal.
3. **Being the substrate for the eventual device-control UI.** MZ1-001 §3.5.3
   established that a permissively licensed UI cannot link `pkg/makera` because
   `z1ctl` is GPL-2.0. This page is the GPL-side answer: it lives inside the
   same binary, so the licence question does not arise, and it proves the API
   shape that any external UI would consume over the process boundary.

---

## 3. Architecture

```
 ┌──────────────────────────────────────────────────────────────┐
 │ browser                                                      │
 │   index.html · app.css · app.js   (no build step, no deps)   │
 │        │ GET /api/status every 1s                            │
 │        │ GET /api/info, /api/files, /api/doctor on demand    │
 └────────┼─────────────────────────────────────────────────────┘
          ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ pkg/webui.Server         net/http.ServeMux                   │
 │   ┌────────────────────────────────────────────────────┐     │
 │   │ mu sync.Mutex  ── ONE machine session, serialised   │    │
 │   │ client *makera.Client                               │    │
 │   │ file listing cache (15s)                            │    │
 │   └────────────────────────────────────────────────────┘     │
 └────────┼─────────────────────────────────────────────────────┘
          ▼  single TCP connection, port 2222
     ┌──────────┐
     │ Makera Z1│
     └──────────┘
```

### 3.1 One session, serialised

The machine accepts exactly one TCP connection. That constraint propagates all
the way to the browser: if two tabs each opened their own machine session, the
second would fail.

`webui.Server` therefore holds a single `*makera.Client` behind a mutex and
serialises every request onto it. Several tabs share one connection instead of
competing for it. On any error the session is dropped so the next request
reconnects, which turns a transient network failure into a one-request outage
rather than a permanently dead page.

```go
func (s *Server) withClient(ctx context.Context, fn func(*makera.Client) error) error {
    s.mu.Lock()
    defer s.mu.Unlock()
    client, err := s.sessionLocked(ctx)   // dial on first use
    if err != nil {
        return err
    }
    if err := fn(client); err != nil {
        s.dropLocked()                    // force a reconnect next time
        return err
    }
    return nil
}
```

The consequence to document for users: **while `z1ctl serve` is running,
Makera's own controller cannot connect**, and vice versa. The `serve` command's
help says so.

### 3.2 Polling, not websockets

The page polls `/api/status` on a timer. A websocket would be the reflexive
choice and it would not help here.

The cost that matters is round trips *to the machine*, not to the server. Since
the server holds the single connection and serialises access, a push channel
would not reduce machine traffic — it would move the polling from the browser
into the server and add a connection lifecycle to maintain. The machine's own
reference controller polls at 200 ms; this page defaults to 1 s and offers 500
ms, 2 s and paused.

This is worth revisiting only when the page needs to observe something it cannot
poll for, such as unsolicited alarm messages arriving between status queries.

### 3.3 Caching what is slow

A directory listing is a multi-frame bulk transfer. Polling status every second
must not trigger one. Listings are cached for 15 seconds and the page marks
cached responses so the reading is honest rather than merely fast.

### 3.4 No build step

The page is one HTML file, one stylesheet and one script, embedded with
`go:embed` and served from `net/http.ServeMux`. There is no bundler, no
framework and no `node_modules`.

This deviates from the workspace's usual web guidance (bun, React, RTK Query,
Bootstrap), and the deviation is deliberate:

- The instruction was to **match the look of DROPCUT Studio**, which uses its
  own hand-written machine-shop stylesheet, not Bootstrap. Introducing Bootstrap
  here would actively work against that.
- The page is one screen with four panels and no client-side routing or state
  machine. React would add a build pipeline to a Go binary that currently has
  none, for a page whose entire state is one JSON object refreshed on a timer.
- A single binary with no build step is worth a great deal for a tool that will
  be run from a shop floor laptop.

If the page grows into a real application — multiple screens, job editing,
toolpath preview — that trade flips, and it should move into the studio monorepo
as a proper front end that talks to `z1ctl` over the process boundary.

### 3.5 Routes

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | The page |
| `/static/…` | GET | Embedded assets |
| `/api/status` | GET | One status report, plus the raw line |
| `/api/info` | GET | Model, firmware, accepted upload types, clock |
| `/api/files?dir=…` | GET | Directory listing, cached 15 s |
| `/api/doctor` | GET | Preflight checks |

Assets live under `/static/` rather than at the document root so an asset name
can never collide with an API route.

---

## 4. Visual design

The page reuses DROPCUT Studio's design tokens verbatim, copied from
`dropcut-studio/apps/studio/src/styles.css`:

| Token | Value | Role |
|---|---|---|
| `--bg` | `#0e1216` | page ground |
| `--panel` | `#151b21` | panel surfaces |
| `--panel2` | `#10151a` | inset surfaces, controls |
| `--line` | `#242e38` | hairline borders |
| `--text` | `#dee6ee` | primary text |
| `--dim` | `#77828e` | labels, secondary |
| `--amber` | `#ffb100` | DRO values, active accents |
| `--teal` | `#4fc8dd` | code, directories |
| `--green` / `--warn` / `--err` | | check severities |
| `--mono` | IBM Plex Mono stack | everything |

Conventions carried across from Studio: uppercase letter-spaced pane titles,
`.row` with a dim `.key` and a `.val`, tabs with an amber top border when
active, and `font-variant-numeric: tabular-nums` on every number so digits do
not jitter as they update.

### 4.1 The readout

The DRO shows work and machine coordinates side by side for all five axes.
Five, not three: real Z1 firmware reports X, Y, Z, A and B, which MZ1-001
established against hardware.

Work coordinates get the amber glow because they are what an operator reads
while setting up a job. Machine coordinates are dimmer and smaller — present for
reference, not for reading at a glance.

When the machine is unhomed it reports `-1` on all three linear axes. The page
says **"not homed — machine coordinates are not meaningful"** rather than
displaying `-1.000` as though it were a position. A readout that shows a
plausible-looking number for a machine with no reference is actively misleading.

### 4.2 Showing what is not known

The checks panel renders three severities: `ok`, `warn` and `unknown`. The third
exists because of a specific finding.

The cover interlock state lives in the diagnose report's `E:` vector. On real Z1
firmware that vector has eight elements where every published client maps six,
so the field order may be shifted rather than merely truncated. Reading index
five as "cover" could report a closed cover while it is open.

The page therefore reports `unknown` and states why. A preflight that shows
green for a check it did not actually perform is worse than one that shows
nothing, because it manufactures confidence.

---

## 5. Motion

The motion controls are rendered and disabled, with the reason stated in the
page:

> **Motion is disabled in this build.** The controls above are shown so the
> eventual layout is visible, but nothing is wired to the machine. Motion will
> be enabled only after the diagnose `E:` endstop mapping is confirmed on
> hardware — the cover-interlock bit cannot currently be located, and a
> preflight that cannot verify the cover is not a preflight.

Two reasons for showing disabled controls rather than omitting them:

1. The layout is a design decision that should be reviewable now, while it is
   cheap to change.
2. A user who expects jog controls and finds none will assume the page is
   broken. A user who finds them greyed out with an explanation learns something
   true about the state of the project.

### 5.1 What enabling motion requires

In order:

1. **Confirm the `E:` field mapping.** Poll `diagnose`, trigger one physical
   input at a time, and record which index changes. `MZ1-001/scripts/06-sensor-map.py`
   does this and needs an operator at the machine. Until this is done, no
   interlock can be trusted.
2. **Implement the authorised motion path in `pkg/makera`.** MZ1-001 ADR and
   `safety.go` specify it: a distinctly named entry point so every call site
   reads as a deliberate decision, never reachable from a retry or reconnect
   path, and never retrying — re-sending a `G0` after a timeout can execute the
   move twice.
3. **Server-side preflight per request.** State must be `Idle`, the cover
   closed, the emergency stop clear. The request is refused otherwise; the
   browser is not trusted to have checked.
4. **A confirmation gesture for the irreversible commands.** `$H` moves every
   axis at speed. `M3` starts the spindle. These are not click targets.
5. **Then, and only then**, enable the controls.

---

## 6. Relationship to the future device-control UI

MZ1-001 flagged that GPL copyleft reaches anything linking `pkg/makera`. That
constrains a future UI, and this page is one of the two available answers:

| Option | Licence position | Notes |
|---|---|---|
| **This page** (in-binary, GPL) | No question arises | Fastest path; no build step; limited by being one screen |
| **External UI over the process boundary** | UI may be permissive | Shells out to `z1ctl … --format json`, or talks to this server's `/api/…` routes |
| External UI linking the library | Must be GPL | Available if the UI is GPL |

The `/api/…` routes are deliberately shaped as a stable, documented surface so
the second option is available without new work. An external front end can
consume exactly what this page consumes.

---

## 7. Verification

Run against `Makera_Z1_012146` (firmware `1.0.15.0.1.11`) on 2026-08-11:

- `/api/status` returned live position, feed and spindle with the raw status
  line, including the undocumented `E:` and `OTA:` keys.
- `/api/files` parsed the `/sd/gcodes` listing, including directory marking and
  the one-versus-two-space separator inconsistency.
- `/api/doctor` returned six checks and correctly reported the cover interlock
  as `unknown`.
- The rendered page was checked in a browser at 1440×900; both the Files and
  Checks tabs render correctly and the DRO updates live.

No write was attempted and the machine did not move.

---

## 8. Open questions

1. Should the page offer a file **upload** once the framed transfer is
   implemented? It is the single most useful write operation and also the first
   one that can put a bad program on the machine.
2. Should job progress get its own panel with a progress bar, or stay a row?
   That depends on whether this page is used to *watch* jobs or only to set up
   for them.
3. Should the page surface the Z1 camera (ESP32 websocket on port 82, MZ1-001
   §9.7)? It is independent of the control connection, so it would not compete
   for the machine's single slot.
4. Does the 15-second listing cache want an explicit invalidate, or is the
   Reload button enough?

---

## 9. Files

| Path | Role |
|---|---|
| `makera-z1-cli/pkg/webui/webui.go` | Server, session sharing, routes, JSON payloads |
| `makera-z1-cli/pkg/webui/static/index.html` | Page structure |
| `makera-z1-cli/pkg/webui/static/app.css` | Styling; Studio tokens |
| `makera-z1-cli/pkg/webui/static/app.js` | Polling, rendering, tabs |
| `makera-z1-cli/pkg/webui/static/favicon.svg` | Amber crosshair |
| `makera-z1-cli/cmd/z1ctl/cmds/serve.go` | The `serve` command, graceful shutdown |
