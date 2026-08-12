package makera

import (
	"math"
	"strconv"
	"strings"

	"github.com/pkg/errors"
)

// Report is the generic decode of one bracketed machine report.
//
// Both machine reports share a grammar:
//
//	<STATE|KEY:v,v,v|KEY:v|...>     status,   reply to the realtime '?'
//	{KEY:v,v|KEY:v|...}             diagnose, reply to "diagnose"
//
// Decoding generically first and interpreting named fields second is not a
// stylistic preference. Firmware adds keys over time: a real Z1 running
// 1.0.15.0.1.11 emits `E:` and `OTA:` in its status report, and neither appears
// in any published client. Under this design they arrive as data; under a fixed
// regular expression they would be a parse failure.
type Report struct {
	State  string
	Fields map[string][]float64
	Raw    string
}

// ParseReport decodes a bracketed report.
//
// Three rules, each corresponding to a specific way naive parsers break:
//
//  1. Use the OUTERMOST delimiters. A stray byte after the closing bracket
//     must not be absorbed into the final field.
//  2. Split each chunk on the FIRST colon only. Keys like `RSSI:-57` and
//     `OTA:0,0` exist; splitting on every colon mangles them.
//  3. Tolerate whitespace inside value lists. A real machine emits
//     `L:0, 0, 0, 0.0,100.0` — with spaces. Python's float() accepts these
//     silently, which is why reading upstream source never reveals the issue.
func ParseReport(line string, open, close byte) (*Report, error) {
	start := strings.IndexByte(line, open)
	end := strings.LastIndexByte(line, close)
	if start < 0 || end <= start {
		return nil, errors.Errorf("malformed report: %q", line)
	}
	body := line[start+1 : end]
	rep := &Report{Fields: map[string][]float64{}, Raw: line[start : end+1]}

	for i, part := range strings.Split(body, "|") {
		key, valueStr, found := strings.Cut(part, ":")
		if !found {
			// The first chunk of a status report is the bare state word.
			if i == 0 && open == '<' {
				rep.State = strings.TrimSpace(part)
			}
			continue
		}
		values := make([]float64, 0, 4)
		ok := true
		for _, tok := range strings.Split(valueStr, ",") {
			v, err := strconv.ParseFloat(strings.TrimSpace(tok), 64)
			if err != nil {
				ok = false
				break
			}
			values = append(values, v)
		}
		if !ok {
			// Skip the unparseable key, keep the rest of the report. A single
			// malformed field must not discard a whole status update.
			continue
		}
		rep.Fields[strings.TrimSpace(key)] = values
	}
	return rep, nil
}

// At returns Fields[key][idx] and whether it was present.
func (r *Report) At(key string, idx int) (float64, bool) {
	v, ok := r.Fields[key]
	if !ok || idx < 0 || idx >= len(v) {
		return 0, false
	}
	return v[idx], true
}

// Int is At with an integer conversion and a default.
func (r *Report) Int(key string, idx int, def int) int {
	if v, ok := r.At(key, idx); ok {
		return int(v)
	}
	return def
}

// Float is At with a default.
func (r *Report) Float(key string, idx int, def float64) float64 {
	if v, ok := r.At(key, idx); ok {
		return v
	}
	return def
}

// Axes holds a position vector. Real Z1 firmware reports five axes in both
// MPos and WPos — X, Y, Z, A, B — which is two more than the three the
// published clients read. Confirmed independently by the `get pos` command.
type Axes struct {
	X, Y, Z, A, B float64
}

func axesFrom(r *Report, key string) Axes {
	return Axes{
		X: r.Float(key, 0, 0),
		Y: r.Float(key, 1, 0),
		Z: r.Float(key, 2, 0),
		A: r.Float(key, 3, 0),
		B: r.Float(key, 4, 0),
	}
}

// Rate is a current/target/override triple, used for feed and spindle.
type Rate struct {
	Current  float64
	Target   float64
	Override float64
}

// Playback is present only while a job is running.
type Playback struct {
	Lines   int
	Percent int
	Seconds int
	Active  bool
}

// Status is the interpreted status report.
type Status struct {
	State   string
	Machine Axes
	Work    Axes

	// RotationAngle is reported as `R:` by community firmware only. Stock
	// firmware omits it and the value stays zero.
	RotationAngle float64

	// CoordSystem is the active work coordinate system index, 0 = G54.
	// Stock Z1 firmware does NOT report `G:`, so this is only meaningful when
	// CoordSystemKnown is true; otherwise query it with `get wcs`.
	CoordSystem      int
	CoordSystemKnown bool

	Feed    Rate
	Spindle Rate

	Tool             int
	ToolLengthOffset float64

	Playing    *Playback
	HaltReason int

	// AtRestPosition is true when MPos reads exactly -1,-1,-1. That position
	// is AMBIGUOUS: it is the boot position AND the post-homing rest position
	// (the machine parks ~1mm off the max switches after homing — watched on
	// hardware 2026-08-12, observations §12). Stock firmware never reports
	// its homed flag in any status field, so homing is UNKNOWABLE from a
	// status report:
	//
	//   MPos == -1,-1,-1 → unhomed OR freshly homed and parked. Cannot tell.
	//   MPos != -1,-1,-1 → the machine has moved since boot or homing —
	//                      which still proves nothing, because an unhomed
	//                      machine jogs too.
	//
	// Consumers must treat homing as advisory. The firmware itself is the
	// real gate: an absolute move on an unhomed machine answers "<axis> axis
	// is not homed", and `play` silently does nothing.
	AtRestPosition bool

	Raw *Report
}

// WorkOffset derives the work coordinate offset from machine and work
// positions. When a rotation is active the relationship is not a plain
// subtraction; with a zero angle this collapses to machine - work.
func (s Status) WorkOffset() Axes {
	rad := s.RotationAngle * math.Pi / 180
	cos, sin := math.Cos(rad), math.Sin(rad)
	return Axes{
		X: s.Machine.X - (cos*s.Work.X - sin*s.Work.Y),
		Y: s.Machine.Y - (sin*s.Work.X + cos*s.Work.Y),
		Z: s.Machine.Z - s.Work.Z,
		A: s.Machine.A - s.Work.A,
	}
}

// InterpretStatus maps a generic Report onto named fields.
func InterpretStatus(r *Report) Status {
	s := Status{
		State:            r.State,
		Machine:          axesFrom(r, "MPos"),
		Work:             axesFrom(r, "WPos"),
		RotationAngle:    r.Float("R", 0, 0),
		Tool:             r.Int("T", 0, -1),
		ToolLengthOffset: r.Float("T", 1, 0),
		HaltReason:       r.Int("H", 0, 0),
		Raw:              r,
	}
	if v, ok := r.At("G", 0); ok {
		s.CoordSystem, s.CoordSystemKnown = int(v), true
	}
	s.Feed = Rate{r.Float("F", 0, 0), r.Float("F", 1, 0), r.Float("F", 2, 0)}
	s.Spindle = Rate{r.Float("S", 0, 0), r.Float("S", 1, 0), r.Float("S", 2, 0)}

	if _, ok := r.Fields["P"]; ok {
		s.Playing = &Playback{
			Lines:   r.Int("P", 0, -1),
			Percent: r.Int("P", 1, 0),
			Seconds: r.Int("P", 2, 0),
			Active:  r.Int("P", 3, 0) != 0,
		}
	}
	s.AtRestPosition = s.Machine.X == -1 && s.Machine.Y == -1 && s.Machine.Z == -1
	return s
}

// Endstop vector indices.
//
// Real Z1 firmware sends EIGHT values where published clients map six. The
// mapping was established empirically on firmware 1.0.15.0.1.11 (2026-08-11) by
// triggering one physical input at a time and diffing the report.
//
// The result: the vector is APPENDED, not shifted. Index 5 is the cover
// interlock exactly where published clients put it, and indices 6 and 7 are
// additional fields that were constant (1 and 0) throughout the session.
//
// Confirmed by observation:
//
//	E[5]  cover interlock — 1 when closed, 0 when open (three transitions)
//
// Inherited from published clients and NOT independently verified, because
// triggering an axis limit requires motion:
//
//	E[0]  X min   E[1]  X max
//	E[2]  Y min   E[3]  Y max
//	E[4]  Z max
const (
	EndstopXMin  = 0
	EndstopXMax  = 1
	EndstopYMin  = 2
	EndstopYMax  = 3
	EndstopZMax  = 4
	EndstopCover = 5

	// endstopMinFields is the number of elements required before any index in
	// the published mapping can be read.
	endstopMinFields = 6
)

// Diagnose is the interpreted diagnose report.
type Diagnose struct {
	Endstops []float64
	EStop    bool
	// Probe is P[0], the 3D touch probe. Not exercised during the mapping
	// session, so this index is inherited from published clients.
	Probe bool
	// ToolSetter is P[1], which published clients call "calibrate". Confirmed:
	// it toggled twice when the tool-length sensor was touched.
	ToolSetter bool
	RSSI       int
	Raw        *Report
}

// EndstopMappingKnown reports whether the endstop vector is long enough for the
// published index mapping to apply.
//
// True on real Z1 firmware: the vector has eight elements, of which the first
// six follow the documented layout and the remaining two are additions.
func (d Diagnose) EndstopMappingKnown() bool { return len(d.Endstops) >= endstopMinFields }

// CoverClosed reports the cover interlock.
//
// The second return value is false when the machine did not send enough endstop
// fields to locate the bit. Callers gating motion on this MUST treat unknown as
// "do not proceed" rather than as "closed" — a preflight that cannot verify the
// cover has not verified the cover.
func (d Diagnose) CoverClosed() (closed, known bool) {
	if !d.EndstopMappingKnown() {
		return false, false
	}
	return d.Endstops[EndstopCover] != 0, true
}

// EndstopTriggered reports one endstop by index, using the constants above.
// Indices 0-4 are inherited from published clients rather than verified here.
func (d Diagnose) EndstopTriggered(idx int) (triggered, known bool) {
	if idx < 0 || idx >= len(d.Endstops) || !d.EndstopMappingKnown() {
		return false, false
	}
	return d.Endstops[idx] != 0, true
}

// ExtraEndstopFields returns the elements beyond the published mapping. On
// firmware 1.0.15.0.1.11 these were constant (1, 0) and their meaning is
// unknown; they are surfaced rather than dropped.
func (d Diagnose) ExtraEndstopFields() []float64 {
	if len(d.Endstops) <= endstopMinFields {
		return nil
	}
	return d.Endstops[endstopMinFields:]
}

// InterpretDiagnose maps a generic Report onto named fields.
func InterpretDiagnose(r *Report) Diagnose {
	d := Diagnose{
		Endstops:   r.Fields["E"],
		EStop:      r.Int("I", 0, 0) != 0,
		Probe:      r.Int("P", 0, 0) != 0,
		ToolSetter: r.Int("P", 1, 0) != 0,
		RSSI:       r.Int("RSSI", 0, 0),
		Raw:        r,
	}
	return d
}
