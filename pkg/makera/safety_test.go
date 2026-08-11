// SPDX-License-Identifier: GPL-2.0-only

package makera

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// These tests are the safety guard. If one of them starts failing because a
// command was reclassified as read-only, that is a decision about whether a
// mill is allowed to move on its own, not a test maintenance chore.

func TestMotionCommandsAreRefused(t *testing.T) {
	motion := []string{
		"$H", "$h",
		"$J X10", "$J X-1 F600",
		"$X",
		"G0 X10 Y10", "G53 G0 Z-2", "G1X5", "g28",
		"M3 S12000", "M5", "M6 T2", "M0",
		"T1",
		"play /sd/gcodes/part.nc",
		"suspend", "resume", "abort", "reset", "dfu", "break", "remount",
		"upload /sd/gcodes/part.nc", "download /sd/config.txt",
		"rm /sd/gcodes/old.nc", "mv a b", "mkdir /sd/gcodes/x",
		"config-set sd foo bar", "config-default", "config-restore",
		"switch light 1", "set_temp bed 100",
		"time 1754937600", "baud 115200", "buffer M6T2",
		"load", "save", "ap 6",
	}
	for _, cmd := range motion {
		t.Run(cmd, func(t *testing.T) {
			assert.True(t, IsMotionCommand(cmd), "must be classified as motion")
			assert.ErrorIs(t, AssertNotMotion(cmd), ErrMotionNotAuthorised)
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
		"wlan -e",
	}
	for _, cmd := range readOnly {
		t.Run(cmd, func(t *testing.T) {
			assert.False(t, IsMotionCommand(cmd), "must not be classified as motion")
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

func TestRealtimeGuardPermitsOnlyStatusAndKeepalive(t *testing.T) {
	assert.NoError(t, AssertRealtimeAllowed(RealtimeStatus))
	assert.NoError(t, AssertRealtimeAllowed(RealtimeJogKeep))

	for _, ch := range []byte{RealtimeHold, RealtimeResume, RealtimeSoftReset, 'x'} {
		assert.ErrorIs(t, AssertRealtimeAllowed(ch), ErrMotionNotAuthorised)
	}
}

func TestEmptyCommandIsNotMotion(t *testing.T) {
	assert.False(t, IsMotionCommand(""))
	assert.False(t, IsMotionCommand("   "))
}
