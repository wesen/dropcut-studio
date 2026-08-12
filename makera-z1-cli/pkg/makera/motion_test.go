package makera

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// Typed op construction
// ---------------------------------------------------------------------------

func TestMotionOpValidation(t *testing.T) {
	cases := []struct {
		name string
		make func() (MotionOp, error)
	}{
		{"bad axis", func() (MotionOp, error) { return StepJog('Q', 1, 0) }},
		{"zero distance", func() (MotionOp, error) { return StepJog(AxisX, 0, 0) }},
		{"absurd distance", func() (MotionOp, error) { return StepJog(AxisX, 5000, 0) }},
		{"negative feed", func() (MotionOp, error) { return StepJog(AxisX, 1, -5) }},
		{"absurd feed", func() (MotionOp, error) { return StepJog(AxisX, 1, 99999) }},
		{"zero rpm", func() (MotionOp, error) { return SpindleOn(0) }},
		{"absurd rpm", func() (MotionOp, error) { return SpindleOn(999999) }},
		{"empty move", func() (MotionOp, error) { return RapidTo(true, PartialAxes{}, false) }},
		{"unknown accessory", func() (MotionOp, error) { return Accessory("teleporter", true, 0) }},
		{"bad work system", func() (MotionOp, error) { return ZeroWorkOffset(9, []Axis{AxisX}) }},
		{"zero without axes", func() (MotionOp, error) { return ZeroWorkOffset(1, nil) }},
		{"relative play path", func() (MotionOp, error) { return PlayFile("part.nc") }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := tc.make()
			assert.Error(t, err, "constructor must refuse before a connection is involved")
		})
	}
}

func TestMotionOpRendering(t *testing.T) {
	mustOp := func(op MotionOp, err error) MotionOp {
		t.Helper()
		require.NoError(t, err)
		return op
	}
	cases := []struct {
		op   MotionOp
		want []string
	}{
		{mustOp(StepJog(AxisX, 10, 600)), []string{"$J X10 F600"}},
		{mustOp(StepJog(AxisY, -0.1, 0)), []string{"$J Y-0.1"}},
		{mustOp(ContinuousJog(AxisZ, false, 800)), []string{"$J -c Z-1 F800"}},
		{mustOp(ContinuousJog(AxisX, true, 0)), []string{"$J -c X1"}},
		{Home(), []string{"$H"}},
		{SafeZ(), []string{"G53 G90 G0 Z-3"}},
		{Park(), []string{"G53 G90 G0 Z-3", "G53 G90 G0 X-197 Y-206"}},
		{mustOp(SpindleOn(12000)), []string{"M3 S12000"}},
		{SpindleOff(), []string{"M5"}},
		{mustOp(Accessory(AccessoryLight, true, 0)), []string{"M821"}},
		{mustOp(Accessory(AccessoryVacuum, true, 80)), []string{"M801 S80"}},
		{mustOp(Accessory(AccessoryAir, false, 0)), []string{"M9"}},
		{mustOp(ZeroWorkOffset(1, []Axis{AxisX, AxisY})), []string{"G10 L20 P1 X0 Y0"}},
		{mustOp(PlayFile("/sd/gcodes/part.nc")), []string{"play /sd/gcodes/part.nc"}},
		{
			mustOp(RapidTo(true, PartialAxes{X: Coord{-100, true}, Y: Coord{-50, true}}, true)),
			[]string{"G53 G90 G0 Z-3", "G53 G90 G0 X-100 Y-50"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.want[len(tc.want)-1], func(t *testing.T) {
			assert.Equal(t, tc.want, tc.op.render())
		})
	}
}

// TestOpClassesMatchTheReviewedTable pins the risk classes to the MZ1-003 §3
// table (with the review's amendment: everything that only stops is Class 0).
func TestOpClassesMatchTheReviewedTable(t *testing.T) {
	jog, _ := StepJog(AxisX, 1, 0)
	spOn, _ := SpindleOn(1000)
	lightOn, _ := Accessory(AccessoryLight, true, 0)
	lightOff, _ := Accessory(AccessoryLight, false, 0)
	play, _ := PlayFile("/sd/x.nc")

	assert.Equal(t, ClassMotion, jog.class())
	assert.Equal(t, ClassMotion, Home().class())
	assert.Equal(t, ClassMotion, spOn.class())
	assert.Equal(t, ClassMotion, play.class())
	assert.Equal(t, ClassStop, SpindleOff().class())
	assert.Equal(t, ClassAccessory, lightOn.class())
	assert.Equal(t, ClassStop, lightOff.class(), "switching an output OFF only stops it")
}

// ---------------------------------------------------------------------------
// Requests and dry runs
// ---------------------------------------------------------------------------

func TestMotionRequestRefusesEmptyAndUnreasoned(t *testing.T) {
	op, _ := StepJog(AxisX, 1, 0)

	_, err := DryRun(MotionRequest{Reason: "no ops"})
	assert.Error(t, err)

	_, err = DryRun(MotionRequest{Ops: []MotionOp{op}})
	assert.Error(t, err, "the reason is the audit trail; it is not optional")
}

func TestRequestClassIsTheMaximumAcrossOps(t *testing.T) {
	lightOn, _ := Accessory(AccessoryLight, true, 0)
	req := MotionRequest{Ops: []MotionOp{lightOn, Home()}, Reason: "test"}
	assert.Equal(t, ClassMotion, req.Class(), "the caller cannot lower the class; the most severe op wins")
}

func TestDryRunRendersDecodableFrames(t *testing.T) {
	jog, _ := StepJog(AxisX, 10, 600)
	rep, err := DryRun(MotionRequest{Ops: []MotionOp{jog}, Reason: "test"})
	require.NoError(t, err)
	require.Len(t, rep.Steps, 1)
	assert.Equal(t, "$J X10 F600", rep.Steps[0].Command)

	var dec Decoder
	frames := dec.Feed(rep.Steps[0].Frame)
	require.Len(t, frames, 1, "the dry-run frame must decode as exactly one frame")
	assert.Equal(t, PTypeCtrlMulti, frames[0].Type)
	assert.Equal(t, "$J X10 F600", string(frames[0].Payload))
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

func preflightFails(t *testing.T, m *fakeMachine, opts PreflightOptions, wantCheck string) {
	t.Helper()
	c := newFakeClient(t, m)
	rep, err := c.Preflight(context.Background(), ClassMotion, opts)
	require.NoError(t, err, "preflight itself must succeed; the CONDITIONS fail")
	fails := rep.Failures()
	require.NotEmpty(t, fails, "expected a fatal failure")
	names := make([]string, len(fails))
	for i, f := range fails {
		names[i] = f.Name
	}
	assert.Contains(t, names, wantCheck)
}

func TestPreflightRefusesAlarm(t *testing.T) {
	m := newFakeMachine(nil, 128)
	m.state, m.haltCode = "Alarm", 13
	preflightFails(t, m, PreflightOptions{}, "machine state")
}

func TestPreflightNamesTheHaltReasonInTheRefusal(t *testing.T) {
	m := newFakeMachine(nil, 128)
	m.state, m.haltCode = "Alarm", 13
	c := newFakeClient(t, m)
	rep, err := c.Preflight(context.Background(), ClassMotion, PreflightOptions{})
	require.NoError(t, err)
	assert.Contains(t, rep.FailureSummary(), "emergency stop button pressed",
		"a refusal without the why invites blind unlocking")
}

func TestPreflightRefusesEStop(t *testing.T) {
	m := newFakeMachine(nil, 128)
	m.estop = true
	preflightFails(t, m, PreflightOptions{}, "emergency stop")
}

func TestPreflightRefusesOpenCover(t *testing.T) {
	m := newFakeMachine(nil, 128)
	m.endstops[EndstopCover] = "0"
	preflightFails(t, m, PreflightOptions{}, "cover")
}

// TestPreflightRefusesUnknownCoverState is the case that matters most:
// unknown is not closed. A preflight that cannot verify the cover has not
// verified the cover.
func TestPreflightRefusesUnknownCoverState(t *testing.T) {
	m := newFakeMachine(nil, 128)
	m.endstops = []string{"0", "0", "0"} // too short for the mapping
	preflightFails(t, m, PreflightOptions{}, "cover")
}

func TestPreflightCoverWaiverIsExplicit(t *testing.T) {
	m := newFakeMachine(nil, 128)
	m.endstops[EndstopCover] = "0"
	c := newFakeClient(t, m)
	rep, err := c.Preflight(context.Background(), ClassMotion, PreflightOptions{AllowOpenCover: true})
	require.NoError(t, err)
	assert.Empty(t, rep.Failures())
}

func TestPreflightRefusesWhilePlaying(t *testing.T) {
	m := newFakeMachine(nil, 128)
	m.state = "Run"
	m.playing = &Playback{Lines: 100, Percent: 42, Seconds: 60, Active: true}
	preflightFails(t, m, PreflightOptions{}, "job")
}

func TestPreflightRefusesUnhomedForAbsoluteMoves(t *testing.T) {
	m := newFakeMachine(nil, 128)
	m.homed = false
	preflightFails(t, m, PreflightOptions{RequireHomed: true}, "homed")
}

func TestPreflightPermitsUnhomedRelativeJog(t *testing.T) {
	m := newFakeMachine(nil, 128)
	m.homed = false
	c := newFakeClient(t, m)
	rep, err := c.Preflight(context.Background(), ClassMotion, PreflightOptions{})
	require.NoError(t, err)
	assert.Empty(t, rep.Failures(), "a relative jog is exactly how an operator repositions an unhomed machine")
}

func TestPreflightRefusesStopClassInvocation(t *testing.T) {
	m := newFakeMachine(nil, 128)
	c := newFakeClient(t, m)
	_, err := c.Preflight(context.Background(), ClassStop, PreflightOptions{})
	assert.Error(t, err, "stops are never gated; preflighting one is a caller bug")
}

// ---------------------------------------------------------------------------
// Motion execution
// ---------------------------------------------------------------------------

func TestMotionSendsOpsInOrderAndStopsOnRefusal(t *testing.T) {
	m := newFakeMachine(nil, 128)
	c := newFakeClient(t, m)

	jog, _ := StepJog(AxisX, 10, 600)
	res, err := c.Motion(context.Background(), MotionRequest{
		Ops: []MotionOp{jog}, Reason: "unit test",
	}, PreflightOptions{})
	require.NoError(t, err)
	assert.Equal(t, []string{"$J X10 F600"}, res.Sent)

	m.mu.Lock()
	sent := append([]string(nil), m.cmds...)
	m.mu.Unlock()
	assert.Contains(t, sent, "$J X10 F600")

	// Now alarm the machine: the same request must be refused before any
	// command is sent.
	m.mu.Lock()
	m.state, m.haltCode = "Alarm", 13
	before := len(m.cmds)
	m.mu.Unlock()

	_, err = c.Motion(context.Background(), MotionRequest{
		Ops: []MotionOp{jog}, Reason: "unit test",
	}, PreflightOptions{})
	require.ErrorIs(t, err, ErrPreflightFailed)

	m.mu.Lock()
	defer m.mu.Unlock()
	for _, cmd := range m.cmds[before:] {
		assert.NotContains(t, cmd, "$J", "no motion command may follow a failed preflight")
	}
}

// ---------------------------------------------------------------------------
// Continuous jog: keepalive, handshake, dead-man
// ---------------------------------------------------------------------------

func TestJogKeepalivesRideTheStatusPoll(t *testing.T) {
	m := newFakeMachine(nil, 128)
	c := newFakeClient(t, m)

	s, err := c.JogStart(context.Background(), AxisX, true, 600, PreflightOptions{})
	require.NoError(t, err)
	defer func() { _ = s.Stop(context.Background()) }()

	time.Sleep(1 * time.Second)
	assert.True(t, m.jogActiveNow(), "keepalives must be holding the jog alive")

	m.mu.Lock()
	times := append([]time.Time(nil), m.jogKeepTimes...)
	m.mu.Unlock()
	require.GreaterOrEqual(t, len(times), 3, "expected several keepalives in a second")
	for i := 1; i < len(times); i++ {
		assert.Less(t, times[i].Sub(times[i-1]), 500*time.Millisecond,
			"keepalive gap must stay well inside the firmware's window")
	}
}

func TestJogStopRunsTheHandshake(t *testing.T) {
	m := newFakeMachine(nil, 128)
	c := newFakeClient(t, m)

	s, err := c.JogStart(context.Background(), AxisY, false, 0, PreflightOptions{})
	require.NoError(t, err)
	require.NoError(t, s.Stop(context.Background()), "the ^Y acknowledgement must be observed")

	m.mu.Lock()
	gotStop := m.jogGotStop
	jogging := m.jogging
	m.mu.Unlock()
	assert.True(t, gotStop, "0x19 must reach the machine")
	assert.False(t, jogging)
	assert.False(t, c.jogActive.Load(), "the client slot must be released")

	// Stop is idempotent.
	assert.NoError(t, s.Stop(context.Background()))
}

func TestJogStopReportsAMissingAck(t *testing.T) {
	m := newFakeMachine(nil, 128)
	m.suppressJogAck = true
	c := newFakeClient(t, m)

	s, err := c.JogStart(context.Background(), AxisX, true, 0, PreflightOptions{})
	require.NoError(t, err)
	err = s.Stop(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "dead-man", "the error must say why the axis stops anyway")
}

// TestJogDeadman is the property that makes continuous jog safe to build on,
// and it is testable in the fake and nowhere else: when the host stops sending
// keepalives — crash, kill, severed network — the machine stops on its own.
func TestJogDeadman(t *testing.T) {
	m := newFakeMachine(nil, 128)
	c := newFakeClient(t, m)

	s, err := c.JogStart(context.Background(), AxisZ, true, 0, PreflightOptions{})
	require.NoError(t, err)
	require.True(t, m.jogActiveNow())

	// Abandon the session without stopping: cancel the keepalive emitter as a
	// crash would.
	s.cancel()
	<-s.done

	time.Sleep(m.jogDeadman + 200*time.Millisecond)
	assert.False(t, m.jogActiveNow(), "the machine must stop itself when keepalives cease")

	m.mu.Lock()
	fired := m.jogDeadmanFired
	m.mu.Unlock()
	assert.True(t, fired)

	_ = s.Stop(context.Background()) // release the client slot
}

// TestManualJogForwardsKeepalivesOneToOne is the web server's mode: each
// Keepalive call causes exactly one protocol keepalive, so nothing but a held
// button can keep motion alive, and ceasing calls stops the axis by the
// firmware's own dead-man.
func TestManualJogForwardsKeepalivesOneToOne(t *testing.T) {
	m := newFakeMachine(nil, 128)
	c := newFakeClient(t, m)

	s, err := c.JogStartManual(context.Background(), AxisX, true, 600, PreflightOptions{})
	require.NoError(t, err)

	for i := 0; i < 3; i++ {
		require.NoError(t, s.Keepalive())
		time.Sleep(50 * time.Millisecond)
	}
	m.mu.Lock()
	count := len(m.jogKeepTimes)
	m.mu.Unlock()
	assert.Equal(t, 3, count, "one Keepalive call, one protocol keepalive — no timer adds extras")
	assert.True(t, m.jogActiveNow())

	// Cease calling: the firmware's dead-man stops the axis with no server
	// watchdog involved.
	time.Sleep(m.jogDeadman + 200*time.Millisecond)
	assert.False(t, m.jogActiveNow())

	// The polite stop still works, and keepalives are refused once it begins.
	require.NoError(t, s.Stop(context.Background()))
	assert.Error(t, s.Keepalive(), "a keepalive after stop would fight the stop")
}

func TestSecondConcurrentJogIsRefused(t *testing.T) {
	m := newFakeMachine(nil, 128)
	c := newFakeClient(t, m)

	s, err := c.JogStart(context.Background(), AxisX, true, 0, PreflightOptions{})
	require.NoError(t, err)
	defer func() { _ = s.Stop(context.Background()) }()

	_, err = c.JogStart(context.Background(), AxisY, true, 0, PreflightOptions{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "never queued")
}

// ---------------------------------------------------------------------------
// Client serialisation (review §6.1)
// ---------------------------------------------------------------------------

// TestConcurrentCommandsDoNotStealReplies is the review's §6.1 scenario: two
// goroutines exchanging commands on one client. Without the command mutex,
// each drains the other's output and steals from the shared reply channel.
func TestConcurrentCommandsDoNotStealReplies(t *testing.T) {
	m := newFakeMachine(nil, 128)
	c := newFakeClient(t, m)

	var wg sync.WaitGroup
	for g := 0; g < 2; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 20; i++ {
				want := fmt.Sprintf("g%d-i%d", g, i)
				lines, err := c.CommandText(context.Background(), "echo "+want)
				if assert.NoError(t, err) && assert.Len(t, lines, 1) {
					assert.Equal(t, "echo: "+want, lines[0], "a command must receive ITS reply")
				}
			}
		}(g)
	}
	wg.Wait()
}

// TestDeliverNeverDropsTheSentinel pins the §6.2 fix: under backpressure the
// oldest message is dropped — unless it carries the completion sentinel, in
// which case the incoming message is the one sacrificed.
func TestDeliverNeverDropsTheSentinel(t *testing.T) {
	c := &Client{msgs: make(chan Message, 2)}
	ctx := context.Background()

	require.True(t, c.deliver(ctx, Message{Text: "junk-1"}))
	require.True(t, c.deliver(ctx, Message{Text: "echo: \x04"}))
	// Channel full; oldest is junk → junk goes.
	require.True(t, c.deliver(ctx, Message{Text: "junk-2"}))
	// Channel full; oldest is the sentinel → the INCOMING message goes.
	require.True(t, c.deliver(ctx, Message{Text: "junk-3"}))

	survived := false
	for len(c.msgs) > 0 {
		if m := <-c.msgs; strings.Contains(m.Text, sentinelByte) {
			survived = true
		}
	}
	assert.True(t, survived, "the sentinel must survive the overflow")
}
