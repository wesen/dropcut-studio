package cmds

import (
	"context"
	"time"

	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
	"github.com/go-go-golems/glazed/pkg/middlewares"
	"github.com/go-go-golems/glazed/pkg/types"
	"github.com/pkg/errors"

	"github.com/go-go-golems/makera-z1-cli/pkg/makera"
)

// StatusRow flattens a status report into a Glazed row.
//
// Unknown report keys are emitted under a raw_ prefix rather than dropped, so a
// firmware that adds a field shows it in `--format json` before anyone writes a
// mapping for it.
func StatusRow(s makera.Status, wcs string) types.Row {
	row := types.NewRow(
		types.MRP("state", s.State),
		// -1,-1,-1 is both the boot position and the post-homing rest
		// position; stock firmware never reports homing (observations §12).
		types.MRP("at_rest", s.AtRestPosition),
		types.MRP("mx", s.Machine.X), types.MRP("my", s.Machine.Y),
		types.MRP("mz", s.Machine.Z), types.MRP("ma", s.Machine.A),
		types.MRP("mb", s.Machine.B),
		types.MRP("wx", s.Work.X), types.MRP("wy", s.Work.Y),
		types.MRP("wz", s.Work.Z), types.MRP("wa", s.Work.A),
		types.MRP("feed", s.Feed.Current),
		types.MRP("feed_target", s.Feed.Target),
		types.MRP("feed_ovr", s.Feed.Override),
		types.MRP("spindle", s.Spindle.Current),
		types.MRP("spindle_target", s.Spindle.Target),
		types.MRP("spindle_ovr", s.Spindle.Override),
		types.MRP("tool", s.Tool),
		types.MRP("tlo", s.ToolLengthOffset),
	)
	if wcs != "" {
		row.Set("wcs", wcs)
	}
	if s.Playing != nil {
		row.Set("playing", s.Playing.Active)
		row.Set("played_lines", s.Playing.Lines)
		row.Set("played_percent", s.Playing.Percent)
		row.Set("played_seconds", s.Playing.Seconds)
	} else {
		row.Set("playing", false)
	}
	for _, key := range []string{"E", "OTA", "C"} {
		if v, ok := s.Raw.Fields[key]; ok {
			row.Set("raw_"+key, v)
		}
	}
	return row
}

// StatusCommand queries one status report.
type StatusCommand struct{ *cmds.CommandDescription }

type statusSettings struct {
	Diagnose bool `glazed:"diagnose"`
	WCS      bool `glazed:"wcs"`
	Modal    bool `glazed:"modal"`
}

var _ cmds.GlazeCommand = &StatusCommand{}

func NewStatusCommand() (*StatusCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &StatusCommand{cmds.NewCommandDescription(
		"status",
		cmds.WithShort("Query one machine status report"),
		cmds.WithLong(`Connect, send the realtime '?' query, emit one row.

Read-only: this sends only the status query and, with the flags below, other
query commands. Nothing here can move the machine.

Stock Z1 firmware does not report the active work coordinate system in its
status report, so --wcs issues a separate 'get wcs' query to obtain it.

Examples:
  z1ctl status
  z1ctl status --format json
  z1ctl status --wcs --diagnose
  z1ctl status --output-fields state,mx,my,mz`),
		cmds.WithFlags(
			fields.New("diagnose", fields.TypeBool,
				fields.WithDefault(false),
				fields.WithHelp("Also send 'diagnose' and merge sensor fields")),
			fields.New("wcs", fields.TypeBool,
				fields.WithDefault(false),
				fields.WithHelp("Also send 'get wcs' to learn the active coordinate system")),
			fields.New("modal", fields.TypeBool,
				fields.WithDefault(false),
				fields.WithHelp("Also send 'get state' and include the modal G-code words")),
		),
		cmds.WithSections(conn),
	)}, nil
}

func (c *StatusCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &statusSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	client, err := DialFrom(ctx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	st, err := client.QueryStatus(ctx)
	if err != nil {
		return err
	}

	wcs := ""
	if s.WCS {
		lines, err := client.CommandText(ctx, "get wcs")
		if err != nil {
			return errors.Wrap(err, "get wcs")
		}
		wcs = makera.ParseWCS(lines).Current
	}

	row := StatusRow(st, wcs)

	if s.Diagnose {
		d, err := client.QueryDiagnose(ctx)
		if err != nil {
			return err
		}
		row.Set("estop", d.EStop)
		row.Set("rssi", d.RSSI)
		row.Set("endstops", d.Endstops)
		// The cover bit lives inside the endstop vector, whose field order is
		// unconfirmed on this firmware. Report that fact rather than guess.
		row.Set("endstop_mapping_known", d.EndstopMappingKnown())
	}
	if s.Modal {
		lines, err := client.CommandText(ctx, "get state")
		if err != nil {
			return errors.Wrap(err, "get state")
		}
		row.Set("modal", makera.ParseModalState(lines))
	}
	if drops := client.Drops(); drops > 0 {
		row.Set("decoder_drops", drops)
	}
	return gp.AddRow(ctx, row)
}

// WatchCommand streams status rows.
type WatchCommand struct{ *cmds.CommandDescription }

type watchSettings struct {
	Interval string `glazed:"interval"`
	For      string `glazed:"for"`
	Count    int    `glazed:"count"`
}

var _ cmds.GlazeCommand = &WatchCommand{}

func NewWatchCommand() (*WatchCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &WatchCommand{cmds.NewCommandDescription(
		"watch",
		cmds.WithShort("Stream status rows while holding the connection"),
		cmds.WithLong(`Poll the machine and emit one row per sample.

Read-only. The 200ms default matches what the reference controller uses.

--format jsonl is the useful mode here: each line is an independently
parseable object, so a downstream process can consume the stream as it runs.

Examples:
  z1ctl watch --format jsonl
  z1ctl watch --interval 500ms --for 30s
  z1ctl watch --count 10 --output-fields time,state,mz`),
		cmds.WithFlags(
			fields.New("interval", fields.TypeString,
				fields.WithDefault("200ms"),
				fields.WithHelp("Poll interval")),
			fields.New("for", fields.TypeString,
				fields.WithDefault(""),
				fields.WithHelp("Stop after this long (empty means run until interrupted)")),
			fields.New("count", fields.TypeInteger,
				fields.WithDefault(0),
				fields.WithHelp("Stop after this many samples (0 means unlimited)")),
		),
		cmds.WithSections(conn),
	)}, nil
}

func (c *WatchCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &watchSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	interval, err := parseDuration(s.Interval, 200*time.Millisecond)
	if err != nil {
		return errors.Wrap(err, "--interval")
	}

	runCtx := ctx
	if s.For != "" {
		limit, err := parseDuration(s.For, 0)
		if err != nil {
			return errors.Wrap(err, "--for")
		}
		var cancel context.CancelFunc
		runCtx, cancel = context.WithTimeout(ctx, limit)
		defer cancel()
	}

	client, err := DialFrom(runCtx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for n := 0; s.Count == 0 || n < s.Count; n++ {
		st, err := client.QueryStatus(runCtx)
		if err != nil {
			// A deadline or interrupt is how this command normally ends.
			if runCtx.Err() != nil {
				return nil
			}
			return err
		}
		row := StatusRow(st, "")
		row.Set("time", time.Now().Format(time.RFC3339Nano))
		if err := gp.AddRow(runCtx, row); err != nil {
			return err
		}
		select {
		case <-runCtx.Done():
			return nil
		case <-ticker.C:
		}
	}
	return nil
}
