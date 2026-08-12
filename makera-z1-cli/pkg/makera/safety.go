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
//
// MZ1-001 guarded with a single question — "can this move the machine?" —
// and that proved too coarse: it cannot express that a light and a spindle
// are both M-codes, or that `suspend` must NEVER be refused. This file now
// classifies every command into a risk class (MZ1-003 §3) and derives the
// guards from the class.

// RiskClass is what a command can do, ordered by severity. The ordering is
// load-bearing: a request spanning several operations is gated by the maximum
// class across them, and callers can never lower it.
type RiskClass int

const (
	// ClassRead only reports state. Allowed everywhere.
	ClassRead RiskClass = iota
	// ClassStop only stops things: suspend, abort, feed hold, jog stop,
	// spindle off. NEVER gated, in any machine state, even when a preflight is
	// failing — a stop that can be refused is not a stop.
	ClassStop
	// ClassAccessory switches a real output that cannot cut anyone: light,
	// vacuum, fan, air. Allowed on dedicated paths without confirmation;
	// still refused on the generic text path.
	ClassAccessory
	// ClassData mutates the machine's filesystem, clock or configuration.
	// Data loss, no injury. Typed paths verify their own effect.
	ClassData
	// ClassStateEnabling commands no movement itself but permits or resumes
	// it: unlock, resume, cycle start, soft reset.
	ClassStateEnabling
	// ClassMotion can move the machine or start unbounded motion: homing,
	// jog, G-codes, spindle on, play. Authorised path only, full preflight,
	// never retried, never a side effect.
	ClassMotion
)

func (c RiskClass) String() string {
	switch c {
	case ClassRead:
		return "read"
	case ClassStop:
		return "stop"
	case ClassAccessory:
		return "accessory"
	case ClassData:
		return "data"
	case ClassStateEnabling:
		return "state-enabling"
	case ClassMotion:
		return "motion"
	}
	return "unknown"
}

// ErrMotionNotAuthorised is returned when a command that could move the
// machine, start a job, or mutate its filesystem is issued through a path that
// has not been explicitly authorised.
var ErrMotionNotAuthorised = errors.New("command can move the machine or change its state; not authorised on this path")

// classByVerb classifies shell-style verbs whose class the first word alone
// determines.
var classByVerb = map[string]RiskClass{
	// Stopping is never gated.
	"suspend": ClassStop,
	"abort":   ClassStop,

	// Job start and anything that buffers commands for later execution.
	"play":   ClassMotion,
	"buffer": ClassMotion,

	// `switch <name> <value>` drives arbitrary outputs including ones that
	// spin; `switch <name>` merely queries. One argument is the difference,
	// and a typo would actuate rather than fail — deliberately kept at the
	// most severe class rather than split like `time`/`wlan`.
	"switch": ClassMotion,

	// State-enabling: no movement commanded, movement permitted.
	"resume":  ClassStateEnabling,
	"reset":   ClassStateEnabling,
	"dfu":     ClassStateEnabling,
	"break":   ClassStateEnabling,
	"remount": ClassStateEnabling,

	// Data: filesystem, clock, configuration.
	"upload": ClassData, "download": ClassData,
	"rm": ClassData, "mv": ClassData, "mkdir": ClassData,
	"config-set": ClassData, "config-default": ClassData, "config-restore": ClassData,
	"load": ClassData, "save": ClassData,
	"set_temp": ClassData,
	"baud":     ClassData,
	"ap":       ClassData,
}

// writeWithArgs verbs are read-only in their bare form and mutate machine state
// when given arguments: `time` reports the clock, `time <epoch>` sets it;
// `wlan -e` lists networks, `wlan <ssid> <password>` joins one.
var writeWithArgs = map[string]bool{
	"time": true,
	"wlan": true,
}

// wlanReadOnlyArgs are the flag-only forms of `wlan` that merely list networks.
var wlanReadOnlyArgs = map[string]bool{"-e": true}

// readOnlyExceptions are verbs that begin with a motion prefix letter but are
// demonstrably read-only on this firmware.
var readOnlyExceptions = map[string]bool{
	"md5sum": true, "mem": true, "model": true,
	// M957 only prints spindle telemetry (state, current/target RPM, PWM
	// value — SpindleControl.cpp): the readout half of the M958 tuning pair.
	"m957": true,
}

// accessoryMCodes are M-codes that switch an output which cannot cut anyone.
// MZ1-003 §3 Class 3 — the machine's own light and vacuum are things an
// operator toggles constantly. The overrides M220/M223 are deliberately NOT
// here: they change the speed of a running job, which is Class 1 in effect.
var accessoryMCodes = map[int]bool{
	7:   true,            // air on (M9, air off, is a stop)
	801: true, 802: true, // vacuum
	811: true, 812: true, // spindle fan
	821: true, 822: true, // light
	831: true, 832: true, // tool sensor power
	841: true, 842: true, // probe charger
	851: true, 852: true, // external PWM
}

// stopMCodes are M-codes that only stop an output.
var stopMCodes = map[int]bool{
	5: true, // spindle off
	9: true, // coolant/air off
}

// Classify reports what a command string can do. It is the single authority
// the guards derive from, and it is deliberately over-inclusive: an unknown
// command shaped like G-code classifies as motion. A false positive costs a
// caller one explicit authorisation; a false negative costs a broken tool.
func Classify(cmd string) RiskClass {
	trimmed := strings.TrimSpace(strings.ToLower(cmd))
	if trimmed == "" {
		return ClassRead
	}
	parts := strings.Fields(trimmed)
	verb := parts[0]
	args := parts[1:]

	if readOnlyExceptions[verb] {
		return ClassRead
	}
	if class, ok := classByVerb[verb]; ok {
		return class
	}
	if writeWithArgs[verb] {
		if len(args) == 0 {
			return ClassRead
		}
		if verb == "wlan" {
			for _, a := range args {
				if !wlanReadOnlyArgs[a] {
					return ClassData
				}
			}
			return ClassRead
		}
		return ClassData
	}

	// Realtime characters in text form. Bare, they act exactly like their
	// realtime byte equivalents and classify the same way. With anything
	// appended they are not a known command at all — refuse at the top class
	// rather than guess what the firmware makes of them.
	if strings.HasPrefix(trimmed, "!") || strings.HasPrefix(trimmed, "~") {
		switch trimmed {
		case "!":
			return ClassStop
		case "~":
			return ClassStateEnabling
		default:
			return ClassMotion
		}
	}

	// $-commands. $H and $J move; $X enables; everything else unknown-dollar
	// is treated as motion rather than guessed at.
	if strings.HasPrefix(trimmed, "$") {
		switch {
		case strings.HasPrefix(trimmed, "$x"):
			return ClassStateEnabling
		default:
			return ClassMotion
		}
	}

	// Letter-prefixed codes: G, T and M followed by a digit. A bare letter
	// only counts when followed by a digit, so "model" is not an M-code.
	if len(trimmed) >= 2 && trimmed[1] >= '0' && trimmed[1] <= '9' {
		switch trimmed[0] {
		case 'g', 't':
			return ClassMotion
		case 'm':
			n := 0
			for i := 1; i < len(trimmed) && trimmed[i] >= '0' && trimmed[i] <= '9'; i++ {
				n = n*10 + int(trimmed[i]-'0')
			}
			switch {
			case stopMCodes[n]:
				return ClassStop
			case accessoryMCodes[n]:
				return ClassAccessory
			default:
				return ClassMotion
			}
		}
	}
	return ClassRead
}

// IsMotionCommand reports whether a command needs an authorised path: anything
// above ClassStop. Retained because "can this transit the generic path?" is
// the question every unauthorised caller asks.
func IsMotionCommand(cmd string) bool {
	return Classify(cmd) >= ClassAccessory
}

// AssertNotMotion rejects any command that must not transit the generic path.
// Reads and stops pass; everything else is refused with its class named.
func AssertNotMotion(cmd string) error {
	if class := Classify(cmd); class >= ClassAccessory {
		return errors.Wrapf(ErrMotionNotAuthorised, "refusing %q (class %s)", strings.TrimSpace(cmd), class)
	}
	return nil
}

// AssertRealtimeAllowed permits the Class 0 and read-only realtime bytes on
// unauthorised paths: status query, jog keepalive, feed hold and jog stop.
// The last two ONLY stop things, and a stop that can be refused is not a
// stop — this changed in MZ1-003; the read-only tool refused feed hold.
//
// Cycle start `~` resumes motion and soft reset clears state; both are
// state-enabling and stay behind authorised paths.
func AssertRealtimeAllowed(ch byte) error {
	switch ch {
	case RealtimeStatus, RealtimeJogKeep, RealtimeHold, RealtimeJogStop:
		return nil
	}
	return errors.Wrapf(ErrMotionNotAuthorised, "refusing realtime byte 0x%02X", ch)
}

// Unlock clears a latched alarm by sending the GRBL unlock command.
//
// This was the first authorised command in this package, and it is
// deliberately narrow. The name carries the authorisation: a reader of any
// call site can see that a human asked for this.
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
