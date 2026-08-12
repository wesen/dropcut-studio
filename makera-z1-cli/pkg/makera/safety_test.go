package makera

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// These tests are the safety guard. If one of them starts failing because a
// command was reclassified, that is a decision about whether a mill is allowed
// to move on its own, not a test maintenance chore.
//
// MZ1-003 note: `suspend`, `abort`, bare `!`, `M5` and `M9` moved OUT of the
// refused set, deliberately. They are Class 0 — they only stop things, and a
// stop that can be refused is not a stop. That reclassification is flagged for
// the operator safety review.

func TestMotionClassCommandsAreRefused(t *testing.T) {
	motion := []string{
		"$H", "$h",
		"$J X10", "$J X-1 F600", "$J -c X1",
		"G0 X10 Y10", "G53 G0 Z-2", "G1X5", "g28",
		"M3 S12000", "M6 T2", "M0", "M30",
		"M220 S50", "M223 S80", // overrides act on a RUNNING job
		"T1",
		"play /sd/gcodes/part.nc",
		"buffer M6T2",
		"switch light 1", // one argument separates query from actuation
		"!G0 X10", "~x",  // realtime chars with junk appended: refuse, don't guess
	}
	for _, cmd := range motion {
		t.Run(cmd, func(t *testing.T) {
			assert.Equal(t, ClassMotion, Classify(cmd))
			assert.True(t, IsMotionCommand(cmd))
			assert.ErrorIs(t, AssertNotMotion(cmd), ErrMotionNotAuthorised)
		})
	}
}

func TestStateEnablingCommandsAreRefused(t *testing.T) {
	enabling := []string{"$X", "$x", "resume", "reset", "dfu", "break", "remount", "~"}
	for _, cmd := range enabling {
		t.Run(cmd, func(t *testing.T) {
			assert.Equal(t, ClassStateEnabling, Classify(cmd))
			assert.ErrorIs(t, AssertNotMotion(cmd), ErrMotionNotAuthorised)
		})
	}
}

func TestDataCommandsAreRefusedOnTheGenericPath(t *testing.T) {
	data := []string{
		"upload /sd/gcodes/part.nc", "download /sd/config.txt",
		"rm /sd/gcodes/old.nc", "mv a b", "mkdir /sd/gcodes/x",
		"config-set sd foo bar", "config-default", "config-restore",
		"set_temp bed 100", "time 1754937600", "baud 115200",
		"load", "save", "ap 6",
		// wlan joins a network when given a ssid/password.
		"wlan MyNetwork hunter2",
	}
	for _, cmd := range data {
		t.Run(cmd, func(t *testing.T) {
			assert.Equal(t, ClassData, Classify(cmd))
			assert.ErrorIs(t, AssertNotMotion(cmd), ErrMotionNotAuthorised)
		})
	}
}

func TestAccessoryCommandsAreRefusedOnTheGenericPathOnly(t *testing.T) {
	// Accessories are Class 3: dedicated paths expose them without
	// confirmation, but free text still cannot switch outputs.
	accessories := []string{"M7", "M801 S100", "M811 S80", "M821", "M831", "M841", "M851 S50"}
	for _, cmd := range accessories {
		t.Run(cmd, func(t *testing.T) {
			assert.Equal(t, ClassAccessory, Classify(cmd))
			assert.ErrorIs(t, AssertNotMotion(cmd), ErrMotionNotAuthorised)
		})
	}
}

// TestStopsAreNeverRefused pins Class 0: a stop that can be refused is not a
// stop. These flow through ANY path, including the generic one, in any state.
func TestStopsAreNeverRefused(t *testing.T) {
	stops := []string{"suspend", "abort", "!", "M5", "M9", "m5"}
	for _, cmd := range stops {
		t.Run(cmd, func(t *testing.T) {
			assert.Equal(t, ClassStop, Classify(cmd))
			assert.False(t, IsMotionCommand(cmd))
			assert.NoError(t, AssertNotMotion(cmd))
		})
	}
}

func TestReadOnlyCommandsAreAllowed(t *testing.T) {
	readOnly := []string{
		"version", "model", "ftype", "diagnose", "help", "pwd", "mem", "net",
		"progress", "thermistors",
		"ls -e -s /sd/gcodes",
		"cat /sd/gcodes/part.nc -e",
		"md5sum /sd/gcodes/part.nc -e",
		"get wcs", "get state", "get pos", "get status",
		"config-get sd foo",
		"echo hello",
		// Bare forms are queries; see writeWithArgs.
		"time",
		"wlan -e",
		// Query form of switch stays below the refusal line? No — bare switch
		// queries, but the verb is uniformly refused; see classByVerb. This
		// list pins only genuine reads.
	}
	for _, cmd := range readOnly {
		t.Run(cmd, func(t *testing.T) {
			assert.Equal(t, ClassRead, Classify(cmd))
			assert.False(t, IsMotionCommand(cmd))
			assert.NoError(t, AssertNotMotion(cmd))
		})
	}
}

// TestReadOnlyLookalikesAreNotMistakenForMotion covers the commands that begin
// with a motion prefix letter. "model" must not be read as an M-code.
func TestReadOnlyLookalikesAreNotMistakenForMotion(t *testing.T) {
	for _, cmd := range []string{"model", "mem", "md5sum /sd/x -e"} {
		assert.False(t, IsMotionCommand(cmd), cmd)
	}
}

// TestRealtimeGuardImplementsClassZero: the status query, the jog keepalive,
// feed hold and jog stop pass everywhere. Cycle start resumes motion and soft
// reset clears state; both stay behind authorised entry points.
func TestRealtimeGuardImplementsClassZero(t *testing.T) {
	for _, ch := range []byte{RealtimeStatus, RealtimeJogKeep, RealtimeHold, RealtimeJogStop} {
		assert.NoError(t, AssertRealtimeAllowed(ch))
	}
	for _, ch := range []byte{RealtimeResume, RealtimeSoftReset, 'x'} {
		assert.ErrorIs(t, AssertRealtimeAllowed(ch), ErrMotionNotAuthorised)
	}
}

func TestEmptyCommandIsNotMotion(t *testing.T) {
	assert.False(t, IsMotionCommand(""))
	assert.False(t, IsMotionCommand("   "))
	assert.Equal(t, ClassRead, Classify(""))
}

func TestRiskClassOrderingIsLoadBearing(t *testing.T) {
	// Request gating takes the maximum class; if the ordering changes, the
	// gates change with it.
	assert.True(t, ClassRead < ClassStop)
	assert.True(t, ClassStop < ClassAccessory)
	assert.True(t, ClassAccessory < ClassData)
	assert.True(t, ClassData < ClassStateEnabling)
	assert.True(t, ClassStateEnabling < ClassMotion)
}
