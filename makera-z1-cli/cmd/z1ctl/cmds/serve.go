package cmds

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
	"github.com/rs/zerolog/log"

	"github.com/go-go-golems/makera-z1-cli/pkg/webui"
)

// ServeCommand runs the hardware control web page.
type ServeCommand struct{ *cmds.CommandDescription }

type serveSettings struct {
	Addr        string `glazed:"addr"`
	AllowRemote bool   `glazed:"allow-remote"`
	Token       string `glazed:"token"`
}

var _ cmds.BareCommand = &ServeCommand{}

func NewServeCommand() (*ServeCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &ServeCommand{cmds.NewCommandDescription(
		"serve",
		cmds.WithShort("Serve the hardware control web page"),
		cmds.WithLong(`Serve the browser control page: live telemetry, manual jog,
homing, spindle and accessories, work-zeroing, and job control.

THIS PAGE CAN MOVE THE MACHINE, so the server defaults to loopback only
(127.0.0.1:8080). An unauthenticated POST from the LAN would otherwise be a
motion command — the machine itself has no authentication, and this server
must not widen that. To reach it from a tablet on the shop network:

  z1ctl serve --addr :8080 --allow-remote

which requires the X-Z1-Token header on every mutating request; the token is
printed at startup and embedded in the page link. Same-origin and Host
checks apply in every mode.

Every motion route preflights on the machine, fresh, no matter what the page
claims to have checked. Stops — hold, jog stop, suspend, abort — are never
gated by machine state. Continuous jog keepalives are browser-held: when the
page stops posting them (released button, hidden tab, crash), the firmware's
own dead-man stops the axis.

The machine accepts exactly one TCP connection; this server holds it, and
Makera's own controller cannot connect while it runs.

Examples:
  z1ctl serve
  z1ctl serve --addr 127.0.0.1:9090 --device 192.168.0.55
  z1ctl serve --addr :8080 --allow-remote`),
		cmds.WithFlags(
			fields.New("addr", fields.TypeString,
				fields.WithDefault("127.0.0.1:8080"),
				fields.WithHelp("Listen address. Non-loopback requires --allow-remote")),
			fields.New("allow-remote", fields.TypeBool,
				fields.WithDefault(false),
				fields.WithHelp("Permit a non-loopback bind; enforces the startup token on mutating routes")),
			fields.New("token", fields.TypeString,
				fields.WithDefault(""),
				fields.WithHelp("Fix the mutation token instead of minting one at startup")),
		),
		cmds.WithSections(conn),
	)}, nil
}

func (c *ServeCommand) Run(ctx context.Context, vals *values.Values) error {
	s := &serveSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return err
	}
	conn, err := DecodeConnection(vals)
	if err != nil {
		return err
	}
	opts, err := conn.Resolve(ctx)
	if err != nil {
		return err
	}

	loopback, err := isLoopbackAddr(s.Addr)
	if err != nil {
		return err
	}
	if !loopback && !s.AllowRemote {
		return fmt.Errorf(
			"refusing to bind %q: this page can move the machine, and a non-loopback bind exposes that to the network. Pass --allow-remote to accept that deliberately",
			s.Addr)
	}

	token := s.Token
	if token == "" {
		raw := make([]byte, 16)
		if _, err := rand.Read(raw); err != nil {
			return err
		}
		token = hex.EncodeToString(raw)
	}

	server := webui.New(opts, log.Logger, webui.Config{
		Token:        token,
		EnforceToken: !loopback,
	})
	defer server.Close()

	handler, err := server.Handler()
	if err != nil {
		return err
	}

	ln, err := net.Listen("tcp", s.Addr)
	if err != nil {
		return err
	}
	httpServer := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	fmt.Fprintf(os.Stderr, "z1ctl: serving hardware control for %s on http://%s\n",
		opts.Address, ln.Addr())
	if loopback {
		fmt.Fprintf(os.Stderr, "z1ctl: loopback only — this page CAN move the machine\n")
	} else {
		fmt.Fprintf(os.Stderr, "z1ctl: WARNING: reachable beyond this host and this page CAN move the machine\n")
		fmt.Fprintf(os.Stderr, "z1ctl: mutating requests require the token: open http://%s/?token=%s\n",
			ln.Addr(), token)
	}
	fmt.Fprintf(os.Stderr, "z1ctl: the machine's PHYSICAL emergency stop is the real one\n")

	// Shut down cleanly so the machine's single connection slot is released
	// rather than left to time out.
	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() { errCh <- httpServer.Serve(ln) }()

	select {
	case <-sigCtx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return httpServer.Shutdown(shutdownCtx)
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

// isLoopbackAddr reports whether a listen address binds loopback only.
func isLoopbackAddr(addr string) (bool, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false, fmt.Errorf("listen address %q: %w", addr, err)
	}
	if host == "" {
		return false, nil // ":8080" binds every interface
	}
	if host == "localhost" {
		return true, nil
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback(), nil
	}
	return false, nil
}
