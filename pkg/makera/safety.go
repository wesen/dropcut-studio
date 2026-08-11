// SPDX-License-Identifier: GPL-2.0-only

package makera

import (
	"strings"

	"github.com/pkg/errors"
)

// Safety enforcement.
//
// A spindle at ten thousand RPM with a carbide cutter can destroy the
// workpiece, the tool, and the operator's hand. The rule this file implements
// is that motion is never a side effect: it happens only when a caller has
// explicitly said so, in code, at the call site.
//
// The check runs before a byte reaches the socket. That is the point — an
// allowlist enforced by the compiler and the call graph is a mechanism;
// remembering not to type the wrong command is not.

// ErrMotionNotAuthorised is returned when a command that could move the
// machine, start a job, or mutate its filesystem is issued through a path that
// has not been explicitly authorised.
var ErrMotionNotAuthorised = errors.New("command can move the machine or change its state; not authorised on this path")

// motionVerbs are first words that can cause motion, start or stop a job, or
// mutate machine state.
var motionVerbs = map[string]bool{
	"play": true, "suspend": true, "resume": true, "abort": true,
	"reset": true, "dfu": true, "break": true, "remount": true,
	"upload": true, "download": true, "rm": true, "mv": true, "mkdir": true,
	"config-set": true, "config-default": true, "config-restore": true,
	"load": true, "save": true, "set_temp": true, "switch": true,
	"baud": true, "buffer": true, "time": true, "ap": true,
}

// motionPrefixes catch G-code, M-code and GRBL-style commands, which are not
// separated from their arguments by a space (`G0X10`, `$J X1`).
var motionPrefixes = []string{
	"g", "m", "t", "$h", "$j", "$x", "$g", "$#", "!", "~",
}

// readOnlyExceptions are verbs that begin with a motion prefix letter but are
// demonstrably read-only on this firmware.
var readOnlyExceptions = map[string]bool{
	"md5sum": true, "mem": true, "model": true,
}

// IsMotionCommand reports whether a command string could move the machine or
// change its persistent state.
//
// It is deliberately over-inclusive. A false positive costs a caller one
// explicit authorisation; a false negative costs a broken tool.
func IsMotionCommand(cmd string) bool {
	trimmed := strings.TrimSpace(strings.ToLower(cmd))
	if trimmed == "" {
		return false
	}
	verb := trimmed
	if i := strings.IndexAny(trimmed, " \t"); i >= 0 {
		verb = trimmed[:i]
	}
	if readOnlyExceptions[verb] {
		return false
	}
	if motionVerbs[verb] {
		return true
	}
	for _, p := range motionPrefixes {
		if strings.HasPrefix(trimmed, p) {
			// A bare letter prefix only counts when followed by a digit or
			// separator, so "model" is not mistaken for an M-code.
			if len(p) > 1 {
				return true
			}
			rest := trimmed[len(p):]
			if rest == "" {
				return true
			}
			if rest[0] >= '0' && rest[0] <= '9' {
				return true
			}
		}
	}
	return false
}

// AssertNotMotion rejects any command that could move the machine.
func AssertNotMotion(cmd string) error {
	if IsMotionCommand(cmd) {
		return errors.Wrapf(ErrMotionNotAuthorised, "refusing %q", strings.TrimSpace(cmd))
	}
	return nil
}

// AssertRealtimeAllowed permits only the status query on unauthorised paths.
// Feed hold and cycle start change machine behaviour; soft reset clears state.
func AssertRealtimeAllowed(ch byte) error {
	if ch == RealtimeStatus || ch == RealtimeJogKeep {
		return nil
	}
	return errors.Wrapf(ErrMotionNotAuthorised, "refusing realtime byte 0x%02X", ch)
}

// Motion is deliberately not implemented in this package yet.
//
// When it is added, it belongs behind a distinctly named entry point — the name
// itself carries the authorisation, so that a reader of any call site can see
// that a human asked for motion. It must never be reachable from a retry path,
// a reconnect path, or as a side effect of a query, and it must never retry:
// re-sending a G0 after a timeout can execute the move twice.
//
// Until that exists and has been exercised with an operator standing at the
// machine, Client.Command refuses every motion verb.
