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

// Filesystem mutations.
//
// These change the machine's SD card. They cannot cause motion, so they are not
// behind the confirmation gate that motion requires — typing `rm` is the intent.
// What they can do is destroy data, which is why each verifies its effect
// afterwards rather than trusting a silent reply.

// RmCommand deletes a remote file.
type RmCommand struct{ *cmds.CommandDescription }

type rmSettings struct {
	Path string `glazed:"path"`
}

var _ cmds.GlazeCommand = &RmCommand{}

func NewRmCommand() (*RmCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &RmCommand{cmds.NewCommandDescription(
		"rm",
		cmds.WithShort("Delete a file on the machine"),
		cmds.WithLong(`Delete a file from the machine's SD card.

DESTRUCTIVE: there is no undo and no trash on the machine.

The path is checked before deleting and again afterwards, because the firmware
answers nothing on success — so "no reply" alone cannot distinguish a deletion
from a command that was ignored.

Examples:
  z1ctl fs rm /sd/gcodes/old.nc`),
		cmds.WithArguments(
			fields.New("path", fields.TypeString,
				fields.WithIsArgument(true),
				fields.WithHelp("Absolute path of the file to delete")),
		),
		cmds.WithSections(conn),
	)}, nil
}

func (c *RmCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &rmSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	if s.Path == "" {
		return errors.New("no path given")
	}
	client, err := DialFrom(ctx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	dir, base := splitPath(s.Path)
	existed, err := remoteExists(ctx, client, dir, base)
	if err != nil {
		return err
	}
	if !existed {
		return errors.Errorf("refusing: %s does not exist", s.Path)
	}

	reply, err := client.RemoveFile(ctx, s.Path)
	if err != nil {
		return err
	}

	stillThere, err := waitForRemote(ctx, client, dir, base, false)
	if err != nil {
		return err
	}
	if stillThere {
		return errors.Errorf("remove reported no error but %s is still present. Machine said: %q",
			s.Path, joinLines(reply))
	}

	return gp.AddRow(ctx, types.NewRow(
		types.MRP("path", s.Path),
		types.MRP("removed", true),
		types.MRP("reply", joinLines(reply)),
	))
}

// MvCommand renames or moves a remote file.
type MvCommand struct{ *cmds.CommandDescription }

type mvSettings struct {
	From  string `glazed:"from"`
	To    string `glazed:"to"`
	Force bool   `glazed:"force"`
}

var _ cmds.GlazeCommand = &MvCommand{}

func NewMvCommand() (*MvCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &MvCommand{cmds.NewCommandDescription(
		"mv",
		cmds.WithShort("Rename or move a file on the machine"),
		cmds.WithLong(`Rename or move a file on the machine's SD card.

The destination is checked first: the firmware is not consulted about
overwriting, so without --force this refuses rather than silently replacing an
existing file.

Examples:
  z1ctl fs mv /sd/gcodes/a.nc /sd/gcodes/b.nc`),
		cmds.WithArguments(
			fields.New("from", fields.TypeString,
				fields.WithIsArgument(true),
				fields.WithHelp("Existing path")),
			fields.New("to", fields.TypeString,
				fields.WithIsArgument(true),
				fields.WithHelp("New path")),
		),
		cmds.WithFlags(
			fields.New("force", fields.TypeBool,
				fields.WithDefault(false),
				fields.WithHelp("Proceed even if the destination already exists")),
		),
		cmds.WithSections(conn),
	)}, nil
}

func (c *MvCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &mvSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	if s.From == "" || s.To == "" {
		return errors.New("both a source and a destination are required")
	}
	client, err := DialFrom(ctx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	fromDir, fromBase := splitPath(s.From)
	toDir, toBase := splitPath(s.To)

	exists, err := remoteExists(ctx, client, fromDir, fromBase)
	if err != nil {
		return err
	}
	if !exists {
		return errors.Errorf("refusing: %s does not exist", s.From)
	}
	if !s.Force {
		clash, err := remoteExists(ctx, client, toDir, toBase)
		if err != nil {
			return err
		}
		if clash {
			return errors.Errorf("refusing: %s already exists; pass --force to overwrite", s.To)
		}
	}

	reply, err := client.MoveFile(ctx, s.From, s.To)
	if err != nil {
		return err
	}

	arrived, err := waitForRemote(ctx, client, toDir, toBase, true)
	if err != nil {
		return err
	}
	if !arrived {
		return errors.Errorf("move reported no error but %s is not present. Machine said: %q",
			s.To, joinLines(reply))
	}

	return gp.AddRow(ctx, types.NewRow(
		types.MRP("from", s.From),
		types.MRP("to", s.To),
		types.MRP("moved", true),
		types.MRP("reply", joinLines(reply)),
	))
}

// MkdirCommand creates a remote directory.
type MkdirCommand struct{ *cmds.CommandDescription }

type mkdirSettings struct {
	Path string `glazed:"path"`
}

var _ cmds.GlazeCommand = &MkdirCommand{}

func NewMkdirCommand() (*MkdirCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &MkdirCommand{cmds.NewCommandDescription(
		"mkdir",
		cmds.WithShort("Create a directory on the machine"),
		cmds.WithLong(`Create a directory on the machine's SD card.

Note that 'mkdir' is not listed by the firmware's own 'help' on Z1 firmware
1.0.15.0.1.11. That is not evidence it is missing — 'help' is a lower bound on
the command surface, and 'model', 'ftype', 'time' and 'echo' are all unlisted
and all work. This command verifies the directory afterwards rather than
assuming.

Examples:
  z1ctl fs mkdir /sd/gcodes/projects`),
		cmds.WithArguments(
			fields.New("path", fields.TypeString,
				fields.WithIsArgument(true),
				fields.WithHelp("Absolute path of the directory to create")),
		),
		cmds.WithSections(conn),
	)}, nil
}

func (c *MkdirCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &mkdirSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	if s.Path == "" {
		return errors.New("no path given")
	}
	client, err := DialFrom(ctx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	parent, base := splitPath(s.Path)
	reply, err := client.MakeDir(ctx, s.Path)
	if err != nil {
		return err
	}

	created, err := waitForRemote(ctx, client, parent, base, true)
	if err != nil {
		return err
	}
	if !created {
		return errors.Errorf(
			"mkdir reported no error but %s is not present — this firmware may not support mkdir. Machine said: %q",
			s.Path, joinLines(reply))
	}

	return gp.AddRow(ctx, types.NewRow(
		types.MRP("path", s.Path),
		types.MRP("created", true),
		types.MRP("reply", joinLines(reply)),
	))
}

// fsSettleTimeout bounds how long a filesystem change may take to become
// visible in a directory listing.
//
// This is not paranoia: a directory created with mkdir is genuinely absent from
// the very next `ls` and appears shortly after. Verifying immediately reports a
// spurious failure for an operation that worked.
const (
	fsSettleTimeout  = 3 * time.Second
	fsSettleInterval = 400 * time.Millisecond
)

// waitForRemote polls a directory listing until base's presence matches want,
// or the settle timeout expires. Returns the final observed presence.
func waitForRemote(ctx context.Context, client *makera.Client, dir, base string, want bool) (bool, error) {
	deadline := time.Now().Add(fsSettleTimeout)
	for {
		got, err := remoteExists(ctx, client, dir, base)
		if err != nil {
			return false, err
		}
		if got == want || time.Now().After(deadline) {
			return got, nil
		}
		select {
		case <-ctx.Done():
			return got, ctx.Err()
		case <-time.After(fsSettleInterval):
		}
	}
}

// remoteExists reports whether base is present in dir.
func remoteExists(ctx context.Context, client *makera.Client, dir, base string) (bool, error) {
	entries, err := client.ListDir(ctx, dir)
	if err != nil {
		return false, err
	}
	for _, e := range entries {
		if e.Name == base {
			return true, nil
		}
	}
	return false, nil
}

func joinLines(lines []string) string {
	out := ""
	for i, l := range lines {
		if i > 0 {
			out += "; "
		}
		out += l
	}
	return out
}
