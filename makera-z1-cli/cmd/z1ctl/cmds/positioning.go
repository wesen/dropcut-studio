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

// HomeCommand homes all axes.
type HomeCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = &HomeCommand{}

func NewHomeCommand() (*HomeCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &HomeCommand{cmds.NewCommandDescription(
		"home",
		cmds.WithShort("Home ALL axes (requires --confirm)"),
		cmds.WithLong(`Send $H, homing every axis.

This is the single most dangerous command in this tool: ALL axes move at
speed, and it is also the one an operator needs most often, because nothing
else works properly until the machine has a reference — an unhomed Z1 reports
-1,-1,-1 and every absolute move is refused.

Homing takes tens of seconds; the machine reports the Home state while it
runs. Single-axis homing ($H X) is deliberately not offered until its support
on this firmware is confirmed.

Preflight: no alarm, emergency stop clear, cover closed, no job running.

Examples:
  z1ctl home --dry-run
  z1ctl home --confirm`),
		cmds.WithFlags(motionFlagDefs()...),
		cmds.WithSections(conn),
	)}, nil
}

func (c *HomeCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	req := makera.MotionRequest{
		Ops:    []makera.MotionOp{makera.Home()},
		Reason: "operator homing from CLI",
	}
	f, err := decodeMotionFlags(vals)
	if err != nil {
		return err
	}
	if f.DryRun {
		return emitDryRun(ctx, gp, req)
	}
	if !f.Confirm {
		return errors.New("refusing: homing moves ALL axes at speed. Inspect with --dry-run, then re-run with --confirm, standing at the machine")
	}

	client, err := DialFrom(ctx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	res, err := client.Motion(ctx, req, makera.PreflightOptions{AllowOpenCover: f.AllowOpenCover})
	if err != nil {
		return err
	}

	// The firmware prints ok to $H unconditionally and the Home state appears
	// with a LAG — reading status once, immediately, misreported a real cycle
	// as a no-op on hardware (observations §12, corrected). Poll for the
	// state; re-reads only, nothing is ever re-sent.
	st := res.StateAfter
	cycleObserved := st.State == "Home"
	watchUntil := time.Now().Add(6 * time.Second)
	for !cycleObserved && time.Now().Before(watchUntil) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
		if st, err = client.QueryStatus(ctx); err != nil {
			return errors.Wrap(err, "lost the machine after sending $H")
		}
		cycleObserved = st.State == "Home"
	}

	// Watch an observed cycle to completion.
	deadline := time.Now().Add(3 * time.Minute)
	for st.State == "Home" {
		if time.Now().After(deadline) {
			return errors.New("homing still running after 3 minutes; check the machine")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(1 * time.Second):
		}
		if st, err = client.QueryStatus(ctx); err != nil {
			return errors.Wrap(err, "lost the machine while homing ran; the cycle continues on the machine")
		}
	}

	// A finished cycle parks at -1,-1,-1 — the SAME position an unhomed
	// machine reports, and stock firmware never says which it is. Report
	// what was actually observed and no more.
	note := "homing cycle observed and completed; machine parked at rest"
	if !cycleObserved {
		note = "no Home state was observed within 6s: either the cycle was faster than the poll, " +
			"or $H was silently consumed (seen once after a hold episode). If the machine did not move, run home again"
	}
	return gp.AddRow(ctx, types.NewRow(
		types.MRP("command", "$H"),
		types.MRP("cycle_observed", cycleObserved),
		types.MRP("state_after", st.State),
		types.MRP("mx", st.Machine.X),
		types.MRP("my", st.Machine.Y),
		types.MRP("mz", st.Machine.Z),
		types.MRP("note", note),
	))
}

// GotoCommand is an absolute rapid move.
type GotoCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = &GotoCommand{}

type gotoSettings struct {
	X       float64 `glazed:"x"`
	XSet    bool    `glazed:"x-set"`
	Y       float64 `glazed:"y"`
	YSet    bool    `glazed:"y-set"`
	Z       float64 `glazed:"z"`
	ZSet    bool    `glazed:"z-set"`
	A       float64 `glazed:"a"`
	ASet    bool    `glazed:"a-set"`
	Machine bool    `glazed:"machine"`
	SafeZ   bool    `glazed:"safe-z"`
}

func NewGotoCommand() (*GotoCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &GotoCommand{cmds.NewCommandDescription(
		"goto",
		cmds.WithShort("Absolute rapid move (requires --confirm)"),
		cmds.WithLong(`Rapid to an absolute position.

The coordinate system is an explicit choice, never a default:

  --machine        machine coordinates (G53) — mechanical moves: clearance,
                   approach to an anchor. Immune to work-offset mistakes.
  (default)        the active work coordinate system — moves about the part.

--safe-z retracts Z to the machine safe height (G53 Z-3, the machine's own
pack idiom) BEFORE any XY motion. Use it whenever the tool could be at
cutting depth: a tool moved in XY at depth ploughs through the workpiece.

Because a flag like --x 0 is indistinguishable from an unset flag, each axis
has an explicit presence flag; the shorthand is to pass both:

  z1ctl goto --x-set --x -100 --y-set --y -50 --machine --safe-z --confirm

Requires homing: absolute coordinates are meaningless without a reference.`),
		cmds.WithFlags(append(motionFlagDefs(),
			fields.New("x", fields.TypeFloat, fields.WithDefault(0.0), fields.WithHelp("X target")),
			fields.New("x-set", fields.TypeBool, fields.WithDefault(false), fields.WithHelp("Move X")),
			fields.New("y", fields.TypeFloat, fields.WithDefault(0.0), fields.WithHelp("Y target")),
			fields.New("y-set", fields.TypeBool, fields.WithDefault(false), fields.WithHelp("Move Y")),
			fields.New("z", fields.TypeFloat, fields.WithDefault(0.0), fields.WithHelp("Z target")),
			fields.New("z-set", fields.TypeBool, fields.WithDefault(false), fields.WithHelp("Move Z")),
			fields.New("a", fields.TypeFloat, fields.WithDefault(0.0), fields.WithHelp("A target")),
			fields.New("a-set", fields.TypeBool, fields.WithDefault(false), fields.WithHelp("Move A")),
			fields.New("machine", fields.TypeBool, fields.WithDefault(false),
				fields.WithHelp("Machine coordinates (G53) instead of the active work system")),
			fields.New("safe-z", fields.TypeBool, fields.WithDefault(false),
				fields.WithHelp("Retract Z to the machine safe height before any XY motion")),
		)...),
		cmds.WithSections(conn),
	)}, nil
}

func (c *GotoCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &gotoSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	target := makera.PartialAxes{
		X: makera.Coord{Value: s.X, Set: s.XSet},
		Y: makera.Coord{Value: s.Y, Set: s.YSet},
		Z: makera.Coord{Value: s.Z, Set: s.ZSet},
		A: makera.Coord{Value: s.A, Set: s.ASet},
	}
	op, err := makera.RapidTo(s.Machine, target, s.SafeZ)
	if err != nil {
		return err
	}
	return runMotionRequest(ctx, vals, gp, makera.MotionRequest{
		Ops:    []makera.MotionOp{op},
		Reason: "operator rapid move from CLI",
	})
}

// ParkCommand moves to the machine's pack position.
type ParkCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = &ParkCommand{}

func NewParkCommand() (*ParkCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &ParkCommand{cmds.NewCommandDescription(
		"park",
		cmds.WithShort("Retract Z, then move to the pack position (requires --confirm)"),
		cmds.WithLong(`Move to the machine's own pack position: safe Z first, then
G53 X-197 Y-206 — the exact idiom from the pack-position file on the
machine's SD card. Machine coordinates throughout, so a wrong work offset
cannot misdirect it. Requires homing.`),
		cmds.WithFlags(motionFlagDefs()...),
		cmds.WithSections(conn),
	)}, nil
}

func (c *ParkCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	return runMotionRequest(ctx, vals, gp, makera.MotionRequest{
		Ops:    []makera.MotionOp{makera.Park()},
		Reason: "operator park from CLI",
	})
}
