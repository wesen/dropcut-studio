package makera

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/errors"
)

// Motion: the authorised path.
//
// This file implements MZ1-003 §10 with the amendments from the ticket's
// implementation review (§7.1–7.3): motion is expressed as typed operations
// whose G-code is rendered INSIDE this package, never accepted as text. The
// render and class methods are unexported, so no code outside pkg/makera can
// smuggle a string into a MotionRequest — the generic text path (`z1ctl exec`)
// structurally cannot produce motion.
//
// The rules, enumerated so a reviewer can check each:
//
//   - Motion is never retried. Re-sending a G0 after a timeout can execute the
//     move twice.
//   - Motion is never issued from a retry path, a reconnect path, or as a side
//     effect of a query.
//   - The risk class of a request is the MAXIMUM class of its operations, and
//     the caller cannot lower it.
//   - A composite stops at the first failed step.
//   - Stopping is never gated: JogSession.Stop and FeedHold work in any state.

// safeZMachineCoord is the machine-coordinate Z used for retracts before XY
// moves. The Z1's own pack-position file (read off the machine in MZ1-001)
// uses -3; the reference controller uses -2 with a comment about X-sag
// compensation approaching a millimetre. We follow the machine's own file.
const safeZMachineCoord = -3.0

// Parameter sanity bounds. These are NOT an envelope model — the firmware owns
// soft limits. They exist to catch unit mistakes (a jog of 4000 was probably
// meant in some other unit) before a byte reaches the socket.
const (
	maxJogDistanceMM = 1000
	maxSpindleRPM    = 20000
)

// Jog speed is a PERCENTAGE OF THE AXIS MAXIMUM, not a feedrate.
//
// Measured on hardware (2026-08-11): step jogs at F1, F10, F300 and F1000 all
// ran at identical, maximum speed. The stock firmware source explains why —
// SimpleShell::jog reads F as a scale of max_rate:
//
//	usage: $J X0.01 [F0.5] - axis can be XYZABC, optional speed is scale of max_rate
//	THEROBOT->delta_move(delta, rate_mm_s*scale, n_motors);
//	(MZ1-003/vendor/stock-carvera-firmware/src/modules/utils/simpleshell/SimpleShell.cpp)
//
// so every value >= 1 means "at least max" and the planner clamps it. The
// community firmware CHANGED this: there F is mm/min (divided by 60) and the
// scale moved to an S word. The reference controller sends mm/min values,
// which on stock firmware silently all mean "max speed" — do not copy it.
//
// A percentage of max is therefore the one honest unit for this machine, and
// it renders as the fraction stock firmware expects. If community-firmware
// support is ever needed, emit `S<fraction>` there instead — its meaning
// matches — never `F<fraction>`, which community reads as mm/min.
func renderJogSpeed(pct float64) string {
	if pct <= 0 || pct >= 100 {
		return "" // omit: firmware default is the axis maximum
	}
	return " F" + num(pct/100)
}

func checkSpeedPct(pct float64) error {
	if pct < 0 || pct > 100 {
		return errors.Errorf("jog speed %v%% outside [0, 100] (percent of the axis maximum; 0 = maximum)", pct)
	}
	return nil
}

// Axis is one of the machine's five axes.
type Axis byte

const (
	AxisX Axis = 'X'
	AxisY Axis = 'Y'
	AxisZ Axis = 'Z'
	AxisA Axis = 'A'
	AxisB Axis = 'B'
)

// ParseAxis accepts an axis letter in either case.
func ParseAxis(s string) (Axis, error) {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case "X":
		return AxisX, nil
	case "Y":
		return AxisY, nil
	case "Z":
		return AxisZ, nil
	case "A":
		return AxisA, nil
	case "B":
		return AxisB, nil
	}
	return 0, errors.Errorf("unknown axis %q (want X, Y, Z, A or B)", s)
}

// Coord is an optionally-present coordinate.
type Coord struct {
	Value float64
	Set   bool
}

// PartialAxes is a move target naming only the axes that should move.
type PartialAxes struct {
	X, Y, Z, A, B Coord
}

func (p PartialAxes) words() string {
	var b strings.Builder
	appendWord := func(letter byte, c Coord) {
		if c.Set {
			b.WriteByte(' ')
			b.WriteByte(letter)
			b.WriteString(num(c.Value))
		}
	}
	appendWord('X', p.X)
	appendWord('Y', p.Y)
	appendWord('Z', p.Z)
	appendWord('A', p.A)
	appendWord('B', p.B)
	return b.String()
}

func (p PartialAxes) any() bool {
	return p.X.Set || p.Y.Set || p.Z.Set || p.A.Set || p.B.Set
}

// num renders a float as a G-code number: minimal digits, no exponent.
func num(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// MotionOp is one validated operation. Implementations render their own
// G-code; the methods are unexported so the interface cannot be implemented —
// and therefore no command text can be injected — from outside this package.
type MotionOp interface {
	// render returns the exact command lines this op sends, in order.
	render() []string
	// class is the op's risk class; a request is gated by its maximum.
	class() RiskClass
	// requiresHomed reports whether the op is meaningless without a machine
	// reference. Relative jogs and machine-coordinate moves do not require
	// homing; work-coordinate moves do.
	requiresHomed() bool
	// Describe is the human-readable summary used in logs and dry runs.
	Describe() string
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

type stepJogOp struct {
	axis     Axis
	dist     float64
	speedPct float64
}

// StepJog is one bounded relative move: `$J X-1 F0.25` at 25% of the axis
// maximum. speedPct is a percentage of max rate (see renderJogSpeed for why);
// 0 means maximum. Jogging is permitted on an unhomed machine — a relative
// move is exactly how an operator repositions one.
func StepJog(axis Axis, distanceMM, speedPct float64) (MotionOp, error) {
	if _, err := ParseAxis(string(axis)); err != nil {
		return nil, err
	}
	if distanceMM == 0 {
		return nil, errors.New("jog distance must be non-zero")
	}
	if distanceMM < -maxJogDistanceMM || distanceMM > maxJogDistanceMM {
		return nil, errors.Errorf("jog distance %v exceeds the %d mm sanity bound", distanceMM, maxJogDistanceMM)
	}
	if err := checkSpeedPct(speedPct); err != nil {
		return nil, err
	}
	return stepJogOp{axis: axis, dist: distanceMM, speedPct: speedPct}, nil
}

func (o stepJogOp) render() []string {
	return []string{fmt.Sprintf("$J %c%s%s", o.axis, num(o.dist), renderJogSpeed(o.speedPct))}
}
func (o stepJogOp) class() RiskClass    { return ClassMotion }
func (o stepJogOp) requiresHomed() bool { return false }
func (o stepJogOp) Describe() string {
	return fmt.Sprintf("step jog %c by %s mm", o.axis, num(o.dist))
}

type contJogOp struct {
	axis     Axis
	positive bool
	speedPct float64
}

// ContinuousJog moves while keepalives arrive and stops when they cease:
// `$J -c X1` / `$J -c X-1`, direction encoded as a signed 1 exactly as the
// reference controller's pendant sends it. speedPct is a percentage of the
// axis maximum (see renderJogSpeed). Use Client.JogStart, which owns the
// keepalive; this constructor exists so dry runs can render the command.
func ContinuousJog(axis Axis, positive bool, speedPct float64) (MotionOp, error) {
	if _, err := ParseAxis(string(axis)); err != nil {
		return nil, err
	}
	if err := checkSpeedPct(speedPct); err != nil {
		return nil, err
	}
	return contJogOp{axis: axis, positive: positive, speedPct: speedPct}, nil
}

func (o contJogOp) render() []string {
	dir := "1"
	if !o.positive {
		dir = "-1"
	}
	return []string{fmt.Sprintf("$J -c %c%s%s", o.axis, dir, renderJogSpeed(o.speedPct))}
}
func (o contJogOp) class() RiskClass    { return ClassMotion }
func (o contJogOp) requiresHomed() bool { return false }
func (o contJogOp) Describe() string {
	sign := "+"
	if !o.positive {
		sign = "-"
	}
	return fmt.Sprintf("continuous jog %c%s", o.axis, sign)
}

type rapidOp struct {
	machine bool
	target  PartialAxes
	safeZ   bool
}

// RapidTo is an absolute rapid move. machineCoords selects `G53` (mechanical
// moves: park, clearance) versus the active work system (moves about the
// part). The coordinate system is an explicit parameter precisely because a
// helper that defaults it will eventually move somewhere surprising.
//
// safeZFirst retracts Z to the machine-coordinate safe height before any XY
// motion — a tool at cutting depth moved in XY ploughs through the workpiece.
func RapidTo(machineCoords bool, target PartialAxes, safeZFirst bool) (MotionOp, error) {
	if !target.any() {
		return nil, errors.New("move names no axes")
	}
	return rapidOp{machine: machineCoords, target: target, safeZ: safeZFirst}, nil
}

func (o rapidOp) render() []string {
	var out []string
	if o.safeZ {
		out = append(out, fmt.Sprintf("G53 G90 G0 Z%s", num(safeZMachineCoord)))
	}
	// The distance mode is emitted with every move: the machine is modal, and
	// a helper that assumes G90 will do the wrong thing after anything else
	// changed it.
	prefix := "G90 G0"
	if o.machine {
		prefix = "G53 G90 G0"
	}
	out = append(out, prefix+o.target.words())
	return out
}
func (o rapidOp) class() RiskClass    { return ClassMotion }
func (o rapidOp) requiresHomed() bool { return true } // see note below
func (o rapidOp) Describe() string {
	cs := "work"
	if o.machine {
		cs = "machine"
	}
	return fmt.Sprintf("rapid to%s (%s coordinates)", o.target.words(), cs)
}

// Note on rapidOp.requiresHomed: an absolute move is meaningless without a
// reference in EITHER coordinate system — machine coordinates read -1,-1,-1
// unhomed. Only relative jogs are safe unhomed, so every rapid requires
// homing.

type safeZOp struct{}

// SafeZ retracts Z to the machine-coordinate safe height. Class 1, but
// requires homing like every absolute move.
func SafeZ() MotionOp { return safeZOp{} }

func (safeZOp) render() []string {
	return []string{fmt.Sprintf("G53 G90 G0 Z%s", num(safeZMachineCoord))}
}
func (safeZOp) class() RiskClass    { return ClassMotion }
func (safeZOp) requiresHomed() bool { return true }
func (safeZOp) Describe() string    { return "retract Z to machine safe height" }

type parkOp struct{}

// Park retracts Z, then moves to the machine's pack position. The coordinates
// are the Z1's own, from the pack-position file read off the machine.
func Park() MotionOp { return parkOp{} }

func (parkOp) render() []string {
	return []string{
		fmt.Sprintf("G53 G90 G0 Z%s", num(safeZMachineCoord)),
		"G53 G90 G0 X-197 Y-206",
	}
}
func (parkOp) class() RiskClass    { return ClassMotion }
func (parkOp) requiresHomed() bool { return true }
func (parkOp) Describe() string    { return "park (safe Z, then machine X-197 Y-206)" }

type homeOp struct{}

// Home homes all axes: `$H`. The single most dangerous command in the ticket —
// every axis moves at speed — and the one an operator needs most, because
// nothing else works until the machine has a reference. Single-axis homing is
// deliberately not offered: whether this firmware supports `$H X` is an open
// question, and the conservative choice ships first.
func Home() MotionOp { return homeOp{} }

func (homeOp) render() []string    { return []string{"$H"} }
func (homeOp) class() RiskClass    { return ClassMotion }
func (homeOp) requiresHomed() bool { return false }
func (homeOp) Describe() string    { return "home ALL axes" }

type spindleOnOp struct{ rpm int }

// SpindleOn starts the spindle: `M3 S12000`. Class 1 — it starts a cutter
// spinning whether or not the cover is closed.
func SpindleOn(rpm int) (MotionOp, error) {
	if rpm <= 0 || rpm > maxSpindleRPM {
		return nil, errors.Errorf("spindle rpm %d outside (0, %d]", rpm, maxSpindleRPM)
	}
	return spindleOnOp{rpm: rpm}, nil
}

func (o spindleOnOp) render() []string    { return []string{fmt.Sprintf("M3 S%d", o.rpm)} }
func (o spindleOnOp) class() RiskClass    { return ClassMotion }
func (o spindleOnOp) requiresHomed() bool { return false }
func (o spindleOnOp) Describe() string    { return fmt.Sprintf("spindle ON at %d rpm", o.rpm) }

type spindleOffOp struct{}

// SpindleOff stops the spindle: `M5`. Class 0 — it only stops something, so it
// is never gated. (The design table filed M5 under the spindle's Class 1 row;
// the Class 0 principle — a stop that can be refused is not a stop — wins.
// Flagged for the operator safety review.)
func SpindleOff() MotionOp { return spindleOffOp{} }

func (spindleOffOp) render() []string    { return []string{"M5"} }
func (spindleOffOp) class() RiskClass    { return ClassStop }
func (spindleOffOp) requiresHomed() bool { return false }
func (spindleOffOp) Describe() string    { return "spindle OFF" }

// AccessoryName identifies a switchable output that cannot cut anyone.
type AccessoryName string

const (
	AccessoryLight      AccessoryName = "light"
	AccessoryVacuum     AccessoryName = "vacuum"
	AccessoryFan        AccessoryName = "fan" // spindle fan
	AccessoryAir        AccessoryName = "air" // M7 / M9
	AccessoryPWM        AccessoryName = "pwm" // external PWM
	AccessoryProbeChg   AccessoryName = "probe-charger"
	AccessoryToolSensor AccessoryName = "tool-sensor"
)

type accessoryOp struct {
	name   AccessoryName
	on     bool
	power  int // 0..100, for the outputs that take S
	cmdOn  string
	cmdOff string
	takesS bool
}

var accessoryTable = map[AccessoryName]struct {
	on, off string
	takesS  bool
}{
	AccessoryLight:      {"M821", "M822", false},
	AccessoryVacuum:     {"M801", "M802", true},
	AccessoryFan:        {"M811", "M812", true},
	AccessoryAir:        {"M7", "M9", false},
	AccessoryPWM:        {"M851", "M852", true},
	AccessoryProbeChg:   {"M841", "M842", false},
	AccessoryToolSensor: {"M831", "M832", false},
}

// Accessory switches one of the machine's outputs. Class 3: allowed without
// confirmation on dedicated paths — the light and the vacuum are things an
// operator toggles constantly. Switching OFF is a stop and is never gated.
func Accessory(name AccessoryName, on bool, power int) (MotionOp, error) {
	entry, ok := accessoryTable[name]
	if !ok {
		return nil, errors.Errorf("unknown accessory %q", name)
	}
	if power < 0 || power > 100 {
		return nil, errors.Errorf("accessory power %d outside [0,100]", power)
	}
	return accessoryOp{
		name: name, on: on, power: power,
		cmdOn: entry.on, cmdOff: entry.off, takesS: entry.takesS,
	}, nil
}

func (o accessoryOp) render() []string {
	if !o.on {
		return []string{o.cmdOff}
	}
	cmd := o.cmdOn
	if o.takesS && o.power > 0 {
		cmd += fmt.Sprintf(" S%d", o.power)
	}
	return []string{cmd}
}
func (o accessoryOp) class() RiskClass {
	if !o.on {
		return ClassStop
	}
	return ClassAccessory
}
func (o accessoryOp) requiresHomed() bool { return false }
func (o accessoryOp) Describe() string {
	state := "off"
	if o.on {
		state = "on"
	}
	return fmt.Sprintf("accessory %s %s", o.name, state)
}

type zeroOp struct {
	system int // 1..6 → G54..G59
	axes   []Axis
}

// ZeroWorkOffset sets the given work system's offset so the CURRENT position
// becomes zero on the named axes: `G10 L20 P1 X0 Y0`. No motion occurs, but
// every subsequent work-coordinate move goes somewhere new — Class 1 in
// effect. UNVERIFIED on this firmware (MZ1-003 §7.3): standard G-code, not yet
// exercised on this machine; the config-path alternative is deferred until the
// open question is answered on hardware.
func ZeroWorkOffset(system int, axes []Axis) (MotionOp, error) {
	if system < 1 || system > 6 {
		return nil, errors.Errorf("work system P%d outside G54..G59 (P1..P6)", system)
	}
	if len(axes) == 0 {
		return nil, errors.New("no axes to zero")
	}
	for _, a := range axes {
		if _, err := ParseAxis(string(a)); err != nil {
			return nil, err
		}
	}
	return zeroOp{system: system, axes: axes}, nil
}

func (o zeroOp) render() []string {
	var b strings.Builder
	fmt.Fprintf(&b, "G10 L20 P%d", o.system)
	for _, a := range o.axes {
		b.WriteByte(' ')
		b.WriteByte(byte(a))
		b.WriteByte('0')
	}
	return []string{b.String()}
}
func (o zeroOp) class() RiskClass    { return ClassMotion }
func (o zeroOp) requiresHomed() bool { return true }
func (o zeroOp) Describe() string {
	letters := make([]string, len(o.axes))
	for i, a := range o.axes {
		letters[i] = string(a)
	}
	return fmt.Sprintf("zero work offset G5%d on %s at current position", 3+o.system, strings.Join(letters, ","))
}

type playOp struct{ path string }

// PlayFile starts a stored program: `play /sd/gcodes/part.nc`. Effectively
// unbounded motion. No -O/-v flag is sent — which flag this firmware wants is
// an open question, and the conservative choice is neither.
func PlayFile(path string) (MotionOp, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("empty path")
	}
	if !strings.HasPrefix(path, "/") {
		return nil, errors.Errorf("path %q is not absolute; the firmware resolves play paths from /", path)
	}
	return playOp{path: EscapePath(path)}, nil
}

func (o playOp) render() []string    { return []string{"play " + o.path} }
func (o playOp) class() RiskClass    { return ClassMotion }
func (o playOp) requiresHomed() bool { return true }
func (o playOp) Describe() string    { return "PLAY " + o.path }

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

// MotionRequest is one operator-authorised action. Constructing one requires
// typed ops — there is no way to put free text in it — and a Reason, which is
// logged as the audit trail.
type MotionRequest struct {
	Ops    []MotionOp
	Reason string
}

// Class is the maximum risk class across the request's ops. The caller cannot
// lower it; the op that knows what it does is the authority.
func (r MotionRequest) Class() RiskClass {
	class := ClassRead
	for _, op := range r.Ops {
		if c := op.class(); c > class {
			class = c
		}
	}
	return class
}

// RequiresHomed reports whether any op needs a machine reference.
func (r MotionRequest) RequiresHomed() bool {
	for _, op := range r.Ops {
		if op.requiresHomed() {
			return true
		}
	}
	return false
}

func (r MotionRequest) validate() error {
	if len(r.Ops) == 0 {
		return errors.New("motion request has no operations")
	}
	if strings.TrimSpace(r.Reason) == "" {
		return errors.New("motion request has no reason; the reason is the audit trail")
	}
	return nil
}

// DryRunStep is one rendered command with its wire encoding.
type DryRunStep struct {
	Op      string
	Command string
	Frame   []byte
}

// DryRunReport is everything a motion request would do, without a connection.
type DryRunReport struct {
	Class         RiskClass
	RequiresHomed bool
	Steps         []DryRunStep
}

// DryRun renders a request exactly as Motion would send it, without sending
// anything. This is how understanding is checked before a machine is involved.
func DryRun(req MotionRequest) (DryRunReport, error) {
	if err := req.validate(); err != nil {
		return DryRunReport{}, err
	}
	rep := DryRunReport{Class: req.Class(), RequiresHomed: req.RequiresHomed()}
	for _, op := range req.Ops {
		for _, cmd := range op.render() {
			rep.Steps = append(rep.Steps, DryRunStep{
				Op:      op.Describe(),
				Command: cmd,
				Frame:   BuildFrame(PTypeCtrlMulti, []byte(cmd)),
			})
		}
	}
	return rep, nil
}

// MotionResult reports what a motion request did.
type MotionResult struct {
	Sent       []string
	Preflight  PreflightReport
	StateAfter Status
}

// Motion executes an authorised request: fresh preflight, then each op in
// order, then one status re-read. It never retries, and a failed step ends the
// request — the remaining ops are not sent.
func (c *Client) Motion(ctx context.Context, req MotionRequest, opts PreflightOptions) (MotionResult, error) {
	if err := req.validate(); err != nil {
		return MotionResult{}, err
	}
	class := req.Class()
	opts.RequireHomed = opts.RequireHomed || req.RequiresHomed()

	var res MotionResult
	if class >= ClassStateEnabling {
		pf, err := c.Preflight(ctx, class, opts)
		res.Preflight = pf
		if err != nil {
			return res, err
		}
		if fails := pf.Failures(); len(fails) > 0 {
			return res, errors.Wrapf(ErrPreflightFailed, "%s", pf.FailureSummary())
		}
	}

	c.logger.Warn().
		Str("class", class.String()).
		Str("reason", req.Reason).
		Msg("executing authorised motion request")

	for _, op := range req.Ops {
		for _, cmd := range op.render() {
			res.Sent = append(res.Sent, cmd)
			if _, err := c.commandUnchecked(ctx, cmd); err != nil {
				return res, errors.Wrapf(err, "sending %q (%s); request stopped here, nothing was retried", cmd, op.Describe())
			}
		}
	}

	if st, err := c.QueryStatus(ctx); err == nil {
		res.StateAfter = st
	}
	return res, nil
}

// ---------------------------------------------------------------------------
// Continuous jog: the dead-man session
// ---------------------------------------------------------------------------

// jogKeepaliveInterval matches the reference controller's status-poll cadence
// while jogging. The firmware stops the axis when keepalives cease — that is
// the dead-man property, and it is the strongest guarantee in this system
// because it depends on our software STOPPING, not on it behaving correctly.
const jogKeepaliveInterval = 200 * time.Millisecond

// jogStopAckTimeout bounds the wait for the firmware's ^Y acknowledgement.
const jogStopAckTimeout = 2 * time.Second

// JogSession is one active continuous jog. Exactly one exists per client at a
// time. Keepalives are emitted by a session goroutine; Stop runs the 0x19/^Y
// handshake. If the session's owner crashes instead of calling Stop, the
// keepalives cease and the firmware stops the axis on its own.
type JogSession struct {
	c        *Client
	op       MotionOp
	cancel   context.CancelFunc
	done     chan struct{}
	stopping atomic.Bool
	stopOnce sync.Once
	stopErr  error
}

// JogStart begins a continuous jog whose keepalives THIS PROCESS emits on a
// timer — the caller's liveness is the dead-man, which is right for the CLI,
// where the process holding the terminal is the held button. Class 1:
// preflights fresh, refuses a second concurrent jog, and does not require
// homing (the jog is relative).
func (c *Client) JogStart(ctx context.Context, axis Axis, positive bool, speedPct float64, opts PreflightOptions) (*JogSession, error) {
	return c.jogStart(ctx, axis, positive, speedPct, opts, true)
}

// JogStartManual begins a continuous jog whose keepalives the CALLER emits by
// calling Keepalive — one call, one ?+0x1A write, forwarded 1:1. This is the
// web server's mode: each protocol keepalive is CAUSED by a browser keepalive
// from a held button, so no software timer exists that could keep motion
// alive without a human. When the calls stop — released button, hidden tab,
// crashed browser — the firmware's own dead-man stops the axis; nothing on
// the server needs to notice for the machine to be safe.
func (c *Client) JogStartManual(ctx context.Context, axis Axis, positive bool, speedPct float64, opts PreflightOptions) (*JogSession, error) {
	return c.jogStart(ctx, axis, positive, speedPct, opts, false)
}

func (c *Client) jogStart(ctx context.Context, axis Axis, positive bool, speedPct float64, opts PreflightOptions, auto bool) (*JogSession, error) {
	op, err := ContinuousJog(axis, positive, speedPct)
	if err != nil {
		return nil, err
	}
	if !c.jogActive.CompareAndSwap(false, true) {
		return nil, errors.New("a continuous jog is already active; stop it first — jogs are never queued")
	}
	ok := false
	defer func() {
		if !ok {
			c.jogActive.Store(false)
		}
	}()

	pf, err := c.Preflight(ctx, ClassMotion, opts)
	if err != nil {
		return nil, err
	}
	if fails := pf.Failures(); len(fails) > 0 {
		return nil, errors.Wrapf(ErrPreflightFailed, "%s", pf.FailureSummary())
	}

	c.logger.Warn().Str("op", op.Describe()).Msg("starting continuous jog")
	// The start command is written without the sentinel exchange: the firmware
	// answers a continuous jog with motion, not with output, and the command
	// path must not sit waiting while the axis moves.
	for _, cmd := range op.render() {
		if err := c.write(c.proto.EncodeCommand([]byte(cmd))); err != nil {
			return nil, errors.Wrap(err, "start continuous jog")
		}
	}

	runCtx, cancel := context.WithCancel(context.Background())
	s := &JogSession{c: c, op: op, cancel: cancel, done: make(chan struct{})}
	if auto {
		go s.keepaliveLoop(runCtx)
	} else {
		// No emitter to wait for on stop.
		close(s.done)
	}
	ok = true
	return s, nil
}

// Keepalive forwards one keepalive digram — the manual-mode counterpart of
// the timer loop. It refuses once a stop has begun, because a keepalive
// arriving after 0x19 fights the stop.
func (s *JogSession) Keepalive() error {
	if s.stopping.Load() {
		return errors.New("jog is stopping; keepalive refused so it cannot fight the stop")
	}
	return s.c.write(s.c.proto.EncodeRealtime(RealtimeStatus, RealtimeJogKeep))
}

// keepaliveLoop emits the ?+0x1A digram every interval, in ONE write — sending
// the bytes separately races other traffic and leaves orphaned bytes in the
// firmware's command buffer. On any write error it stops immediately: ceasing
// keepalives IS the safe failure, because the firmware then stops the axis.
func (s *JogSession) keepaliveLoop(ctx context.Context) {
	defer close(s.done)
	tick := time.NewTicker(jogKeepaliveInterval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if err := s.c.write(s.c.proto.EncodeRealtime(RealtimeStatus, RealtimeJogKeep)); err != nil {
				s.c.logger.Warn().Err(err).Msg("jog keepalive write failed; ceasing keepalives (firmware dead-man stops the axis)")
				return
			}
		}
	}
}

// Stop ends the jog with the firmware handshake: keepalives are suppressed
// FIRST (so they cannot fight the stop), then 0x19 is sent, then the ^Y
// acknowledgement is awaited. Stop is Class 0 — it runs in any state, and an
// error return means the acknowledgement was not observed, not that stopping
// failed: the moment keepalives ceased, the firmware's dead-man guaranteed the
// axis stops.
func (s *JogSession) Stop(ctx context.Context) error {
	s.stopOnce.Do(func() { s.stopErr = s.stop(ctx) })
	return s.stopErr
}

func (s *JogSession) stop(ctx context.Context) error {
	defer s.c.jogActive.Store(false)

	// 1. Suppress keepalives FIRST — refuse manual ones, cancel the timer
	//    loop and wait until it is actually gone — so no keepalive can be
	//    written after the stop byte.
	s.stopping.Store(true)
	s.cancel()
	<-s.done

	// 2. Register the ack channel BEFORE sending the stop, so the ^Y cannot
	//    arrive in the gap.
	ack := make(chan struct{})
	s.c.jogAck.Store(&ack)
	defer s.c.jogAck.Store(nil)

	// 3. The stop byte.
	if err := s.c.write(s.c.proto.EncodeRealtime(RealtimeJogStop)); err != nil {
		// The write failed — but keepalives have already ceased, so the
		// firmware stops the axis regardless. Report, do not retry.
		return errors.Wrap(err, "jog stop byte failed to send; the axis stops anyway once keepalives cease")
	}

	// 4. The acknowledgement.
	timer := time.NewTimer(jogStopAckTimeout)
	defer timer.Stop()
	select {
	case <-ack:
		return nil
	case <-ctx.Done():
		return errors.Wrap(ctx.Err(), "jog stop sent; context ended before the ^Y acknowledgement")
	case <-timer.C:
		return errors.Errorf("jog stop sent but no ^Y acknowledgement within %s; keepalives have ceased, so the firmware's dead-man stops the axis", jogStopAckTimeout)
	}
}
