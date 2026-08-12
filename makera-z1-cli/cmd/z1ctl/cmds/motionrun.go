package cmds

import (
	"context"
	"fmt"
	"strings"

	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
	"github.com/go-go-golems/glazed/pkg/middlewares"
	"github.com/go-go-golems/glazed/pkg/types"
	"github.com/pkg/errors"

	"github.com/go-go-golems/makera-z1-cli/pkg/makera"
)

// Shared plumbing for every command that can move the machine.
//
// The flow is uniform so that a reviewer can audit one function instead of
// eight commands: --dry-run renders and stops (no connection is even opened);
// state-enabling and motion classes require --confirm; the request is
// executed through Client.Motion, which preflights fresh and never retries.

type motionRunFlags struct {
	Confirm        bool `glazed:"confirm"`
	DryRun         bool `glazed:"dry-run"`
	AllowOpenCover bool `glazed:"allow-open-cover"`
}

// motionFlagDefs are mounted on every motion command.
func motionFlagDefs() []*fields.Definition {
	return []*fields.Definition{
		fields.New("confirm", fields.TypeBool,
			fields.WithDefault(false),
			fields.WithHelp("Required for motion. Confirms an operator is at the machine with a hand near the emergency stop")),
		fields.New("dry-run", fields.TypeBool,
			fields.WithDefault(false),
			fields.WithHelp("Print the exact commands and wire frames without connecting or sending")),
		fields.New("allow-open-cover", fields.TypeBool,
			fields.WithDefault(false),
			fields.WithHelp("Waive the cover-closed preflight condition (setup jogging with the cover open)")),
	}
}

func decodeMotionFlags(vals *values.Values) (motionRunFlags, error) {
	f := motionRunFlags{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, &f); err != nil {
		return f, errors.Wrap(err, "decode motion flags")
	}
	return f, nil
}

// emitDryRun renders the request into rows: what would be sent, byte for byte.
func emitDryRun(ctx context.Context, gp middlewares.Processor, req makera.MotionRequest) error {
	rep, err := makera.DryRun(req)
	if err != nil {
		return err
	}
	for i, s := range rep.Steps {
		if err := gp.AddRow(ctx, types.NewRow(
			types.MRP("step", i+1),
			types.MRP("op", s.Op),
			types.MRP("command", s.Command),
			types.MRP("frame", fmt.Sprintf("% x", s.Frame)),
			types.MRP("class", rep.Class.String()),
			types.MRP("requires_homed", rep.RequiresHomed),
			types.MRP("sent", false),
		)); err != nil {
			return err
		}
	}
	return nil
}

// runMotionRequest is the one path from a CLI command to moving metal.
func runMotionRequest(ctx context.Context, vals *values.Values, gp middlewares.Processor, req makera.MotionRequest) error {
	f, err := decodeMotionFlags(vals)
	if err != nil {
		return err
	}
	if f.DryRun {
		return emitDryRun(ctx, gp, req)
	}
	if req.Class() >= makera.ClassStateEnabling && !f.Confirm {
		return errors.Errorf(
			"refusing: this is a %s-class request (%s). Inspect it with --dry-run, then re-run with --confirm, standing at the machine",
			req.Class(), req.Reason)
	}

	client, err := DialFrom(ctx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	res, err := client.Motion(ctx, req, makera.PreflightOptions{AllowOpenCover: f.AllowOpenCover})
	if err != nil {
		return err
	}
	for i, cmd := range res.Sent {
		if err := gp.AddRow(ctx, types.NewRow(
			types.MRP("step", i+1),
			types.MRP("command", cmd),
			types.MRP("sent", true),
			types.MRP("reply", strings.Join(res.Replies, " | ")),
			types.MRP("state_after", res.StateAfter.State),
			types.MRP("at_rest", res.StateAfter.AtRestPosition),
		)); err != nil {
			return err
		}
	}
	return nil
}
