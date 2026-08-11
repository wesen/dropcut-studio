# Changelog

## 2026-08-11

- Created MZ1-002 for the hardware control web page, building on MZ1-001.
- Implemented `pkg/webui`: a read-only telemetry server using
  `net/http.ServeMux` with `go:embed` assets, holding a single machine session
  behind a mutex because the machine accepts only one TCP client. Several
  browser tabs share that connection rather than competing for it, and the
  session is dropped on error so the next request reconnects.
- Directory listings are cached for 15 seconds so a one-second status poll does
  not trigger a multi-frame bulk transfer per tick; cached responses are marked
  as such in the page.
- Page styled from DROPCUT Studio's design tokens verbatim so the two surfaces
  read as one instrument: machine-shop dark, IBM Plex Mono, tabular numerals,
  amber DRO with a glow, hairline borders, uppercase pane titles.
- Five-axis DRO showing work and machine coordinates. The unhomed sentinel
  (-1 on the linear axes) is surfaced as "not homed" rather than displayed as a
  position, because a plausible-looking number for a machine with no reference
  is actively misleading.
- Checks panel renders three severities including `unknown`, used for the cover
  interlock: the diagnose `E:` vector has eight elements on real firmware where
  published clients map six, so the cover bit cannot be located. A preflight
  that shows green for a check it did not perform is worse than one that shows
  nothing.
- Motion controls are rendered but disabled with the reason stated in the page,
  so the layout is reviewable now and a user does not mistake the omission for a
  bug.
- Deviated from the workspace's usual web guidance (bun/React/Bootstrap) with the
  reasoning recorded in the design doc: the instruction was to match Studio's
  hand-written stylesheet, and a single screen refreshed from one JSON object
  does not justify adding a build pipeline to a Go binary that has none.
- Verified against Makera_Z1_012146 (firmware 1.0.15.0.1.11): live DRO, file
  listing, and doctor checks correctly reporting the cover interlock as unknown.
  No write was attempted and the machine did not move.
