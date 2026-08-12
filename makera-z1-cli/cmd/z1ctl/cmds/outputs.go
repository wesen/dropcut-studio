package cmds

import (
	"context"

	"github.com/go-go-golems/glazed/pkg/cli"
	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
	"github.com/go-go-golems/glazed/pkg/middlewares"
	"github.com/go-go-golems/glazed/pkg/types"
	"github.com/pkg/errors"
	"github.com/spf13/cobra"

	"github.com/go-go-golems/makera-z1-cli/pkg/makera"
)

// Spindle and accessory commands. The spindle is Class 1 — it starts a cutter
// spinning whether or not the cover is closed. Accessories are Class 3 and
// need no confirmation; switching anything OFF is a stop and is never gated.

// SpindleCommand switches the spindle.
type SpindleCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = &SpindleCommand{}

type spindleSettings struct {
	State string `glazed:"state"`
	RPM   int    `glazed:"rpm"`
}

func NewSpindleCommand() (*SpindleCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &SpindleCommand{cmds.NewCommandDescription(
		"spindle",
		cmds.WithShort("Spindle on (requires --confirm) or off (never gated)"),
		cmds.WithLong(`Switch the spindle.

  z1ctl spindle on --rpm 12000 --confirm
  z1ctl spindle off

'on' is motion-class: M3 starts a carbide cutter at speed, so it preflights
(cover closed, no alarm, e-stop clear) and requires --confirm.

'off' is a stop. Stops are never gated: no confirmation, no preflight, works
in any machine state.`),
		cmds.WithArguments(
			fields.New("state", fields.TypeChoice,
				fields.WithChoices("on", "off"),
				fields.WithIsArgument(true),
				fields.WithHelp("on or off")),
		),
		cmds.WithFlags(append(motionFlagDefs(),
			fields.New("rpm", fields.TypeInteger,
				fields.WithDefault(10000),
				fields.WithHelp("Spindle speed for 'on', RPM")),
		)...),
		cmds.WithSections(conn),
	)}, nil
}

func (c *SpindleCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &spindleSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	var op makera.MotionOp
	if s.State == "on" {
		var err error
		if op, err = makera.SpindleOn(s.RPM); err != nil {
			return err
		}
	} else {
		op = makera.SpindleOff()
	}
	return runMotionRequest(ctx, vals, gp, makera.MotionRequest{
		Ops:    []makera.MotionOp{op},
		Reason: "operator spindle " + s.State + " from CLI",
	})
}

// AccessoryCommand toggles a Class 3 output.
type AccessoryCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = &AccessoryCommand{}

type accessorySettings struct {
	Name  string `glazed:"name"`
	State string `glazed:"state"`
	Power int    `glazed:"power"`
}

func NewAccessoryCommand() (*AccessoryCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &AccessoryCommand{cmds.NewCommandDescription(
		"accessory",
		cmds.WithShort("Toggle light, vacuum, fan, air or PWM (no confirmation)"),
		cmds.WithLong(`Switch one of the machine's outputs.

  z1ctl accessory light on
  z1ctl accessory vacuum on --power 80
  z1ctl accessory air off

Accessories are Class 3: they switch a real output that cannot cut anyone, so
they need no confirmation — the machine's own light and vacuum are things an
operator toggles constantly. Switching OFF is a stop and is never gated.
Free-text paths (z1ctl exec) still refuse these M-codes; this command is the
dedicated path.`),
		cmds.WithArguments(
			fields.New("name", fields.TypeChoice,
				fields.WithChoices("light", "vacuum", "fan", "air", "pwm", "probe-charger", "tool-sensor"),
				fields.WithIsArgument(true),
				fields.WithHelp("Which output")),
			fields.New("state", fields.TypeChoice,
				fields.WithChoices("on", "off"),
				fields.WithIsArgument(true),
				fields.WithHelp("on or off")),
		),
		cmds.WithFlags(append(motionFlagDefs(),
			fields.New("power", fields.TypeInteger,
				fields.WithDefault(0),
				fields.WithHelp("Power 1-100 for outputs that take it (vacuum, fan, pwm); 0 = firmware default")),
		)...),
		cmds.WithSections(conn),
	)}, nil
}

func (c *AccessoryCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &accessorySettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	op, err := makera.Accessory(makera.AccessoryName(s.Name), s.State == "on", s.Power)
	if err != nil {
		return err
	}
	return runMotionRequest(ctx, vals, gp, makera.MotionRequest{
		Ops:    []makera.MotionOp{op},
		Reason: "operator accessory toggle from CLI",
	})
}

// HoldCommand is the feed hold and its release. Engaging is Class 0 — no
// confirmation, no preflight, works in every machine state. Releasing is the
// realtime cycle start `~`, Class 2: it restarts whatever motion the hold
// froze AND executes every command that queued up behind it, so it takes
// --confirm.
type HoldCommand struct{ *cmds.CommandDescription }

var _ cmds.BareCommand = &HoldCommand{}

type holdSettings struct {
	Release bool `glazed:"release"`
	Confirm bool `glazed:"confirm"`
}

func NewHoldCommand() (*HoldCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &HoldCommand{cmds.NewCommandDescription(
		"hold",
		cmds.WithShort("Feed hold — pause motion NOW; --release to continue"),
		cmds.WithLong(`Send the realtime feed hold. Motion decelerates and pauses; the
machine reports Hold and its light blinks.

Engaging is never gated: no confirmation, no preflight, any state. A stop
that can be refused is not a stop.

Releasing is the realtime cycle start (~), and it is NOT a stop: it resumes
whatever motion the hold froze, and every command that was queued while held
executes immediately. Stand clear, then:

  z1ctl hold --release --confirm

Note the distinction from 'z1ctl job resume': that continues a job paused
with 'suspend'. A feed hold is released only by cycle start — sending
'resume' in Hold reports ok and does nothing.

The machine's PHYSICAL emergency stop is the real one. This is a convenience.`),
		cmds.WithFlags(
			fields.New("release", fields.TypeBool,
				fields.WithDefault(false),
				fields.WithHelp("Release the hold (cycle start). Held motion and queued commands run immediately")),
			fields.New("confirm", fields.TypeBool,
				fields.WithDefault(false),
				fields.WithHelp("Required with --release: it restarts motion")),
		),
		cmds.WithSections(conn),
	)}, nil
}

func (c *HoldCommand) Run(ctx context.Context, vals *values.Values) error {
	s := &holdSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return err
	}
	if s.Release && !s.Confirm {
		return errors.New("refusing: releasing a hold restarts the frozen motion and runs everything queued behind it. Stand clear, then re-run with --confirm")
	}
	client, err := DialFrom(ctx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()
	if s.Release {
		return client.CycleStart()
	}
	return client.FeedHold()
}

// PreflightCommand shows what a motion request would be allowed to do.
type PreflightCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = &PreflightCommand{}

type preflightSettings struct {
	RequireHomed bool `glazed:"require-homed"`
}

func NewPreflightCommand() (*PreflightCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &PreflightCommand{cmds.NewCommandDescription(
		"preflight",
		cmds.WithShort("Evaluate the motion preflight without moving anything"),
		cmds.WithLong(`Read the machine fresh and evaluate every motion preflight
condition, exactly as a motion command would immediately before acting.
Read-only. Shows each condition, whether it passed, and why.

  z1ctl preflight
  z1ctl preflight --require-homed     as an absolute move would evaluate it`),
		cmds.WithFlags(
			fields.New("require-homed", fields.TypeBool,
				fields.WithDefault(false),
				fields.WithHelp("Evaluate as an absolute move would (homing required)")),
		),
		cmds.WithSections(conn),
	)}, nil
}

func (c *PreflightCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &preflightSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	client, err := DialFrom(ctx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	rep, err := client.Preflight(ctx, makera.ClassMotion,
		makera.PreflightOptions{RequireHomed: s.RequireHomed})
	if err != nil {
		return err
	}
	for _, ch := range rep.Checks {
		if err := gp.AddRow(ctx, types.NewRow(
			types.MRP("check", ch.Name),
			types.MRP("ok", ch.OK),
			types.MRP("fatal", ch.Fatal),
			types.MRP("detail", ch.Detail),
		)); err != nil {
			return err
		}
	}
	return nil
}

// NewMotionCommands builds every motion-related top-level command.
func NewMotionCommands() ([]cmds.Command, error) {
	jog, err := NewJogCommand()
	if err != nil {
		return nil, err
	}
	home, err := NewHomeCommand()
	if err != nil {
		return nil, err
	}
	gotoCmd, err := NewGotoCommand()
	if err != nil {
		return nil, err
	}
	park, err := NewParkCommand()
	if err != nil {
		return nil, err
	}
	spindle, err := NewSpindleCommand()
	if err != nil {
		return nil, err
	}
	accessory, err := NewAccessoryCommand()
	if err != nil {
		return nil, err
	}
	hold, err := NewHoldCommand()
	if err != nil {
		return nil, err
	}
	preflight, err := NewPreflightCommand()
	if err != nil {
		return nil, err
	}
	return []cmds.Command{jog, home, gotoCmd, park, spindle, accessory, hold, preflight}, nil
}

// NewJobGroup mounts the job lifecycle under one parent.
func NewJobGroup() (*cobra.Command, error) {
	group := &cobra.Command{
		Use:   "job",
		Short: "Run and supervise stored programs",
		Long: `The machine executes programs from its SD card; the host supervises.

  play      start a stored file (motion class, --confirm)
  suspend   pause — never gated
  resume    continue — state-enabling, --confirm
  abort     end — never gated
  progress  one-shot progress query
  run       upload, verify, preflight, play, monitor to completion`,
	}
	sub, err := NewJobCommands()
	if err != nil {
		return nil, err
	}
	if err := cli.AddCommandsToRootCommand(group, sub, nil, parserOptions()...); err != nil {
		return nil, errors.Wrap(err, "register job commands")
	}
	return group, nil
}
