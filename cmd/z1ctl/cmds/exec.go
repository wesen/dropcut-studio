// SPDX-License-Identifier: GPL-2.0-only

package cmds

import (
	"context"

	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
	"github.com/go-go-golems/glazed/pkg/middlewares"
	"github.com/go-go-golems/glazed/pkg/types"
	"github.com/pkg/errors"

	"github.com/go-go-golems/makera-z1-cli/pkg/makera"
)

// ExecCommand runs an arbitrary read-only firmware command.
type ExecCommand struct{ *cmds.CommandDescription }

type execSettings struct {
	Command []string `glazed:"command"`
}

var _ cmds.GlazeCommand = &ExecCommand{}

func NewExecCommand() (*ExecCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &ExecCommand{cmds.NewCommandDescription(
		"exec",
		cmds.WithShort("Run a read-only firmware command and print its reply"),
		cmds.WithLong(`Send a command to the machine and emit its output, one row per line.

This is the escape hatch for protocol exploration: anything the tool has not
modelled can still be sent.

Motion is refused. Commands that could move the machine, start or stop a job,
or mutate its filesystem are rejected before a byte reaches the socket. That
includes G-code and M-code, $H, $J, play, abort, reset, upload, download, rm,
mv, mkdir and the config-set family.

Useful read-only commands, several of which the firmware's own 'help' does not
list:

  version · model · ftype · time · diagnose · help · mem · net · pwd
  get pos · get wcs · get state · get status
  ls -e -s /sd/gcodes
  md5sum /sd/gcodes/part.nc -e
  progress

Examples:
  z1ctl exec version
  z1ctl exec "ls -e -s /sd/gcodes"
  z1ctl exec "get wcs" --format json`),
		cmds.WithArguments(
			fields.New("command", fields.TypeStringList,
				fields.WithIsArgument(true),
				fields.WithHelp("The command to run")),
		),
		cmds.WithSections(conn),
	)}, nil
}

func (c *ExecCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &execSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	cmd := joinArgs(s.Command)
	if cmd == "" {
		return errors.New("no command given")
	}
	// Fail before connecting, so a refused command does not take the machine's
	// single connection slot even briefly.
	if err := makera.AssertNotMotion(cmd); err != nil {
		return err
	}

	client, err := DialFrom(ctx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	lines, err := client.CommandText(ctx, cmd)
	if err != nil {
		return err
	}
	for i, line := range lines {
		if err := gp.AddRow(ctx, types.NewRow(
			types.MRP("n", i+1),
			types.MRP("line", makera.Unescape(line)),
		)); err != nil {
			return err
		}
	}
	return nil
}

// InfoCommand reports machine identity.
type InfoCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = &InfoCommand{}

func NewInfoCommand() (*InfoCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &InfoCommand{cmds.NewCommandDescription(
		"info",
		cmds.WithShort("Report machine identity and firmware capabilities"),
		cmds.WithLong(`Query version, model, accepted upload types and the machine clock.

Read-only.

Two fields are worth attention. accepts_compressed_uploads reflects the 'ftype'
reply: real Z1 firmware answers 'nc', meaning it accepts no compressed uploads
at all. clock_epoch is often near zero, because the machine has no battery-backed
clock and starts near the epoch after every power cycle — file timestamps are
meaningless until a controller sets it.`),
		cmds.WithSections(conn),
	)}, nil
}

func (c *InfoCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	client, err := DialFrom(ctx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	info, err := client.Identify(ctx)
	if err != nil {
		return err
	}
	return gp.AddRow(ctx, types.NewRow(
		types.MRP("model", info.Model),
		types.MRP("model_id", info.ModelID),
		types.MRP("func_setting", info.FuncSetting),
		types.MRP("state", info.State),
		types.MRP("version", info.Version),
		types.MRP("community_firmware", info.Community),
		types.MRP("file_types", info.FileTypes),
		types.MRP("accepts_compressed_uploads", info.AcceptsCompressedUploads()),
		types.MRP("clock_epoch", info.ClockEpoch),
		types.MRP("protocol", info.Protocol),
	))
}

func joinArgs(args []string) string {
	out := ""
	for i, a := range args {
		if i > 0 {
			out += " "
		}
		out += a
	}
	return out
}
