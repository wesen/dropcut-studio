// SPDX-License-Identifier: GPL-2.0-only

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

// LsCommand lists a directory on the machine's SD card.
type LsCommand struct{ *cmds.CommandDescription }

type lsSettings struct {
	Path string `glazed:"path"`
}

var _ cmds.GlazeCommand = &LsCommand{}

func NewLsCommand() (*LsCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &LsCommand{cmds.NewCommandDescription(
		"ls",
		cmds.WithShort("List a directory on the machine"),
		cmds.WithLong(`List files and directories on the machine's SD card.

Read-only.

Directories are identified only by a trailing slash and a size of zero; the
firmware sends no type column. Timestamps are local time in YYYYMMDDHHMMSS
form, and are meaningful only if the machine's clock has been set — see
'z1ctl info'.

Examples:
  z1ctl fs ls
  z1ctl fs ls /sd
  z1ctl fs ls /sd/gcodes --format json`),
		cmds.WithArguments(
			fields.New("path", fields.TypeString,
				fields.WithIsArgument(true),
				fields.WithDefault("/sd/gcodes"),
				fields.WithHelp("Directory to list")),
		),
		cmds.WithSections(conn),
	)}, nil
}

func (c *LsCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &lsSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	client, err := DialFrom(ctx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	entries, err := listDir(ctx, client, s.Path)
	if err != nil {
		return err
	}
	for _, e := range entries {
		row := types.NewRow(
			types.MRP("name", e.Name),
			types.MRP("is_dir", e.IsDir),
			types.MRP("size", e.Size),
			types.MRP("modified", e.RawTime),
		)
		if !e.ModTime.IsZero() {
			row.Set("modified_iso", e.ModTime.Format("2006-01-02T15:04:05"))
		}
		if err := gp.AddRow(ctx, row); err != nil {
			return err
		}
	}
	return nil
}

func listDir(ctx context.Context, client *makera.Client, path string) ([]makera.DirEntry, error) {
	// The path is escaped, then the realtime characters across the whole line.
	cmd := makera.EscapeLine("ls -e -s " + makera.EscapePath(path))
	lines, err := client.CommandText(ctx, cmd)
	if err != nil {
		return nil, errors.Wrapf(err, "list %s", path)
	}
	return makera.ParseListing(lines), nil
}

// StatCommand reports metadata for one remote file.
type StatCommand struct{ *cmds.CommandDescription }

type statSettings struct {
	Path string `glazed:"path"`
}

var _ cmds.GlazeCommand = &StatCommand{}

func NewStatCommand() (*StatCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &StatCommand{cmds.NewCommandDescription(
		"stat",
		cmds.WithShort("Report size, timestamp and checksum for a remote file"),
		cmds.WithLong(`Combine a directory listing with a checksum query for one file.

Read-only.

The md5 field is only populated when the machine returns a genuine 32-character
hexadecimal digest. Some Z1 firmware answers with a fixed 32-character
placeholder that is not a digest, so a length check alone would accept it; when
that happens md5_valid is false and the digest is withheld rather than reported
as if it were real.`),
		cmds.WithArguments(
			fields.New("path", fields.TypeString,
				fields.WithIsArgument(true),
				fields.WithHelp("Absolute path of the file")),
		),
		cmds.WithSections(conn),
	)}, nil
}

func (c *StatCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &statSettings{}
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
	row := types.NewRow(
		types.MRP("path", s.Path),
		types.MRP("name", base),
	)

	entries, err := listDir(ctx, client, dir)
	if err != nil {
		return err
	}
	found := false
	for _, e := range entries {
		if e.Name == base {
			row.Set("size", e.Size)
			row.Set("is_dir", e.IsDir)
			row.Set("modified", e.RawTime)
			found = true
			break
		}
	}
	row.Set("exists", found)

	cmd := makera.EscapeLine("md5sum " + makera.EscapePath(s.Path) + " -e")
	lines, err := client.CommandText(ctx, cmd)
	if err != nil {
		return err
	}
	valid := false
	for _, l := range lines {
		if digest, _, ok := makera.ParseMD5(l); ok {
			row.Set("md5", digest)
			valid = true
			break
		}
	}
	row.Set("md5_valid", valid)
	return gp.AddRow(ctx, row)
}

func splitPath(p string) (dir, base string) {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' {
			return p[:i], p[i+1:]
		}
	}
	return "/sd", p
}

// NewFsGroup builds the `fs` command group.
func NewFsGroup() (*cobra.Command, error) {
	group := &cobra.Command{
		Use:   "fs",
		Short: "Inspect the machine's filesystem",
		Long: `Read-only filesystem access.

Writing to the machine's SD card requires the framed file-transfer protocol,
which is not implemented yet. Note also that the firmware's 'cat' command
returns "File not found" for every file, including ones it has just listed, so
reading file contents will also require the transfer path.`,
	}
	ls, err := NewLsCommand()
	if err != nil {
		return nil, err
	}
	stat, err := NewStatCommand()
	if err != nil {
		return nil, err
	}
	if err := cli.AddCommandsToRootCommand(group,
		[]cmds.Command{ls, stat}, nil, parserOptions()...); err != nil {
		return nil, err
	}
	return group, nil
}
