package makera

import "fmt"

// Halt reasons, reported as the `H:` key in the status report while the machine
// is halted. The key is absent when nothing is halted, so its absence says
// something about machine state rather than about firmware capability.
//
// Codes and their recovery bands are taken from the Carvera Community
// Controller's halt table (carveracontroller/main.py:253-282, commit 777482a).
// Only code 13 has been observed on hardware here, in an emergency-stop halt.
//
// The bands matter more than the individual codes:
//
//	< 20   the machine only needs unlocking
//	21-40  the machine needs a reset
//	> 40   the machine needs a power cycle
var haltReasons = map[int]string{
	1:  "halted manually",
	2:  "homing failed",
	3:  "probe failed",
	4:  "calibration failed",
	5:  "ATC homing failed",
	6:  "ATC invalid tool number",
	7:  "ATC drop tool failed",
	8:  "ATC position occupied",
	9:  "spindle temperature error",
	10: "soft limit triggered",
	11: "cover opened while playing",
	12: "wireless probe dead or not set",
	13: "emergency stop button pressed",
	14: "electronics temperature error",
	16: "3D probe crash detected",

	21: "hard limit triggered",
	22: "X axis motor error",
	23: "Y axis motor error",
	24: "Z axis motor error",
	25: "spindle stall",
	26: "SD card read failure",

	41: "spindle alarm",
}

// HaltRecovery is what the operator has to do to get the machine running again.
type HaltRecovery int

const (
	// RecoveryUnlock means the alarm can be cleared with an unlock.
	RecoveryUnlock HaltRecovery = iota
	// RecoveryReset means the machine must be reset.
	RecoveryReset
	// RecoveryPowerCycle means the machine must be switched off and on.
	RecoveryPowerCycle
)

func (r HaltRecovery) String() string {
	switch r {
	case RecoveryReset:
		return "reset required"
	case RecoveryPowerCycle:
		return "power cycle required"
	default:
		return "unlock required"
	}
}

// HaltReason describes a halt code.
//
// Unknown codes are reported as unknown rather than guessed at, but the
// recovery band is still derived from the numeric range, because the bands are
// a property of the range rather than of any individual code.
func HaltReason(code int) (text string, recovery HaltRecovery, known bool) {
	switch {
	case code > 40:
		recovery = RecoveryPowerCycle
	case code > 20:
		recovery = RecoveryReset
	default:
		recovery = RecoveryUnlock
	}
	if t, ok := haltReasons[code]; ok {
		return t, recovery, true
	}
	return fmt.Sprintf("unknown halt code %d", code), recovery, false
}
