// SPDX-License-Identifier: GPL-2.0-only

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

// DiscoverCommand lists machines announcing themselves on the LAN.
type DiscoverCommand struct{ *cmds.CommandDescription }

type discoverSettings struct {
	For string `glazed:"for"`
}

var _ cmds.GlazeCommand = &DiscoverCommand{}

func NewDiscoverCommand() (*DiscoverCommand, error) {
	return &DiscoverCommand{cmds.NewCommandDescription(
		"discover",
		cmds.WithShort("Find machines announcing themselves on the network"),
		cmds.WithLong(`Listen for machine announcements on UDP 3333.

Discovery is passive: nothing is sent to the machine, so this cannot affect a
running job and does not take the machine's single connection slot. Machines
broadcast roughly every 1.5 seconds.

The announcement carries a run state ("Idle", "Run", ...) that published
clients discard. Because the machine accepts only one client at a time, this is
the only way to see what a machine is doing without disconnecting whoever is
using it.

Binding UDP 3333 fails if Makera's own controller is already running.

Examples:
  z1ctl discover
  z1ctl discover --for 10s --format json`),
		cmds.WithFlags(
			fields.New("for", fields.TypeString,
				fields.WithDefault("3s"),
				fields.WithHelp("How long to listen")),
		),
	)}, nil
}

func (c *DiscoverCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &discoverSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	d, err := parseDuration(s.For, 3*time.Second)
	if err != nil {
		return errors.Wrap(err, "--for")
	}

	machines, err := makera.Discover(ctx, d)
	if err != nil {
		return err
	}
	for _, m := range machines {
		row := types.NewRow(
			types.MRP("name", m.Name),
			types.MRP("ip", m.IP),
			types.MRP("port", m.Port),
			types.MRP("busy", m.Busy),
			types.MRP("state", m.State),
			types.MRP("address", m.Addr()),
		)
		if len(m.Extra) > 0 {
			row.Set("extra", m.Extra)
		}
		if err := gp.AddRow(ctx, row); err != nil {
			return err
		}
	}
	return nil
}
