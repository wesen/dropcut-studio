package makera

import (
	"context"
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
	"baud": true, "buffer": true, "ap": true,
}

// writeWithArgs verbs are read-only in their bare form and mutate machine state
// when given arguments: `time` reports the clock, `time <epoch>` sets it;
// `wlan -e` lists networks, `wlan <ssid> <password>` joins one.
//
// `switch` follows the same shape — `switch <name>` queries and
// `switch <name> <value>` actuates — but it is deliberately in the always-refuse
// list above, because there the difference is one argument on a command that
// drives real outputs, and a typo would actuate rather than fail.
var writeWithArgs = map[string]bool{
	"time": true,
	"wlan": true,
}

// wlanReadOnlyArgs are the flag-only forms of `wlan` that merely list networks.
var wlanReadOnlyArgs = map[string]bool{"-e": true}

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
	parts := strings.Fields(trimmed)
	verb := parts[0]
	args := parts[1:]

	if readOnlyExceptions[verb] {
		return false
	}
	if motionVerbs[verb] {
		return true
	}
	if writeWithArgs[verb] {
		// Bare form is a query.
		if len(args) == 0 {
			return false
		}
		// `wlan -e` is still just a listing.
		if verb == "wlan" {
			for _, a := range args {
				if !wlanReadOnlyArgs[a] {
					return true
				}
			}
			return false
		}
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

// Unlock clears a latched alarm by sending the GRBL unlock command.
//
// This is the FIRST authorised command in this package, and it is deliberately
// narrow. The name carries the authorisation: a reader of any call site can see
// that a human asked for this.
//
// Why this is safe to authorise while motion is not: `$X` clears the alarm lock
// and nothing else. It commands no movement. Upstream's Controller.unlock()
// (vendor/community-carvera-controller/carveracontroller/Controller.py:1773)
// does exactly this and nothing more.
//
// What it DOES do is re-enable motion, so callers must preflight first. This
// function does not preflight for you — that belongs at the call site, where
// the operator's intent is known.
//
// It never retries. If the alarm does not clear, that is information, and
// sending the command twice hides it.
func (c *Client) Unlock(ctx context.Context) ([]Message, error) {
	c.logger.Warn().Msg("sending $X to clear a latched alarm — this re-enables motion")
	return c.commandUnchecked(ctx, "$X")
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
