// SPDX-License-Identifier: GPL-2.0-only

package cmds

import (
	"context"
	"os"
	"time"

	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
	"github.com/pkg/errors"

	"github.com/go-go-golems/makera-z1-cli/pkg/makera"
)

// ConnectionSlug is the section holding machine connection settings, mounted on
// every command that talks to a machine so the flags are declared once.
const ConnectionSlug = "connection"

// ConnectionSettings is the decoded connection section.
type ConnectionSettings struct {
	Device         string `glazed:"device"`
	Protocol       string `glazed:"protocol"`
	Timeout        string `glazed:"timeout"`
	ConnectTimeout string `glazed:"connect-timeout"`
	DiscoverFor    string `glazed:"discover-for"`
}

// NewConnectionSection builds the shared connection section.
func NewConnectionSection() (schema.Section, error) {
	return schema.NewSection(
		ConnectionSlug,
		"Machine connection",
		schema.WithFields(
			fields.New("device", fields.TypeString,
				fields.WithDefault(""),
				fields.WithHelp("Machine address host[:port]. Defaults to $Z1CTL_DEVICE, then to a discovery sweep")),
			fields.New("protocol", fields.TypeChoice,
				fields.WithChoices("auto", "makera", "smoothie"),
				fields.WithDefault("auto"),
				fields.WithHelp("Wire protocol. 'auto' probes the machine and costs about 300ms; 'makera' is the fast path for a known Z1")),
			fields.New("timeout", fields.TypeString,
				fields.WithDefault("15s"),
				fields.WithHelp("Per-command timeout")),
			fields.New("connect-timeout", fields.TypeString,
				fields.WithDefault("2s"),
				fields.WithHelp("TCP connect timeout")),
			fields.New("discover-for", fields.TypeString,
				fields.WithDefault("3s"),
				fields.WithHelp("How long to sweep for machines when --device is not given")),
		),
	)
}

// Resolve turns the settings into makera.Options, running discovery if needed.
//
// Resolution order: explicit flag, then $Z1CTL_DEVICE, then a discovery sweep
// that must find exactly one machine.
func (c ConnectionSettings) Resolve(ctx context.Context) (makera.Options, error) {
	opts := makera.DefaultOptions()
	opts.ProtocolName = c.Protocol

	var err error
	if opts.CommandTimeout, err = parseDuration(c.Timeout, 15*time.Second); err != nil {
		return opts, errors.Wrap(err, "--timeout")
	}
	if opts.ConnectTimeout, err = parseDuration(c.ConnectTimeout, 2*time.Second); err != nil {
		return opts, errors.Wrap(err, "--connect-timeout")
	}

	addr := c.Device
	if addr == "" {
		addr = os.Getenv("Z1CTL_DEVICE")
	}
	if addr == "" {
		sweep, err := parseDuration(c.DiscoverFor, 3*time.Second)
		if err != nil {
			return opts, errors.Wrap(err, "--discover-for")
		}
		m, err := makera.DiscoverOne(ctx, sweep)
		if err != nil {
			return opts, errors.Wrap(err, "no --device given and discovery did not resolve a single machine")
		}
		addr = m.Addr()
	}
	opts.Address = addr
	return opts, nil
}

// DecodeConnection pulls the connection section out of parsed values.
func DecodeConnection(vals *values.Values) (ConnectionSettings, error) {
	s := ConnectionSettings{}
	if err := vals.DecodeSectionInto(ConnectionSlug, &s); err != nil {
		return s, errors.Wrap(err, "decode connection settings")
	}
	return s, nil
}

// DialFrom resolves the connection settings and opens a session.
func DialFrom(ctx context.Context, vals *values.Values) (*makera.Client, error) {
	conn, err := DecodeConnection(vals)
	if err != nil {
		return nil, err
	}
	opts, err := conn.Resolve(ctx)
	if err != nil {
		return nil, err
	}
	client, err := makera.Dial(ctx, opts)
	if err != nil {
		return nil, errors.Wrap(err, "connect to machine")
	}
	return client, nil
}

func parseDuration(s string, def time.Duration) (time.Duration, error) {
	if s == "" {
		return def, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return def, err
	}
	return d, nil
}
