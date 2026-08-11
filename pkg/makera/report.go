// SPDX-License-Identifier: GPL-2.0-only

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

	// Homed is false when the machine reports the unhomed sentinel of -1 on
	// all three linear axes. Reporting a position that looks real when the
	// machine has no reference is worse than reporting nothing.
	Homed bool

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
	s.Homed = !(s.Machine.X == -1 && s.Machine.Y == -1 && s.Machine.Z == -1)
	return s
}

// Diagnose is the interpreted diagnose report.
//
// NOTE: the endstop vector `E:` carries EIGHT values on real Z1 firmware where
// published clients map six (xMin, xMax, yMin, yMax, zMax, cover). The mapping
// may be shifted rather than merely truncated, so the individual endstop and
// cover accessors are deliberately NOT provided. Reading index 5 as "cover"
// could report a closed cover while it is open, which is precisely the failure
// a safety interlock exists to prevent. Use Endstops to see the raw vector, and
// establish the mapping empirically before building anything on it.
type Diagnose struct {
	Endstops []float64
	EStop    bool
	Probe    bool
	RSSI     int
	Raw      *Report
}

// EndstopMappingKnown reports whether the endstop vector matches the length
// published clients assume. It is false on stock Z1 firmware.
func (d Diagnose) EndstopMappingKnown() bool { return len(d.Endstops) == 6 }

// InterpretDiagnose maps a generic Report onto named fields.
func InterpretDiagnose(r *Report) Diagnose {
	d := Diagnose{
		Endstops: r.Fields["E"],
		EStop:    r.Int("I", 0, 0) != 0,
		Probe:    r.Int("P", 0, 0) != 0,
		RSSI:     r.Int("RSSI", 0, 0),
		Raw:      r,
	}
	return d
}
