package cmds

import (
	"github.com/go-go-golems/glazed/pkg/cli"
	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	cmd_sources "github.com/go-go-golems/glazed/pkg/cmds/sources"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
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
			MiddlewaresFunc:   z1ctlMiddlewares,
		}),
	}
}

// z1ctlMiddlewares is the default Cobra chain plus environment loading,
// deliberately WHITELISTED to the connection section: Z1CTL_DEVICE,
// Z1CTL_PROTOCOL, Z1CTL_TIMEOUT and friends work from the environment, and
// nothing else does. In particular Z1CTL_CONFIRM must never exist —
// authorising motion from an inherited shell variable would defeat the
// per-invocation confirmation that --confirm is for.
func z1ctlMiddlewares(_ *values.Values, cmd *cobra.Command, args []string) ([]cmd_sources.Middleware, error) {
	return []cmd_sources.Middleware{
		cmd_sources.FromCobra(cmd, fields.WithSource("cobra")),
		cmd_sources.FromArgs(args, fields.WithSource("arguments")),
		cmd_sources.WrapWithWhitelistedSections([]string{ConnectionSlug},
			cmd_sources.FromEnv("Z1CTL", fields.WithSource("env")),
		),
		cmd_sources.FromDefaults(fields.WithSource(fields.SourceDefaults)),
	}, nil
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

	motion, err := NewMotionCommands()
	if err != nil {
		return errors.Wrap(err, "build motion commands")
	}

	top := append([]cmds.Command{discover, status, watch, exec, info, doctor, serve, unlock}, motion...)
	if err := cli.AddCommandsToRootCommand(root, top, nil, parserOptions()...); err != nil {
		return errors.Wrap(err, "register top-level commands")
	}

	jobGroup, err := NewJobGroup()
	if err != nil {
		return errors.Wrap(err, "build job group")
	}
	root.AddCommand(jobGroup)

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

	cameraGroup, err := NewCameraGroup()
	if err != nil {
		return errors.Wrap(err, "build camera group")
	}
	root.AddCommand(cameraGroup)

	return nil
}
