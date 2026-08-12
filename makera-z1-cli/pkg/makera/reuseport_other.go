//go:build !unix

package makera

import "syscall"

// reusePort is a no-op on platforms without the unix socket option package.
func reusePort(_, _ string, _ syscall.RawConn) error { return nil }
