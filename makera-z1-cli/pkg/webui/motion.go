// Motion routes for the control page.
//
// Design rules (MZ1-003 §12–13, as amended by the implementation review):
//
//   - Every request that can change machine state is guarded: Host validation
//     (DNS rebinding), same-origin checks, and — when the server is reachable
//     beyond loopback — a bearer token. The BROWSER IS NOT TRUSTED to have
//     checked anything: every motion route preflights server-side, fresh.
//   - One motion request in flight at a time; overlap answers 409. Requests
//     are never queued: a queue of moves the operator can no longer cancel is
//     the opposite of manual control.
//   - Continuous jog forwards keepalives 1:1: the browser's held button POSTs
//     /api/jog/keep every ~200ms and each becomes exactly one ?+0x1A write.
//     There is NO server timer that keeps motion alive — when the POSTs stop
//     (released button, hidden tab, crashed browser, unplugged laptop), the
//     firmware's own dead-man stops the axis. The server keeps only enough
//     state to refuse a second jog and to run the polite 0x19/^Y handshake.
//   - Stop routes (hold, jog/stop, job/suspend, job/abort) skip the machine-
//     state gates entirely — a stop that can be refused is not a stop. They
//     still pass the HTTP security checks: authentication is not gating.
package webui

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/go-go-golems/makera-z1-cli/pkg/makera"
)

// Config is the security posture, decided by the serve command.
type Config struct {
	// Token is required on mutating routes when EnforceToken is set. Always
	// minted so the operator can turn enforcement on without restarting.
	Token string
	// EnforceToken is set when the server is reachable beyond loopback.
	EnforceToken bool
}

// guardMutation runs the HTTP-layer checks every mutating route needs. It
// returns false after writing the refusal.
func (s *Server) guardMutation(w http.ResponseWriter, r *http.Request) bool {
	// Host validation. A page on evil.example that re-resolves its hostname
	// to 127.0.0.1 sends its own name in Host; a legitimate browser sends
	// ours. When token enforcement is on, the token is the stronger check and
	// the host may legitimately be any LAN name.
	if !s.cfg.EnforceToken {
		host := r.Host
		if h, _, err := net.SplitHostPort(r.Host); err == nil {
			host = h
		}
		if !isLoopbackName(host) {
			writeJSON(w, http.StatusForbidden, map[string]any{
				"error": "refused: unrecognised Host header (DNS rebinding defence); use http://127.0.0.1"})
			return false
		}
	}

	// Same-origin. Origin is present on all cross-origin fetches; when it is
	// there, it must name us. Sec-Fetch-Site, when present, must agree.
	if origin := r.Header.Get("Origin"); origin != "" && origin != "null" {
		if !strings.HasSuffix(origin, "//"+r.Host) {
			writeJSON(w, http.StatusForbidden, map[string]any{
				"error": "refused: cross-origin request on a mutating route"})
			return false
		}
	}
	if sfs := r.Header.Get("Sec-Fetch-Site"); sfs != "" && sfs != "same-origin" && sfs != "none" {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error": "refused: cross-site request on a mutating route"})
		return false
	}

	if s.cfg.EnforceToken && r.Header.Get("X-Z1-Token") != s.cfg.Token {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"error": "refused: missing or wrong X-Z1-Token (printed by z1ctl serve at startup)"})
		return false
	}
	return true
}

func isLoopbackName(host string) bool {
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// mutating wraps a handler with the security checks and method enforcement.
func (s *Server) mutating(fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.guardMutation(w, r) {
			return
		}
		fn(w, r)
	}
}

func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request body: " + err.Error()})
		return false
	}
	return true
}

// runMotion executes one motion request with the single-flight rule.
func (s *Server) runMotion(w http.ResponseWriter, r *http.Request, req makera.MotionRequest, opts makera.PreflightOptions) {
	if !s.motionBusy.CompareAndSwap(false, true) {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "a motion request is already in flight; requests are never queued"})
		return
	}
	defer s.motionBusy.Store(false)

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	var res makera.MotionResult
	err := s.withClient(ctx, func(c *makera.Client) error {
		var err error
		res, err = c.Motion(ctx, req, opts)
		return err
	})
	if err != nil {
		code := http.StatusServiceUnavailable
		if strings.Contains(err.Error(), "preflight failed") || strings.Contains(err.Error(), "refusing") {
			code = http.StatusPreconditionFailed
		}
		writeJSON(w, code, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"sent":        res.Sent,
		"state_after": res.StateAfter.State,
	})
}

// ---------------------------------------------------------------------------
// Step motion routes
// ---------------------------------------------------------------------------

type jogStepBody struct {
	Axis     string  `json:"axis"`
	Distance float64 `json:"distance"`
	// SpeedScale is a fraction of the axis maximum (0-1), valid on both
	// firmware dialects; FeedMMMin is community-firmware only. See
	// makera.JogSpeed for the dialect table.
	SpeedScale     float64 `json:"speed_scale"`
	FeedMMMin      float64 `json:"feed_mm_min"`
	AllowOpenCover bool    `json:"allow_open_cover"`
}

func (s *Server) handleJogStep(w http.ResponseWriter, r *http.Request) {
	var b jogStepBody
	if !decodeBody(w, r, &b) {
		return
	}
	axis, err := makera.ParseAxis(b.Axis)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	op, err := makera.StepJog(axis, b.Distance, makera.JogSpeed{Scale: b.SpeedScale, FeedMMMin: b.FeedMMMin})
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	s.runMotion(w, r, makera.MotionRequest{
		Ops:    []makera.MotionOp{op},
		Reason: "operator step jog from control page",
	}, makera.PreflightOptions{AllowOpenCover: b.AllowOpenCover})
}

type homeBody struct {
	Confirm bool `json:"confirm"`
}

func (s *Server) handleHome(w http.ResponseWriter, r *http.Request) {
	var b homeBody
	if !decodeBody(w, r, &b) {
		return
	}
	if !b.Confirm {
		writeJSON(w, http.StatusPreconditionFailed, map[string]any{
			"error": "refused: homing moves ALL axes at speed and needs the two-step confirmation"})
		return
	}
	s.runMotion(w, r, makera.MotionRequest{
		Ops:    []makera.MotionOp{makera.Home()},
		Reason: "operator homing from control page",
	}, makera.PreflightOptions{})
}

type spindleBody struct {
	On      bool `json:"on"`
	RPM     int  `json:"rpm"`
	Confirm bool `json:"confirm"`
}

func (s *Server) handleSpindle(w http.ResponseWriter, r *http.Request) {
	var b spindleBody
	if !decodeBody(w, r, &b) {
		return
	}
	var op makera.MotionOp
	if b.On {
		if !b.Confirm {
			writeJSON(w, http.StatusPreconditionFailed, map[string]any{
				"error": "refused: starting the spindle needs the two-step confirmation"})
			return
		}
		var err error
		if op, err = makera.SpindleOn(b.RPM); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
	} else {
		op = makera.SpindleOff() // a stop; no confirmation
	}
	s.runMotion(w, r, makera.MotionRequest{
		Ops:    []makera.MotionOp{op},
		Reason: "operator spindle toggle from control page",
	}, makera.PreflightOptions{})
}

type accessoryBody struct {
	Name  string `json:"name"`
	On    bool   `json:"on"`
	Power int    `json:"power"`
}

func (s *Server) handleAccessory(w http.ResponseWriter, r *http.Request) {
	var b accessoryBody
	if !decodeBody(w, r, &b) {
		return
	}
	op, err := makera.Accessory(makera.AccessoryName(b.Name), b.On, b.Power)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	s.runMotion(w, r, makera.MotionRequest{
		Ops:    []makera.MotionOp{op},
		Reason: "operator accessory toggle from control page",
	}, makera.PreflightOptions{})
}

type zeroBody struct {
	Axes    []string `json:"axes"`
	System  int      `json:"system"` // 1..6 → G54..G59
	Confirm bool     `json:"confirm"`
}

func (s *Server) handleWcsZero(w http.ResponseWriter, r *http.Request) {
	var b zeroBody
	if !decodeBody(w, r, &b) {
		return
	}
	if !b.Confirm {
		writeJSON(w, http.StatusPreconditionFailed, map[string]any{
			"error": "refused: re-zeroing silently invalidates a correct program; confirm it"})
		return
	}
	axes := make([]makera.Axis, 0, len(b.Axes))
	for _, a := range b.Axes {
		ax, err := makera.ParseAxis(a)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		axes = append(axes, ax)
	}
	op, err := makera.ZeroWorkOffset(b.System, axes)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	s.runMotion(w, r, makera.MotionRequest{
		Ops:    []makera.MotionOp{op},
		Reason: "operator work-zero from control page",
	}, makera.PreflightOptions{})
}

// ---------------------------------------------------------------------------
// Continuous jog: browser-held dead-man
// ---------------------------------------------------------------------------

type jogStartBody struct {
	Axis           string  `json:"axis"`
	Positive       bool    `json:"positive"`
	SpeedScale     float64 `json:"speed_scale"`
	FeedMMMin      float64 `json:"feed_mm_min"`
	AllowOpenCover bool    `json:"allow_open_cover"`
}

func (s *Server) handleJogStart(w http.ResponseWriter, r *http.Request) {
	var b jogStartBody
	if !decodeBody(w, r, &b) {
		return
	}
	axis, err := makera.ParseAxis(b.Axis)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}

	s.jogMu.Lock()
	defer s.jogMu.Unlock()
	if s.jog != nil {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "a jog is already active; jogs are never queued"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	var session *makera.JogSession
	err = s.withClient(ctx, func(c *makera.Client) error {
		var err error
		session, err = c.JogStartManual(ctx, axis, b.Positive, makera.JogSpeed{Scale: b.SpeedScale, FeedMMMin: b.FeedMMMin},
			makera.PreflightOptions{AllowOpenCover: b.AllowOpenCover})
		return err
	})
	if err != nil {
		code := http.StatusServiceUnavailable
		if strings.Contains(err.Error(), "preflight failed") {
			code = http.StatusPreconditionFailed
		}
		writeJSON(w, code, map[string]any{"error": err.Error()})
		return
	}
	s.jog = session
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true,
		"note": "keepalive contract: POST /api/jog/keep every ~200ms while held; " +
			"stopping the posts stops the machine by the firmware's own dead-man",
	})
}

func (s *Server) handleJogKeep(w http.ResponseWriter, r *http.Request) {
	s.jogMu.Lock()
	session := s.jog
	s.jogMu.Unlock()
	if session == nil {
		writeJSON(w, http.StatusGone, map[string]any{"error": "no jog is active"})
		return
	}
	if err := session.Keepalive(); err != nil {
		writeJSON(w, http.StatusGone, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleJogStop(w http.ResponseWriter, r *http.Request) {
	s.jogMu.Lock()
	session := s.jog
	s.jog = nil
	s.jogMu.Unlock()
	if session == nil {
		// Nothing to stop is a success for a stop.
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "note": "no jog was active"})
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := session.Stop(ctx); err != nil {
		// The stop HAPPENED the moment keepalives ceased; only the polite
		// acknowledgement is missing. Say so rather than alarming the operator.
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ack": false, "note": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ack": true})
}

// clearJogLocked drops jog bookkeeping when the machine session dies. The
// axis is already stopping — no keepalives can reach a dead connection, and
// the firmware's dead-man does the rest. Caller holds s.mu.
func (s *Server) clearJogLocked() {
	s.jogMu.Lock()
	s.jog = nil
	s.jogMu.Unlock()
}

// ---------------------------------------------------------------------------
// Job lifecycle and stops
// ---------------------------------------------------------------------------

func (s *Server) handleHold(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	err := s.withClient(ctx, func(c *makera.Client) error { return c.FeedHold() })
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type playBody struct {
	Path    string `json:"path"`
	Confirm bool   `json:"confirm"`
}

func (s *Server) handleJobPlay(w http.ResponseWriter, r *http.Request) {
	var b playBody
	if !decodeBody(w, r, &b) {
		return
	}
	if !b.Confirm {
		writeJSON(w, http.StatusPreconditionFailed, map[string]any{
			"error": "refused: playing a program is unbounded motion; confirm it"})
		return
	}
	op, err := makera.PlayFile(b.Path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	s.runMotion(w, r, makera.MotionRequest{
		Ops:    []makera.MotionOp{op},
		Reason: "operator play from control page: " + b.Path,
	}, makera.PreflightOptions{})
}

func (s *Server) handleJobSuspend(w http.ResponseWriter, r *http.Request) {
	s.simpleJobAction(w, r, func(ctx context.Context, c *makera.Client) error {
		_, err := c.Suspend(ctx)
		return err
	})
}

func (s *Server) handleJobAbort(w http.ResponseWriter, r *http.Request) {
	s.simpleJobAction(w, r, func(ctx context.Context, c *makera.Client) error {
		_, err := c.Abort(ctx)
		return err
	})
}

type cycleStartBody struct {
	Confirm bool `json:"confirm"`
}

// handleCycleStart releases a feed hold: the realtime `~`. Class 2 — the
// frozen motion resumes and every command queued behind the hold executes
// immediately, which is why it takes a confirmation while the hold itself
// never does.
func (s *Server) handleCycleStart(w http.ResponseWriter, r *http.Request) {
	var b cycleStartBody
	if !decodeBody(w, r, &b) {
		return
	}
	if !b.Confirm {
		writeJSON(w, http.StatusPreconditionFailed, map[string]any{
			"error": "refused: releasing a hold restarts the frozen motion and runs the queued commands; confirm it"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	err := s.withClient(ctx, func(c *makera.Client) error { return c.CycleStart() })
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type resumeBody struct {
	Confirm bool `json:"confirm"`
}

func (s *Server) handleJobResume(w http.ResponseWriter, r *http.Request) {
	var b resumeBody
	if !decodeBody(w, r, &b) {
		return
	}
	if !b.Confirm {
		writeJSON(w, http.StatusPreconditionFailed, map[string]any{
			"error": "refused: resume restarts motion that was deliberately stopped; confirm it"})
		return
	}
	s.simpleJobAction(w, r, func(ctx context.Context, c *makera.Client) error {
		_, err := c.Resume(ctx, makera.PreflightOptions{})
		return err
	})
}

func (s *Server) simpleJobAction(w http.ResponseWriter, r *http.Request, fn func(context.Context, *makera.Client) error) {
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	err := s.withClient(ctx, func(c *makera.Client) error { return fn(ctx, c) })
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type unlockBody struct {
	Confirm        bool `json:"confirm"`
	AllowOpenCover bool `json:"allow_open_cover"`
}

func (s *Server) handleUnlock(w http.ResponseWriter, r *http.Request) {
	var b unlockBody
	if !decodeBody(w, r, &b) {
		return
	}
	if !b.Confirm {
		writeJSON(w, http.StatusPreconditionFailed, map[string]any{
			"error": "refused: unlock re-enables motion; read the halt reason first, then confirm"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	var result map[string]any
	err := s.withClient(ctx, func(c *makera.Client) error {
		before, err := c.QueryStatus(ctx)
		if err != nil {
			return err
		}
		if before.State != "Alarm" {
			result = map[string]any{"error": "machine is " + before.State + ", not in Alarm — nothing to clear"}
			return nil
		}
		d, err := c.QueryDiagnose(ctx)
		if err != nil {
			return err
		}
		if d.EStop {
			result = map[string]any{"error": "emergency stop is engaged — release it first"}
			return nil
		}
		if !b.AllowOpenCover {
			if closed, known := d.CoverClosed(); !known || !closed {
				result = map[string]any{"error": "cover is open or unknowable; close it first"}
				return nil
			}
		}
		text, recovery, _ := makera.HaltReason(before.HaltReason)
		if recovery != makera.RecoveryUnlock {
			result = map[string]any{"error": "halt reason " + text + " needs a " + recovery.String() + ", not an unlock"}
			return nil
		}
		if _, err := c.Unlock(ctx); err != nil {
			return err
		}
		// Settle: re-read, never re-send.
		deadline := time.Now().Add(4 * time.Second)
		state := before.State
		for time.Now().Before(deadline) {
			st, err := c.QueryStatus(ctx)
			if err != nil {
				return err
			}
			state = st.State
			if state != "Alarm" {
				break
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(300 * time.Millisecond):
			}
		}
		result = map[string]any{"ok": state != "Alarm", "state_after": state, "halt_was": text}
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, refused := result["error"]; refused {
		writeJSON(w, http.StatusPreconditionFailed, result)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
