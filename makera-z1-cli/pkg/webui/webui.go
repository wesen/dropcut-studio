// Package webui serves the hardware control page.
//
// Since MZ1-003 the page can MOVE THE MACHINE: manual jog, homing, spindle,
// accessories, work-zeroing and job control, on top of the original
// telemetry. The mutation surface and its guards live in motion.go; the rule
// throughout is that the browser is never trusted — every motion route
// preflights the machine fresh, and every control the page disables carries
// the reason, because a control that looks operable and silently does nothing
// is worse than one that explains itself.
//
// The machine accepts exactly one TCP connection, so this server holds a single
// session and serialises every request onto it. Two browser tabs share one
// connection rather than fighting for it.
package webui

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/errors"
	"github.com/rs/zerolog"

	"github.com/go-go-golems/makera-z1-cli/pkg/makera"
)

//go:embed static
var staticFS embed.FS

// Server owns the single machine session shared by all browser clients.
type Server struct {
	opts   makera.Options
	logger zerolog.Logger
	cfg    Config

	mu     sync.Mutex
	client *makera.Client
	info   makera.MachineInfo

	// motionBusy enforces one motion request in flight; overlap answers 409.
	motionBusy atomic.Bool

	// jog is the active continuous-jog session, if any. Its keepalives are
	// browser-driven (see motion.go); the server never emits one on a timer.
	jogMu sync.Mutex
	jog   *makera.JogSession

	cacheMu   sync.RWMutex
	lastFiles []makera.DirEntry
	filesAt   time.Time
	filesDir  string
}

// New builds a server bound to one machine address.
func New(opts makera.Options, logger zerolog.Logger, cfg Config) *Server {
	return &Server{opts: opts, logger: logger, cfg: cfg}
}

// Handler builds the HTTP routes.
//
// Static assets are served under /static/ rather than at the document root, so
// an asset name can never collide with an API route.
func (s *Server) Handler() (http.Handler, error) {
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		return nil, errors.Wrap(err, "open embedded assets")
	}
	mux := http.NewServeMux()
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServerFS(sub)))
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		page, err := staticFS.ReadFile("static/index.html")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(page)
	})
	mux.HandleFunc("GET /api/status", s.handleStatus)
	mux.HandleFunc("GET /api/info", s.handleInfo)
	mux.HandleFunc("GET /api/files", s.handleFiles)
	mux.HandleFunc("GET /api/doctor", s.handleDoctor)

	// Mutating routes: every one passes guardMutation; every motion-class one
	// preflights server-side regardless of what the page believes.
	mux.HandleFunc("POST /api/jog", s.mutating(s.handleJogStep))
	mux.HandleFunc("POST /api/jog/start", s.mutating(s.handleJogStart))
	mux.HandleFunc("POST /api/jog/keep", s.mutating(s.handleJogKeep))
	mux.HandleFunc("POST /api/jog/stop", s.mutating(s.handleJogStop))
	mux.HandleFunc("POST /api/home", s.mutating(s.handleHome))
	mux.HandleFunc("POST /api/spindle", s.mutating(s.handleSpindle))
	mux.HandleFunc("POST /api/accessory", s.mutating(s.handleAccessory))
	mux.HandleFunc("POST /api/wcs/zero", s.mutating(s.handleWcsZero))
	mux.HandleFunc("POST /api/job/play", s.mutating(s.handleJobPlay))
	mux.HandleFunc("POST /api/job/suspend", s.mutating(s.handleJobSuspend))
	mux.HandleFunc("POST /api/job/resume", s.mutating(s.handleJobResume))
	mux.HandleFunc("POST /api/job/abort", s.mutating(s.handleJobAbort))
	mux.HandleFunc("POST /api/unlock", s.mutating(s.handleUnlock))
	mux.HandleFunc("POST /api/hold", s.mutating(s.handleHold))
	mux.HandleFunc("POST /api/cycle-start", s.mutating(s.handleCycleStart))
	return mux, nil
}

// Close releases the machine session.
func (s *Server) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropLocked()
}

func (s *Server) dropLocked() {
	// A dying session takes any active jog's bookkeeping with it. The axis is
	// safe regardless: keepalives cannot reach a dead connection, so the
	// firmware's dead-man stops it (review §6.5).
	s.clearJogLocked()
	if s.client != nil {
		_ = s.client.Close()
		s.client = nil
	}
}

// session returns the shared client, dialling if needed. The caller holds s.mu.
func (s *Server) sessionLocked(ctx context.Context) (*makera.Client, error) {
	if s.client != nil {
		return s.client, nil
	}
	client, err := makera.Dial(ctx, s.opts)
	if err != nil {
		return nil, err
	}
	s.client = client
	if info, err := client.Identify(ctx); err == nil {
		s.info = info
	}
	return client, nil
}

// withClient serialises access to the single machine connection and drops the
// session on error so the next request reconnects.
func (s *Server) withClient(ctx context.Context, fn func(*makera.Client) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	client, err := s.sessionLocked(ctx)
	if err != nil {
		return err
	}
	if err := fn(client); err != nil {
		s.dropLocked()
		return err
	}
	return nil
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{
		"error":     err.Error(),
		"connected": false,
	})
}

type statusPayload struct {
	Connected bool   `json:"connected"`
	State     string `json:"state"`
	// Homed is the legacy heuristic (position != -1,-1,-1) and is advisory:
	// stock firmware never reports homing, and -1,-1,-1 is both the boot
	// position and the post-homing rest position. AtRest carries the honest
	// signal for the page's wording.
	Homed   bool             `json:"homed"`
	AtRest  bool             `json:"at_rest"`
	Machine [5]float64       `json:"machine"`
	Work    [5]float64       `json:"work"`
	Feed    makera.Rate      `json:"feed"`
	Spindle makera.Rate      `json:"spindle"`
	Tool    int              `json:"tool"`
	TLO     float64          `json:"tlo"`
	Playing *makera.Playback `json:"playing"`
	Drops   int              `json:"drops"`
	Raw     string           `json:"raw"`
	At      string           `json:"at"`
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	var out statusPayload
	err := s.withClient(ctx, func(c *makera.Client) error {
		st, err := c.QueryStatus(ctx)
		if err != nil {
			return err
		}
		out = statusPayload{
			Connected: true,
			State:     st.State,
			Homed:     st.Homed,
			Machine:   [5]float64{st.Machine.X, st.Machine.Y, st.Machine.Z, st.Machine.A, st.Machine.B},
			Work:      [5]float64{st.Work.X, st.Work.Y, st.Work.Z, st.Work.A, st.Work.B},
			Feed:      st.Feed,
			Spindle:   st.Spindle,
			Tool:      st.Tool,
			TLO:       st.ToolLengthOffset,
			Playing:   st.Playing,
			Drops:     c.Drops(),
			At:        time.Now().Format(time.RFC3339),
		}
		if st.Raw != nil {
			out.Raw = st.Raw.Raw
		}
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	var info makera.MachineInfo
	err := s.withClient(ctx, func(c *makera.Client) error {
		if s.info.Model != "" {
			info = s.info
			return nil
		}
		got, err := c.Identify(ctx)
		if err != nil {
			return err
		}
		s.info, info = got, got
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"connected":                  true,
		"model":                      info.Model,
		"model_id":                   info.ModelID,
		"func_setting":               info.FuncSetting,
		"version":                    info.Version,
		"community_firmware":         info.Community,
		"file_types":                 info.FileTypes,
		"accepts_compressed_uploads": info.AcceptsCompressedUploads(),
		"clock_epoch":                info.ClockEpoch,
		"protocol":                   info.Protocol,
		"address":                    s.opts.Address,
	})
}

func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request) {
	dir := r.URL.Query().Get("dir")
	if dir == "" {
		dir = "/sd/gcodes"
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	// Listings are slow and rarely change; serve a short-lived cache so the
	// page can poll status quickly without a directory read on every tick.
	s.cacheMu.RLock()
	fresh := s.filesDir == dir && time.Since(s.filesAt) < 15*time.Second
	cached := s.lastFiles
	s.cacheMu.RUnlock()
	if fresh {
		writeJSON(w, http.StatusOK, map[string]any{"connected": true, "dir": dir, "files": cached, "cached": true})
		return
	}

	var entries []makera.DirEntry
	err := s.withClient(ctx, func(c *makera.Client) error {
		cmd := makera.EscapeLine("ls -e -s " + makera.EscapePath(dir))
		lines, err := c.CommandText(ctx, cmd)
		if err != nil {
			return err
		}
		entries = makera.ParseListing(lines)
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	s.cacheMu.Lock()
	s.lastFiles, s.filesAt, s.filesDir = entries, time.Now(), dir
	s.cacheMu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{"connected": true, "dir": dir, "files": entries})
}

type checkPayload struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail"`
}

func (s *Server) handleDoctor(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	var checks []checkPayload
	err := s.withClient(ctx, func(c *makera.Client) error {
		st, err := c.QueryStatus(ctx)
		if err != nil {
			return err
		}
		checks = append(checks, checkPayload{"machine state", statusOf(st.State == "Idle"), st.State})
		checks = append(checks, checkPayload{"homing", pick(st.AtRestPosition, "unknown", "ok"),
			pick(st.AtRestPosition,
				"position is -1,-1,-1: parked at home OR never homed — stock firmware cannot say; home first if unsure",
				"position has moved since boot or homing")})

		d, err := c.QueryDiagnose(ctx)
		if err != nil {
			return err
		}
		checks = append(checks, checkPayload{"emergency stop", statusOf(!d.EStop),
			pick(!d.EStop, "clear", "engaged")})
		checks = append(checks, checkPayload{"wifi signal", "ok", itoa(d.RSSI) + " dBm"})

		if closed, known := d.CoverClosed(); !known {
			checks = append(checks, checkPayload{"cover", "unknown",
				"machine sent " + itoa(len(d.Endstops)) + " endstop fields, fewer than the mapping needs"})
		} else if closed {
			checks = append(checks, checkPayload{"cover", "ok", "closed"})
		} else {
			checks = append(checks, checkPayload{"cover", "warn", "OPEN — motion must not start"})
		}
		if d.ToolSetter {
			checks = append(checks, checkPayload{"tool setter", "warn", "triggered"})
		}
		checks = append(checks, checkPayload{"frame decoding", statusOf(c.Drops() == 0),
			pick(c.Drops() == 0, "no dropped frames", itoa(c.Drops())+" frames dropped")})
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"connected": true, "checks": checks})
}

func statusOf(ok bool) string { return pick(ok, "ok", "warn") }

func pick(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}
