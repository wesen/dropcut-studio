// z1ctl — command-line control for Makera Z1 and Carvera-family CNC machines.
//
// Copyright (C) 2026 the z1ctl authors.
//
// This program is free software; you can redistribute it and/or modify it under
// the terms of the GNU General Public License version 2 as published by the
// Free Software Foundation. See the LICENSE file, and NOTICE for attribution to
// the projects this protocol documentation was derived from.
package main

import (
	"fmt"
	"os"

	"github.com/go-go-golems/glazed/pkg/cmds/logging"
	"github.com/go-go-golems/glazed/pkg/help"
	help_cmd "github.com/go-go-golems/glazed/pkg/help/cmd"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"github.com/spf13/cobra"

	"github.com/go-go-golems/makera-z1-cli/cmd/z1ctl/cmds"
)

var version = "dev"

func main() {
	root := &cobra.Command{
		Use:   "z1ctl",
		Short: "Control a Makera Z1 CNC machine",
		Long: `z1ctl talks to a Makera Z1 (and other Carvera-family machines) over its
native network protocol.

The machine does not stream G-code. Files are uploaded to its SD card and run
locally with the 'play' command, so this tool is a supervisor rather than a
real-time feeder.

Every read-oriented command emits structured rows, so --format json or jsonl
makes the output directly consumable by scripts and by the web interface.

SAFETY: commands that could move the machine, start or stop a job, or mutate its
filesystem are refused before a byte reaches the socket. Motion is not
implemented in this build.

Getting started:
  z1ctl discover                      find machines on the network (passive)
  z1ctl info                          firmware, model, capabilities
  z1ctl status --wcs --format json    one status report
  z1ctl doctor                        preflight checks
  z1ctl fs ls /sd/gcodes              list the machine's files
  z1ctl exec "help"                   run any read-only firmware command

The machine accepts exactly ONE connection at a time. If Makera's controller is
running, z1ctl cannot connect, and vice versa.

The wire protocol is documented in docs/protocol.md; hardware ground truth is in
docs/observations-z1-1.0.15.md.`,
		Version:       version,
		SilenceUsage:  true,
		SilenceErrors: true,
		PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
			return logging.InitLoggerFromCobra(cmd)
		},
	}

	// Structured output goes to stdout; logs must stay out of it or they
	// corrupt --format json for anything parsing our output.
	zerolog.SetGlobalLevel(zerolog.WarnLevel)
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr})
	if err := logging.AddLoggingSectionToRootCommand(root, "z1ctl"); err != nil {
		fmt.Fprintf(os.Stderr, "z1ctl: %v\n", err)
		os.Exit(1)
	}

	helpSystem := help.NewHelpSystem()
	help_cmd.SetupCobraRootCommand(helpSystem, root)

	if err := cmds.Register(root); err != nil {
		fmt.Fprintf(os.Stderr, "z1ctl: %v\n", err)
		os.Exit(1)
	}

	if err := root.Execute(); err != nil {
		fmt.Fprintf(os.Stderr, "z1ctl: %v\n", err)
		os.Exit(exitCodeFor(err))
	}
}

// exitCodeFor maps errors onto meaningful exit codes so scripts can gate on
// them: 1 usage or connection error, 2 machine refused the request.
func exitCodeFor(err error) int {
	msg := err.Error()
	switch {
	case containsAny(msg, "not authorised", "refusing"):
		return 2
	case containsAny(msg, "machine busy"):
		return 2
	default:
		return 1
	}
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if len(sub) > 0 && len(s) >= len(sub) && indexOf(s, sub) >= 0 {
			return true
		}
	}
	return false
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
