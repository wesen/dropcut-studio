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

// The machine takes a moment to leave Alarm after an unlock, so poll rather
// than reading once. These bound that wait.
const (
	unlockSettleTimeout = 4 * time.Second
	unlockPollInterval  = 300 * time.Millisecond
)

// UnlockCommand clears a latched alarm.
type UnlockCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = &UnlockCommand{}

func NewUnlockCommand() (*UnlockCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &UnlockCommand{cmds.NewCommandDescription(
		"unlock",
		cmds.WithShort("Clear a latched alarm (requires --confirm)"),
		cmds.WithLong(`Send the GRBL unlock command to clear a latched alarm.

An alarm latches after an emergency stop, a limit trip or a probe fault, and the
machine refuses motion until it is cleared. Unlocking does not move anything —
but it RE-ENABLES motion, which is why it requires --confirm and is not part of
any read-only path.

Preflight, all of which must pass:

  · the machine must actually be in Alarm    (otherwise there is nothing to do)
  · the emergency stop must be clear         (otherwise it will re-alarm at once)
  · the cover must be closed, or verifiably
    reported                                 (--allow-open-cover to override)

The command never retries. If the alarm does not clear, that is information
worth seeing rather than papering over.

Before unlocking, understand WHY the machine alarmed. Clearing an alarm caused
by a limit trip while the axis is still against the limit will simply alarm
again; clearing one caused by a probe fault without checking the probe can
damage it.

Examples:
  z1ctl doctor                 # find out why it alarmed
  z1ctl unlock --confirm`),
		cmds.WithFlags(
			fields.New("confirm", fields.TypeBool,
				fields.WithDefault(false),
				fields.WithHelp("Required. Confirms you intend to re-enable motion")),
			fields.New("allow-open-cover", fields.TypeBool,
				fields.WithDefault(false),
				fields.WithHelp("Proceed even if the cover is open or its state is unknown")),
		),
		cmds.WithSections(conn),
	)}, nil
}

type unlockFlags struct {
	Confirm        bool `glazed:"confirm"`
	AllowOpenCover bool `glazed:"allow-open-cover"`
}

func (c *UnlockCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &unlockFlags{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	if !s.Confirm {
		return errors.New(
			"refusing: unlock re-enables motion. Run `z1ctl doctor` to see why the " +
				"machine alarmed, then re-run with --confirm")
	}

	client, err := DialFrom(ctx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	before, err := client.QueryStatus(ctx)
	if err != nil {
		return errors.Wrap(err, "read status before unlocking")
	}
	if before.State != "Alarm" {
		return errors.Errorf("refusing: machine is %q, not in Alarm — nothing to clear", before.State)
	}

	d, err := client.QueryDiagnose(ctx)
	if err != nil {
		return errors.Wrap(err, "read diagnostics before unlocking")
	}
	if d.EStop {
		return errors.New("refusing: emergency stop is engaged — release it first, or the machine will re-alarm immediately")
	}
	if !s.AllowOpenCover {
		closed, known := d.CoverClosed()
		if !known {
			return errors.New("refusing: cover state could not be determined; pass --allow-open-cover to proceed anyway")
		}
		if !closed {
			return errors.New("refusing: cover is open; close it, or pass --allow-open-cover")
		}
	}

	haltCode := 0
	if v, ok := before.Raw.At("H", 0); ok {
		haltCode = int(v)
	}
	haltText, recovery, _ := makera.HaltReason(haltCode)
	if recovery != makera.RecoveryUnlock {
		return errors.Errorf(
			"refusing: halt reason %d (%s) needs a %s, not an unlock",
			haltCode, haltText, recovery)
	}

	if _, err := client.Unlock(ctx); err != nil {
		return errors.Wrap(err, "send unlock")
	}

	// The machine does not leave Alarm instantly. Poll until it does rather
	// than reading once and reporting a spurious failure — a single immediate
	// query reported "not cleared" for an unlock that had in fact worked.
	//
	// This re-reads status; it does NOT re-send the unlock. Motion commands are
	// never retried.
	after := before
	deadline := time.Now().Add(unlockSettleTimeout)
	for {
		st, err := client.QueryStatus(ctx)
		if err != nil {
			return errors.Wrap(err, "read status after unlocking")
		}
		after = st
		if st.State != "Alarm" || time.Now().After(deadline) {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(unlockPollInterval):
		}
	}

	return gp.AddRow(ctx, types.NewRow(
		types.MRP("state_before", before.State),
		types.MRP("halt_reason", haltCode),
		types.MRP("halt_meaning", haltText),
		types.MRP("state_after", after.State),
		types.MRP("cleared", after.State != "Alarm"),
		types.MRP("at_rest", after.AtRestPosition),
	))
}
