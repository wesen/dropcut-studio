package makera

import (
	"context"
	"fmt"
	"strings"

	"github.com/pkg/errors"
)

// The preflight: MZ1-003 §11.
//
// Every condition is read FRESH, immediately before acting — never from a
// cached poll. The gap between "cover was closed 800 ms ago" and "cover is
// closed" is exactly the interval in which someone opens it.
//
// What the preflight cannot establish, stated plainly because a preflight that
// overstates its coverage is worse than one that admits gaps: the axis-limit
// indices E[0..4] are inherited from published clients, not verified here
// (verifying them requires motion), so they only ever WARN; nothing knows
// whether a workpiece is clamped or the right tool is fitted; and the cover
// interlock is a sensor, not a lock. The preflight reduces the rate of stupid
// mistakes. It is not a safety system — the physical emergency stop is.

// ErrPreflightFailed is returned when a motion request was refused because one
// or more preflight conditions failed. Refusing is always available and always
// cheap: a refused jog costs a second.
var ErrPreflightFailed = errors.New("preflight failed; motion refused")

// PreflightOptions relax specific conditions where the operator has said so.
type PreflightOptions struct {
	// AllowOpenCover permits motion with the cover open or unknowable. The
	// operator jogging during setup is the intended use.
	AllowOpenCover bool
	// RequireHomed additionally requires a machine reference. Motion sets it
	// from the request's ops; callers can force it.
	RequireHomed bool
	// AllowWhilePlaying permits acting while a job runs. Only stop-class and
	// override commands have any business setting this.
	AllowWhilePlaying bool
}

// PreflightCheck is one evaluated condition.
type PreflightCheck struct {
	Name   string
	OK     bool
	Fatal  bool // a failed fatal check refuses the request; non-fatal warns
	Detail string
}

// PreflightReport is the full evaluation, plus the fresh state it read.
type PreflightReport struct {
	Checks   []PreflightCheck
	Status   Status
	Diagnose Diagnose
}

// Failures returns the fatal checks that did not pass.
func (r PreflightReport) Failures() []PreflightCheck {
	var out []PreflightCheck
	for _, ch := range r.Checks {
		if ch.Fatal && !ch.OK {
			out = append(out, ch)
		}
	}
	return out
}

// FailureSummary is the refusal message: every failed condition, not just the
// first, so the operator fixes them all in one round trip.
func (r PreflightReport) FailureSummary() string {
	fails := r.Failures()
	parts := make([]string, len(fails))
	for i, ch := range fails {
		parts[i] = fmt.Sprintf("%s (%s)", ch.Name, ch.Detail)
	}
	return strings.Join(parts, "; ")
}

// Preflight evaluates the MZ1-003 §11.1 table against a risk class, reading
// status and diagnose fresh. It returns an error only when the machine could
// not be read; a failing condition is reported in the checks, and Motion turns
// fatal failures into ErrPreflightFailed.
//
// Class 0 must never reach this function — stopping is not gated, and there is
// deliberately no code path from Suspend, Abort, FeedHold or JogSession.Stop
// into here.
func (c *Client) Preflight(ctx context.Context, class RiskClass, opts PreflightOptions) (PreflightReport, error) {
	if class <= ClassStop {
		return PreflightReport{}, errors.New("internal error: preflight invoked for a stop-class command; stops are never gated")
	}

	var rep PreflightReport
	st, err := c.QueryStatus(ctx)
	if err != nil {
		return rep, errors.Wrap(err, "preflight could not read status")
	}
	rep.Status = st

	d, err := c.QueryDiagnose(ctx)
	if err != nil {
		return rep, errors.Wrap(err, "preflight could not read diagnostics")
	}
	rep.Diagnose = d

	add := func(name string, ok, fatal bool, detail string) {
		rep.Checks = append(rep.Checks, PreflightCheck{Name: name, OK: ok, Fatal: fatal, Detail: detail})
	}

	// 2 — not in Alarm. The refusal names the halt reason and its recovery,
	// because "refused" without "why" invites blind unlocking.
	if st.State == "Alarm" {
		text, recovery, _ := HaltReason(st.HaltReason)
		add("machine state", false, true,
			fmt.Sprintf("Alarm — halt reason %d, %s; %s", st.HaltReason, text, recovery))
	} else {
		add("machine state", true, true, st.State)
	}

	// 3 — emergency stop clear.
	add("emergency stop", !d.EStop, true, pick(!d.EStop, "clear", "engaged"))

	// 4/5 — cover closed, and cover state KNOWABLE. Unknown is not closed: a
	// preflight that cannot verify the cover has not verified the cover.
	closed, known := d.CoverClosed()
	switch {
	case opts.AllowOpenCover:
		add("cover", true, true, "check waived by operator (--allow-open-cover)")
	case !known:
		add("cover", false, true,
			fmt.Sprintf("state unknowable: machine sent %d endstop fields, fewer than the mapping needs", len(d.Endstops)))
	default:
		add("cover", closed, true, pick(closed, "closed", "OPEN"))
	}

	// 6 — no job running.
	playing := st.Playing != nil && st.Playing.Active
	if opts.AllowWhilePlaying {
		add("job", true, true, "acting on a running job is this command's purpose")
	} else {
		add("job", !playing, true, pick(!playing, "no job running",
			fmt.Sprintf("a job is running (line %d, %d%%)", playingLines(st), playingPercent(st))))
	}

	// 7 — homed. ADVISORY ONLY: stock firmware does not report its homed
	// flag, and the -1,-1,-1 position is both "never homed" and "parked at
	// home after a successful cycle" (observations §12), so refusing on it
	// would refuse a freshly homed machine at rest. The firmware is the real
	// gate — an absolute move on an unhomed machine answers "axis is not
	// homed" (now surfaced in Replies), and `play` silently no-ops.
	if opts.RequireHomed && st.AtRestPosition {
		add("homing", false, false,
			"position is -1,-1,-1 — parked at home OR never homed; stock firmware cannot say. "+
				"If actually unhomed, absolute moves error and play silently does nothing — home first if unsure")
	} else {
		add("homing", true, false, pick(st.AtRestPosition,
			"at the -1,-1,-1 rest position (homing unknowable on stock firmware)",
			"position has moved since boot or homing"))
	}

	// 8 — axis limits. WARN ONLY: indices E[0..4] are inherited from
	// published clients and unverified on this hardware.
	limitNames := []string{"X min", "X max", "Y min", "Y max", "Z max"}
	for idx, name := range limitNames {
		if trig, k := d.EndstopTriggered(idx); k && trig {
			add("limit "+name, false, false, "reports triggered (advisory: index mapping unverified)")
		}
	}

	return rep, nil
}

func pick(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}

func playingLines(st Status) int {
	if st.Playing == nil {
		return 0
	}
	return st.Playing.Lines
}

func playingPercent(st Status) int {
	if st.Playing == nil {
		return 0
	}
	return st.Playing.Percent
}
