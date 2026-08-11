// SPDX-License-Identifier: GPL-2.0-only

//go:build unix

package makera

import (
	"syscall"

	"golang.org/x/sys/unix"
)

// reusePort sets SO_REUSEADDR so discovery can bind :3333 alongside another
// listener. It does not guarantee success — a controller holding the port
// exclusively will still win.
func reusePort(_, _ string, c syscall.RawConn) error {
	var sockErr error
	err := c.Control(func(fd uintptr) {
		sockErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEADDR, 1)
	})
	if err != nil {
		return err
	}
	return sockErr
}
