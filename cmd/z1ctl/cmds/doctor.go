// SPDX-License-Identifier: GPL-2.0-only

package cmds

import (
	"context"
	"fmt"

	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
	"github.com/go-go-golems/glazed/pkg/middlewares"
	"github.com/go-go-golems/glazed/pkg/types"

	"github.com/go-go-golems/makera-z1-cli/pkg/makera"
)

// DoctorCommand runs preflight checks and reports what it can and cannot verify.
type DoctorCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = &DoctorCommand{}

func NewDoctorCommand() (*DoctorCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &DoctorCommand{cmds.NewCommandDescription(
		"doctor",
		cmds.WithShort("Preflight checks: is the machine reachable and idle?"),
		cmds.WithLong(`Connect and report machine readiness, one row per check.

Read-only.

Each row carries a status of ok, warn or unknown. A check that cannot be
performed reports "unknown" rather than passing silently; a preflight command
that reports success for a check it did not run is worse than one that reports
nothing.

The cover interlock is currently reported as unknown. The cover state lives in
the diagnose report's endstop vector, which carries eight values on real Z1
firmware where published clients map six. The field order is unconfirmed, so
reading an index as "cover" could report a closed cover while it is open —
exactly the failure a safety interlock exists to prevent. Establish the mapping
empirically before relying on it.`),
		cmds.WithSections(conn),
	)}, nil
}

type check struct {
	name   string
	status string // ok | warn | unknown
	detail string
}

func (c *DoctorCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	conn, err := DecodeConnection(vals)
	if err != nil {
		return err
	}
	opts, err := conn.Resolve(ctx)
	if err != nil {
		return err
	}

	var checks []check
	emit := func() error {
		for _, ck := range checks {
			if err := gp.AddRow(ctx, types.NewRow(
				types.MRP("check", ck.name),
				types.MRP("status", ck.status),
				types.MRP("detail", ck.detail),
			)); err != nil {
				return err
			}
		}
		return nil
	}

	client, err := makera.Dial(ctx, opts)
	if err != nil {
		checks = append(checks, check{"connection", "warn", err.Error()})
		return emit()
	}
	defer func() { _ = client.Close() }()
	checks = append(checks, check{"connection", "ok", opts.Address})
	checks = append(checks, check{"protocol", "ok", client.Protocol()})

	info, err := client.Identify(ctx)
	if err != nil {
		checks = append(checks, check{"identity", "warn", err.Error()})
	} else {
		flavour := "stock firmware"
		if info.Community {
			flavour = "community firmware"
		}
		checks = append(checks, check{"firmware", "ok",
			fmt.Sprintf("%s %s (%s)", info.Model, info.Version, flavour)})

		if info.AcceptsCompressedUploads() {
			checks = append(checks, check{"upload types", "ok", info.FileTypes + " (compression available)"})
		} else {
			checks = append(checks, check{"upload types", "ok",
				info.FileTypes + " (no compressed uploads on this firmware)"})
		}
		if info.ClockEpoch < 1_000_000_000 {
			checks = append(checks, check{"machine clock", "warn",
				fmt.Sprintf("epoch %d — clock not set, so file timestamps are meaningless", info.ClockEpoch)})
		} else {
			checks = append(checks, check{"machine clock", "ok", fmt.Sprintf("epoch %d", info.ClockEpoch)})
		}
	}

	st, err := client.QueryStatus(ctx)
	if err != nil {
		checks = append(checks, check{"status", "warn", err.Error()})
		return emit()
	}
	switch {
	case st.State == "Idle":
		checks = append(checks, check{"machine state", "ok", st.State})
	case st.State == "Alarm":
		// H: is only present while the machine is halted, so a non-zero value
		// here is the reason it stopped.
		detail := "Alarm — motion is refused until the alarm is cleared"
		if reason, ok := st.Raw.At("H", 0); ok {
			detail = fmt.Sprintf("Alarm (halt reason %d) — motion is refused until cleared", int(reason))
		}
		checks = append(checks, check{"machine state", "warn", detail})
	default:
		checks = append(checks, check{"machine state", "warn",
			st.State + " — not idle, a job may be running"})
	}
	if st.Homed {
		checks = append(checks, check{"homed", "ok", "machine has a reference position"})
	} else {
		checks = append(checks, check{"homed", "warn",
			"axes report the unhomed sentinel (-1); machine coordinates are not meaningful"})
	}

	d, err := client.QueryDiagnose(ctx)
	if err != nil {
		checks = append(checks, check{"diagnose", "warn", err.Error()})
	} else {
		if d.EStop {
			checks = append(checks, check{"emergency stop", "warn", "engaged"})
		} else {
			checks = append(checks, check{"emergency stop", "ok", "clear"})
		}
		checks = append(checks, check{"wifi signal", "ok", fmt.Sprintf("%d dBm", d.RSSI)})

		if closed, known := d.CoverClosed(); !known {
			checks = append(checks, check{"cover", "unknown",
				fmt.Sprintf("machine sent %d endstop fields, fewer than the %d the mapping needs",
					len(d.Endstops), 6)})
		} else if closed {
			checks = append(checks, check{"cover", "ok", "closed"})
		} else {
			checks = append(checks, check{"cover", "warn", "OPEN — motion must not start"})
		}

		if d.ToolSetter {
			checks = append(checks, check{"tool setter", "warn", "triggered"})
		}
		for name, idx := range map[string]int{
			"endstop X min": makera.EndstopXMin, "endstop X max": makera.EndstopXMax,
			"endstop Y min": makera.EndstopYMin, "endstop Y max": makera.EndstopYMax,
			"endstop Z max": makera.EndstopZMax,
		} {
			if triggered, known := d.EndstopTriggered(idx); known && triggered {
				checks = append(checks, check{name, "warn", "triggered — axis is at a limit"})
			}
		}
	}

	if drops := client.Drops(); drops > 0 {
		checks = append(checks, check{"frame decoding", "warn",
			fmt.Sprintf("%d frames dropped for a bad length, footer or CRC", drops)})
	} else {
		checks = append(checks, check{"frame decoding", "ok", "no dropped frames"})
	}

	return emit()
}
