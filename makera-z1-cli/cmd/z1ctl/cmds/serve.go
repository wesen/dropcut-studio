package cmds

import (
	"context"
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
	Addr string `glazed:"addr"`
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
		cmds.WithLong(`Serve a browser page showing live machine telemetry.

The page is READ-ONLY. Every endpoint is a GET and none of them can move the
machine: it shows position, spindle and feed, job progress, the file listing,
preflight checks and the raw status report. Motion controls are rendered but
disabled, with the reason stated in the page.

The machine accepts exactly one TCP connection, so this server holds a single
session and serialises every request onto it. Several browser tabs share that
one connection rather than competing for it — but while this server runs,
Makera's own controller cannot connect.

Examples:
  z1ctl serve
  z1ctl serve --addr :9090 --device 192.168.0.55`),
		cmds.WithFlags(
			fields.New("addr", fields.TypeString,
				fields.WithDefault(":8080"),
				fields.WithHelp("Listen address")),
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

	server := webui.New(opts, log.Logger)
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
	fmt.Fprintf(os.Stderr, "z1ctl: read-only — this page cannot move the machine\n")

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
