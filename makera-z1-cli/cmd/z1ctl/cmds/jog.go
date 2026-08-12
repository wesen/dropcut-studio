package cmds

import (
	"context"
	"strconv"
	"strings"
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

// JogCommand moves one axis by hand.
type JogCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = &JogCommand{}

type jogSettings struct {
	Axis       string  `glazed:"axis"`
	Distance   string  `glazed:"distance"`
	SpeedScale float64 `glazed:"speed-scale"`
	Feed       float64 `glazed:"feed"`
	Continuous bool    `glazed:"continuous"`
	For        string  `glazed:"for"`
}

func NewJogCommand() (*JogCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &JogCommand{cmds.NewCommandDescription(
		"jog",
		cmds.WithShort("Jog one axis (requires --confirm)"),
		cmds.WithLong(`Move one axis by hand.

Step jog sends one bounded relative move and is the form to use from the
command line:

  z1ctl jog X 10 --confirm                    10 mm in +X at full speed
  z1ctl jog Z-0.1 --speed-scale 0.1 --confirm 0.1 mm in -Z at 10% of max

Two speed units exist because two firmware dialects exist (measured on
hardware, confirmed in both firmware sources — see pkg/makera/motion.go):

  --speed-scale 0..1   fraction of the axis maximum. Works on BOTH dialects:
                       stock $J reads F as a scale of max_rate; community
                       takes the same fraction as an S word.
  --feed <mm/min>      absolute feedrate. COMMUNITY firmware only — stock
                       cannot express it and this tool refuses rather than
                       silently jogging at maximum (which is exactly what the
                       official controller does wrong against stock).

The firmware dialect is detected from the version string before any
speed-carrying jog is sent.

Negative distances: a bare "-0.1" is read as flags by the argument parser, so
write the axis and distance as ONE token ($J style), or end flag parsing with
"--":

  z1ctl jog X-0.1 --confirm
  z1ctl jog --confirm -- X -0.1

Continuous jog moves while THIS PROCESS emits keepalives and stops when they
cease — the firmware's own dead-man. From a CLI the hold is expressed as a
bounded duration; the web page's press-and-hold is the better tool for real
positioning work:

  z1ctl jog X + --continuous --for 500ms --confirm

Jogging is relative motion and is permitted on an unhomed machine — it is how
an operator repositions one. Use --dry-run to see the exact bytes first.

The machine's physical emergency stop is the real stop. This tool refuses when
the cover is open (--allow-open-cover waives it for setup work), when the
machine is in Alarm, or while a job is running.`),
		cmds.WithArguments(
			fields.New("axis", fields.TypeString,
				fields.WithIsArgument(true),
				fields.WithHelp("Axis (X, Y, Z, A, B) or a combined token like X-0.1")),
			fields.New("distance", fields.TypeString,
				fields.WithIsArgument(true),
				fields.WithDefault(""),
				fields.WithHelp("Signed distance in mm; with --continuous, a bare + or - direction. May be combined into the axis token")),
		),
		cmds.WithFlags(append(motionFlagDefs(),
			fields.New("speed-scale", fields.TypeFloat,
				fields.WithDefault(0.0),
				fields.WithHelp("Jog speed as a fraction of the axis maximum, 0-1; 0 = maximum. Works on stock and community firmware")),
			fields.New("feed", fields.TypeFloat,
				fields.WithDefault(0.0),
				fields.WithHelp("Jog feedrate in mm/min. COMMUNITY firmware only; stock cannot express it and is refused")),
			fields.New("continuous", fields.TypeBool,
				fields.WithDefault(false),
				fields.WithHelp("Continuous jog held for --for, stopped by the 0x19/^Y handshake")),
			fields.New("for", fields.TypeString,
				fields.WithDefault("500ms"),
				fields.WithHelp("How long a continuous jog is held (bounded; max 5s)")),
		)...),
		cmds.WithSections(conn),
	)}, nil
}

func (c *JogCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &jogSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	// Accept the combined $J-style token — `jog X-0.1` — because a separate
	// "-0.1" argument is swallowed by flag parsing before it ever reaches us.
	axisTok, distTok := s.Axis, s.Distance
	if distTok == "" {
		if len(axisTok) < 2 {
			return errors.Errorf("missing distance: use `jog %s 10`, the combined form `jog %s-0.1`, or `--` before a negative distance", axisTok, axisTok)
		}
		axisTok, distTok = axisTok[:1], axisTok[1:]
	}
	axis, err := makera.ParseAxis(axisTok)
	if err != nil {
		return err
	}
	s.Distance = distTok

	if !s.Continuous {
		dist, err := strconv.ParseFloat(s.Distance, 64)
		if err != nil {
			return errors.Errorf("distance %q is not a number (use --continuous for a held jog)", s.Distance)
		}
		op, err := makera.StepJog(axis, dist, makera.JogSpeed{Scale: s.SpeedScale, FeedMMMin: s.Feed})
		if err != nil {
			return err
		}
		return runMotionRequest(ctx, vals, gp, makera.MotionRequest{
			Ops:    []makera.MotionOp{op},
			Reason: "operator step jog from CLI",
		})
	}
	return c.runContinuous(ctx, vals, gp, axis, s)
}

func (c *JogCommand) runContinuous(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
	axis makera.Axis, s *jogSettings,
) error {
	positive := true
	switch strings.TrimSpace(s.Distance) {
	case "+", "+1", "1":
	case "-", "-1":
		positive = false
	default:
		return errors.Errorf("continuous jog takes a direction (+ or -), got %q", s.Distance)
	}
	hold, err := time.ParseDuration(s.For)
	if err != nil {
		return errors.Wrap(err, "--for")
	}
	if hold <= 0 || hold > 5*time.Second {
		return errors.Errorf("--for %s outside (0, 5s]: a CLI hold is deliberately bounded", hold)
	}

	f, err := decodeMotionFlags(vals)
	if err != nil {
		return err
	}
	op, err := makera.ContinuousJog(axis, positive, makera.JogSpeed{Scale: s.SpeedScale, FeedMMMin: s.Feed})
	if err != nil {
		return err
	}
	req := makera.MotionRequest{Ops: []makera.MotionOp{op}, Reason: "operator continuous jog from CLI"}
	if f.DryRun {
		return emitDryRun(ctx, gp, req)
	}
	if !f.Confirm {
		return errors.New("refusing: continuous jog is motion. Inspect with --dry-run, then re-run with --confirm")
	}

	client, err := DialFrom(ctx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	session, err := client.JogStart(ctx, axis, positive, makera.JogSpeed{Scale: s.SpeedScale, FeedMMMin: s.Feed},
		makera.PreflightOptions{AllowOpenCover: f.AllowOpenCover})
	if err != nil {
		return err
	}

	select {
	case <-ctx.Done():
	case <-time.After(hold):
	}
	stopErr := session.Stop(context.Background()) // stopping ignores a cancelled ctx

	st, statusErr := client.QueryStatus(ctx)
	row := types.NewRow(
		types.MRP("op", op.Describe()),
		types.MRP("held_for", hold.String()),
		types.MRP("stop_acknowledged", stopErr == nil),
	)
	if statusErr == nil {
		row.Set("state_after", st.State)
	}
	if err := gp.AddRow(ctx, row); err != nil {
		return err
	}
	return stopErr
}
