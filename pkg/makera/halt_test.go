package makera

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestHaltReasonBands(t *testing.T) {
	// The only code observed on hardware: an emergency-stop halt, which is in
	// the band that an unlock can clear.
	text, recovery, known := HaltReason(13)
	assert.True(t, known)
	assert.Equal(t, "emergency stop button pressed", text)
	assert.Equal(t, RecoveryUnlock, recovery)

	_, recovery, _ = HaltReason(21)
	assert.Equal(t, RecoveryReset, recovery, "hard limit needs a reset")

	_, recovery, _ = HaltReason(41)
	assert.Equal(t, RecoveryPowerCycle, recovery, "spindle alarm needs a power cycle")
}

// TestHaltReasonUnknownStillBands guards the property that matters for safety:
// an unrecognised code must still route to the right recovery, because the band
// is a property of the numeric range rather than of the individual code.
func TestHaltReasonUnknownStillBands(t *testing.T) {
	text, recovery, known := HaltReason(27)
	assert.False(t, known)
	assert.Contains(t, text, "unknown halt code 27")
	assert.Equal(t, RecoveryReset, recovery)

	_, recovery, known = HaltReason(99)
	assert.False(t, known)
	assert.Equal(t, RecoveryPowerCycle, recovery)
}
