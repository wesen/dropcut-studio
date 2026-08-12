package makera

import (
	"context"
	"strings"

	"github.com/pkg/errors"
)

// Job lifecycle: MZ1-003 §9.
//
// The machine does not stream G-code — a file on the SD card is executed
// locally by `play`, and the host supervises. Starting is Class 1 and goes
// through Motion with a PlayFile op. This file holds the rest of the
// lifecycle, each method carrying its class in its documentation:
//
//	Suspend   Class 0 — never gated, never preflighted
//	Abort     Class 0 — never gated, never preflighted
//	FeedHold  Class 0 — realtime, never gated
//	Resume    Class 2 — restarts motion that was deliberately stopped
//	Progress  read-only

// Suspend pauses a running job. Class 0: it only stops things, so it runs in
// any machine state with no preflight — a stop that can be refused is not a
// stop.
func (c *Client) Suspend(ctx context.Context) ([]Message, error) {
	c.logger.Info().Msg("suspending job")
	return c.commandUnchecked(ctx, "suspend")
}

// Abort ends a job. Class 0, same rule as Suspend.
func (c *Client) Abort(ctx context.Context) ([]Message, error) {
	c.logger.Info().Msg("aborting job")
	return c.commandUnchecked(ctx, "abort")
}

// FeedHold sends the realtime feed hold. Class 0. It takes no lock and waits
// for nothing: the byte goes out ahead of whatever else is happening.
func (c *Client) FeedHold() error {
	c.logger.Info().Msg("feed hold")
	return c.write(c.proto.EncodeRealtime(RealtimeHold))
}

// Resume restarts a suspended job. Class 2 — it re-enables motion that was
// deliberately stopped, so it preflights (permitting the paused job itself)
// and never runs from any automatic path.
func (c *Client) Resume(ctx context.Context, opts PreflightOptions) ([]Message, error) {
	opts.AllowWhilePlaying = true
	pf, err := c.Preflight(ctx, ClassStateEnabling, opts)
	if err != nil {
		return nil, err
	}
	if fails := pf.Failures(); len(fails) > 0 {
		return nil, errors.Wrapf(ErrPreflightFailed, "%s", pf.FailureSummary())
	}
	c.logger.Warn().Msg("resuming job — this restarts motion")
	return c.commandUnchecked(ctx, "resume")
}

// CycleStart sends the realtime resume `~`, the counterpart of feed hold.
// Class 2: it restarts held motion, so it is an authorised entry point rather
// than an allowed realtime byte.
func (c *Client) CycleStart() error {
	c.logger.Warn().Msg("cycle start — resuming held motion")
	return c.write(c.proto.EncodeRealtime(RealtimeResume))
}

// Progress asks the machine for job progress. Read-only. The boolean reports
// whether a job is playing; when false, the Playback is zero.
func (c *Client) Progress(ctx context.Context) (Playback, bool, error) {
	lines, err := c.CommandText(ctx, "progress")
	if err != nil {
		return Playback{}, false, err
	}
	for _, l := range lines {
		if strings.Contains(strings.ToLower(l), "not currently playing") {
			return Playback{}, false, nil
		}
	}
	// A playing machine answers with a progress line; the status report's P:
	// key is the structured source, so consult it for the numbers.
	st, err := c.QueryStatus(ctx)
	if err != nil {
		return Playback{}, false, err
	}
	if st.Playing == nil {
		return Playback{}, false, nil
	}
	return *st.Playing, true, nil
}
