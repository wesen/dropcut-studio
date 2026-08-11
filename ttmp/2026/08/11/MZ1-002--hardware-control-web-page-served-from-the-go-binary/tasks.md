# Tasks

## Done

- [x] Design the page: one shared machine session, polling cadence, listing cache
- [x] `pkg/webui` server with `net/http.ServeMux` and `go:embed` assets
- [x] Routes: `/`, `/static/…`, `/api/status`, `/api/info`, `/api/files`, `/api/doctor`
- [x] Page styled from DROPCUT Studio's design tokens (machine-shop dark, amber DRO, tabular numerals)
- [x] Five-axis DRO with work and machine coordinates; unhomed state surfaced explicitly
- [x] Files, Checks, Machine and Raw tabs
- [x] Motion controls rendered but disabled, with the reason stated in the page
- [x] `z1ctl serve` command with graceful shutdown so the machine's connection slot is released
- [x] Verified against a real Z1; screenshots taken at 1440×900
- [x] Design doc

## TODO

- [ ] Decide whether job progress deserves its own panel with a progress bar
- [ ] Consider surfacing the Z1 camera (ESP32 websocket, port 82) — independent of the control connection
- [ ] Add file upload once the framed transfer lands in MZ1-001 phase 3
- [ ] Decide whether the listing cache needs explicit invalidation beyond the Reload button

## Blocked

- [ ] Enable motion controls. Requires, in order: (1) confirm the diagnose `E:` field mapping on hardware; (2) implement the authorised motion path in `pkg/makera`; (3) server-side preflight per request; (4) a confirmation gesture for `$H` and `M3`.
