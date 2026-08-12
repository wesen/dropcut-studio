package cmds

import (
	"github.com/go-go-golems/glazed/pkg/cli"
	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	"github.com/pkg/errors"
	"github.com/spf13/cobra"
)

// parserOptions is the shared Cobra parser configuration. The default section
// is listed in short help so a command's own flags appear before the universal
// structured-output group.
func parserOptions() []cli.CobraOption {
	return []cli.CobraOption{
		cli.WithParserConfig(cli.CobraParserConfig{
			ShortHelpSections: []string{schema.DefaultSlug},
			MiddlewaresFunc:   cli.CobraCommandDefaultMiddlewares,
		}),
	}
}

// Register mounts every z1ctl command onto the root.
func Register(root *cobra.Command) error {
	discover, err := NewDiscoverCommand()
	if err != nil {
		return err
	}
	status, err := NewStatusCommand()
	if err != nil {
		return err
	}
	watch, err := NewWatchCommand()
	if err != nil {
		return err
	}
	exec, err := NewExecCommand()
	if err != nil {
		return err
	}
	info, err := NewInfoCommand()
	if err != nil {
		return err
	}
	doctor, err := NewDoctorCommand()
	if err != nil {
		return err
	}
	serve, err := NewServeCommand()
	if err != nil {
		return err
	}
	unlock, err := NewUnlockCommand()
	if err != nil {
		return err
	}

	if err := cli.AddCommandsToRootCommand(root,
		[]cmds.Command{discover, status, watch, exec, info, doctor, serve, unlock}, nil,
		parserOptions()...); err != nil {
		return errors.Wrap(err, "register top-level commands")
	}

	fsGroup, err := NewFsGroup()
	if err != nil {
		return errors.Wrap(err, "build fs group")
	}
	root.AddCommand(fsGroup)

	protoGroup, err := NewProtoGroup()
	if err != nil {
		return errors.Wrap(err, "build proto group")
	}
	root.AddCommand(protoGroup)

	return nil
}
