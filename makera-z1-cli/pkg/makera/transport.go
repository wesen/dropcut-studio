package makera

import (
	"context"
	"net"
	"strings"
	"syscall"
	"time"

	"github.com/pkg/errors"
)

// DefaultTCPPort is the machine's control port. It accepts exactly one client
// at a time; a refused connection usually means another controller has it.
const DefaultTCPPort = "2222"

// Transport carries raw bytes to and from a machine. It knows nothing about
// framing.
type Transport interface {
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	Close() error
	// BlockSize is the file-transfer block size for this link: 8192 over
	// Wi-Fi, 128 over serial.
	BlockSize() int
	// Describe returns a human-readable address for logs.
	Describe() string
}

// ErrMachineBusy is returned when the machine actively refuses the connection.
// On this hardware that USUALLY means another client holds the single
// available slot — but a refusal is only evidence, not proof: a wrong address
// refuses too, so the message says "likely" rather than asserting it.
var ErrMachineBusy = errors.New("if this is the machine and it is on, another controller likely holds its single connection slot")

// TCPTransport is the Wi-Fi link.
type TCPTransport struct {
	conn    net.Conn
	addr    string
	timeout time.Duration
}

var _ Transport = &TCPTransport{}

// DialTCP connects to host[:port], defaulting the port to 2222.
func DialTCP(ctx context.Context, addr string, connectTimeout, readTimeout time.Duration) (*TCPTransport, error) {
	if !strings.Contains(addr, ":") {
		addr = net.JoinHostPort(addr, DefaultTCPPort)
	}
	d := net.Dialer{Timeout: connectTimeout}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		// Only an active refusal suggests the single connection slot is
		// taken — and even that is a likelihood, not a certainty (a host
		// that is not the machine also refuses). Timeouts and unreachable
		// hosts are just that, and labelling them "busy" sends the operator
		// hunting for a controller that is not running.
		if errors.Is(err, syscall.ECONNREFUSED) {
			return nil, errors.Wrapf(ErrMachineBusy, "dial %s: %v", addr, err)
		}
		return nil, errors.Wrapf(err, "dial %s", addr)
	}
	return &TCPTransport{conn: conn, addr: addr, timeout: readTimeout}, nil
}

func (t *TCPTransport) Read(p []byte) (int, error) {
	if t.timeout > 0 {
		_ = t.conn.SetReadDeadline(time.Now().Add(t.timeout))
	}
	return t.conn.Read(p)
}

func (t *TCPTransport) Write(p []byte) (int, error) {
	if t.timeout > 0 {
		_ = t.conn.SetWriteDeadline(time.Now().Add(t.timeout))
	}
	return t.conn.Write(p)
}

func (t *TCPTransport) Close() error     { return t.conn.Close() }
func (t *TCPTransport) BlockSize() int   { return 8192 }
func (t *TCPTransport) Describe() string { return t.addr }

// IsTimeout reports whether an error is a read/write deadline expiry rather
// than a real failure. The read loop treats timeouts as "nothing yet".
func IsTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}
