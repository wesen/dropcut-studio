// SPDX-License-Identifier: GPL-2.0-only

package cmds

import (
	"context"
	"encoding/hex"
	"strconv"
	"strings"

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

// EncodeCommand shows the frame the tool would send for a payload.
type EncodeCommand struct{ *cmds.CommandDescription }

type encodeSettings struct {
	Type    string   `glazed:"type"`
	Payload []string `glazed:"payload"`
}

var _ cmds.GlazeCommand = &EncodeCommand{}

func NewEncodeCommand() (*EncodeCommand, error) {
	return &EncodeCommand{cmds.NewCommandDescription(
		"encode",
		cmds.WithShort("Show the frame that would be sent for a payload"),
		cmds.WithLong(`Encode a payload into a Makera frame and print it as hex.

Offline: this connects to nothing.

The frame layout is header(0x8668) | length(2) | type(1) | payload | crc(2) |
footer(0x55AA), big-endian, where length covers the type byte, the payload and
the CRC — it is NOT the payload length. The CRC is CRC-16/CCITT with an initial
value of 0x0000, computed over length+type+payload.

Examples:
  z1ctl proto encode --type 0xA2 version
  z1ctl proto encode --type 0xA1 '?'`),
		cmds.WithFlags(
			fields.New("type", fields.TypeString,
				fields.WithDefault("0xA2"),
				fields.WithHelp("Packet type: 0xA1 realtime, 0xA2 command, 0xB0 file-start")),
		),
		cmds.WithArguments(
			fields.New("payload", fields.TypeStringList,
				fields.WithIsArgument(true),
				fields.WithHelp("Payload text")),
		),
	)}, nil
}

func (c *EncodeCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &encodeSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	ptype, err := parsePacketType(s.Type)
	if err != nil {
		return err
	}
	payload := joinArgs(s.Payload)

	proto := makera.NewMakeraProtocol()
	var frame []byte
	switch ptype {
	case makera.PTypeCtrlSingle:
		if payload == "" {
			return errors.New("realtime frames need a one-byte payload")
		}
		frame = proto.EncodeRealtime(payload[0])
	case makera.PTypeFileStart:
		frame = proto.EncodeFileCommand([]byte(payload))
	default:
		frame = proto.EncodeCommand([]byte(payload))
	}

	return gp.AddRow(ctx, types.NewRow(
		types.MRP("type", ptype.String()),
		types.MRP("type_hex", "0x"+strings.ToUpper(hex.EncodeToString([]byte{byte(ptype)}))),
		types.MRP("payload", payload),
		types.MRP("length_field", int(frame[2])<<8|int(frame[3])),
		types.MRP("total_bytes", len(frame)),
		types.MRP("hex", hex.EncodeToString(frame)),
		types.MRP("spaced", spacedHex(frame)),
	))
}

// DecodeCommand parses a captured frame.
type DecodeCommand struct{ *cmds.CommandDescription }

type decodeSettings struct {
	Hex []string `glazed:"hex"`
}

var _ cmds.GlazeCommand = &DecodeCommand{}

func NewDecodeCommand() (*DecodeCommand, error) {
	return &DecodeCommand{cmds.NewCommandDescription(
		"decode",
		cmds.WithShort("Decode captured frame bytes"),
		cmds.WithLong(`Parse hex bytes as Makera frames and emit one row per frame.

Offline. Whitespace in the input is ignored, so output from a packet capture
can be pasted directly.

Example:
  z1ctl proto decode 8668000aa276657273696f6ecca055aa`),
		cmds.WithArguments(
			fields.New("hex", fields.TypeStringList,
				fields.WithIsArgument(true),
				fields.WithHelp("Frame bytes as hex")),
		),
	)}, nil
}

func (c *DecodeCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &decodeSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	cleaned := strings.Map(func(r rune) rune {
		if r == ' ' || r == '\n' || r == '\t' || r == ':' || r == ',' {
			return -1
		}
		return r
	}, joinArgs(s.Hex))
	raw, err := hex.DecodeString(cleaned)
	if err != nil {
		return errors.Wrap(err, "input is not hex")
	}

	dec := &makera.Decoder{}
	frames := dec.Feed(raw)
	for i, f := range frames {
		if err := gp.AddRow(ctx, types.NewRow(
			types.MRP("n", i+1),
			types.MRP("type", f.Type.String()),
			types.MRP("type_hex", "0x"+strings.ToUpper(hex.EncodeToString([]byte{byte(f.Type)}))),
			types.MRP("payload_bytes", len(f.Payload)),
			types.MRP("payload", string(f.Payload)),
			types.MRP("payload_hex", hex.EncodeToString(f.Payload)),
		)); err != nil {
			return err
		}
	}
	if len(frames) == 0 {
		return errors.Errorf("no complete frames decoded (%d bytes rejected)", dec.Drops)
	}
	return nil
}

// ProbeCommand reports which protocol a machine speaks.
type ProbeCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = &ProbeCommand{}

func NewProbeCommand() (*ProbeCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &ProbeCommand{cmds.NewCommandDescription(
		"probe",
		cmds.WithShort("Report which wire protocol a machine speaks"),
		cmds.WithLong(`Connect, run protocol detection, and report the verdict.

The probe sends the raw, deliberately unframed bytes "echo echo\n". An older
machine echoes back because raw text is its native language; a newer machine
sees no frame header and discards them. Silence is therefore the signal for the
framed protocol.

This is harmless: the probe bytes are not a valid command in either dialect.`),
		cmds.WithSections(conn),
	)}, nil
}

func (c *ProbeCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	conn, err := DecodeConnection(vals)
	if err != nil {
		return err
	}
	conn.Protocol = "auto" // the point of this command
	opts, err := conn.Resolve(ctx)
	if err != nil {
		return err
	}
	client, err := makera.Dial(ctx, opts)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	return gp.AddRow(ctx, types.NewRow(
		types.MRP("address", opts.Address),
		types.MRP("protocol", client.Protocol()),
		types.MRP("framed", client.Protocol() == "makera"),
	))
}

// NewProtoGroup builds the `proto` command group.
func NewProtoGroup() (*cobra.Command, error) {
	group := &cobra.Command{
		Use:   "proto",
		Short: "Inspect and debug the wire protocol",
		Long: `Protocol inspection tools.

encode and decode are offline and useful for checking an implementation against
a packet capture. probe connects and reports which dialect a machine speaks.

The specification these implement is in docs/protocol.md.`,
	}
	encode, err := NewEncodeCommand()
	if err != nil {
		return nil, err
	}
	decode, err := NewDecodeCommand()
	if err != nil {
		return nil, err
	}
	probe, err := NewProbeCommand()
	if err != nil {
		return nil, err
	}
	if err := cli.AddCommandsToRootCommand(group,
		[]cmds.Command{encode, decode, probe}, nil, parserOptions()...); err != nil {
		return nil, err
	}
	return group, nil
}

func parsePacketType(s string) (makera.PacketType, error) {
	s = strings.TrimSpace(strings.ToLower(s))
	s = strings.TrimPrefix(s, "0x")
	v, err := strconv.ParseUint(s, 16, 8)
	if err != nil {
		return 0, errors.Wrapf(err, "bad packet type %q (expected hex like 0xA2)", s)
	}
	return makera.PacketType(v), nil
}

func spacedHex(b []byte) string {
	var sb strings.Builder
	for i, c := range b {
		if i > 0 {
			sb.WriteByte(' ')
		}
		sb.WriteString(hex.EncodeToString([]byte{c}))
	}
	return sb.String()
}
