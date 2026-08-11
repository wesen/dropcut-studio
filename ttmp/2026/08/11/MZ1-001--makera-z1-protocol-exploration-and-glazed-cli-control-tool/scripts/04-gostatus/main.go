// Experiment 04 — Go parser for the two Smoothie/Makera report payloads.
//
// Assumption under test: the `<...>` status report and the `{...}` diagnose
// report are both "state | KEY:csv-floats | KEY:csv-floats ..." and can be
// decoded generically into a map before any field-specific interpretation. That
// matters because the field set grows with firmware: a generic decoder plus a
// tolerant field mapper survives new keys, whereas a fixed regex does not.
//
// Run:
//     cd scripts/04-gostatus && GOWORK=off go run .
//
// Expected: every line prints "ok", final line "PASS".
package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Report is the generic decode of one bracketed machine report.
type Report struct {
	State  string               // only set for `<...>` status reports
	Fields map[string][]float64 // key -> comma-separated numeric values
}

// ParseBracketed decodes `<...>` (status) or `{...}` (diagnose).
//
// Deliberately mirrors Controller.parseBracketAngle / parseBigParentheses:
// find the outermost delimiters (a trailing junk byte after the closer must not
// poison the last field), split on '|', then split each chunk on the FIRST ':'
// (the diagnose report contains "RSSI:-57", and firmware has shipped keys with
// colons in the value before).
func ParseBracketed(line string, open, close byte) (*Report, error) {
	start := strings.IndexByte(line, open)
	end := strings.LastIndexByte(line, close)
	if start < 0 || end <= start {
		return nil, fmt.Errorf("malformed report: %q", line)
	}
	body := line[start+1 : end]
	parts := strings.Split(body, "|")

	rep := &Report{Fields: map[string][]float64{}}
	for i, part := range parts {
		key, valueStr, found := strings.Cut(part, ":")
		if !found {
			// The first chunk of a status report is the bare state word.
			if i == 0 && open == '<' {
				rep.State = part
				continue
			}
			continue // unknown chunk shape: skip rather than fail the whole report
		}
		var values []float64
		bad := false
		for _, tok := range strings.Split(valueStr, ",") {
			v, err := strconv.ParseFloat(strings.TrimSpace(tok), 64)
			if err != nil {
				bad = true
				break
			}
			values = append(values, v)
		}
		if bad {
			continue // skip this key, keep the rest of the report
		}
		rep.Fields[key] = values
	}
	if open == '<' && rep.State == "" && len(parts) > 0 {
		rep.State = parts[0]
	}
	return rep, nil
}

// At returns field[key][idx] and whether it was present.
func (r *Report) At(key string, idx int) (float64, bool) {
	v, ok := r.Fields[key]
	if !ok || idx >= len(v) {
		return 0, false
	}
	return v[idx], true
}

// Status is the interpreted status report. Optional fields are only meaningful
// when their key was present; absent keys keep zero values, matching upstream.
type Status struct {
	State                  string
	MachineX, MachineY     float64
	MachineZ, MachineA     float64
	WorkX, WorkY           float64
	WorkZ, WorkA           float64
	RotationAngle          float64
	ActiveCoordSystem      int
	FeedCurrent, FeedTgt   float64
	FeedOverride           float64
	SpindleCur, SpindleTgt float64
	SpindleOverride        float64
	Tool                   int
	ToolLengthOffset       float64
	PlayedLines            int
	PlayedPercent          int
	PlayedSeconds          int
	IsPlaying              bool
	HaltReason             int
}

// InterpretStatus maps a generic Report onto named fields.
//
// Field semantics come from Controller.parseBracketAngle (community controller):
//
//	MPos:x,y,z[,a]        machine position
//	WPos:x,y,z[,a]        work position
//	R:angle               WCS rotation (community firmware only)
//	G:n                   active coordinate system index (0 = G54)
//	F:cur,target,ovr[,t]  feed rate, target, override %, (legacy spindle temp)
//	S:cur,tgt,ovr[,...]   spindle rpm, target, override %, vacuum mode, temp, ...
//	T:tool,tlo[,tgt,collet]
//	P:lines,percent,secs[,playing]
//	H:reason              halt reason (community firmware)
//	C:model,func,inch,abs
func InterpretStatus(r *Report) Status {
	s := Status{State: r.State}
	s.MachineX, _ = r.At("MPos", 0)
	s.MachineY, _ = r.At("MPos", 1)
	s.MachineZ, _ = r.At("MPos", 2)
	s.MachineA, _ = r.At("MPos", 3)
	s.WorkX, _ = r.At("WPos", 0)
	s.WorkY, _ = r.At("WPos", 1)
	s.WorkZ, _ = r.At("WPos", 2)
	s.WorkA, _ = r.At("WPos", 3)
	s.RotationAngle, _ = r.At("R", 0)
	if v, ok := r.At("G", 0); ok {
		s.ActiveCoordSystem = int(v)
	}
	s.FeedCurrent, _ = r.At("F", 0)
	s.FeedTgt, _ = r.At("F", 1)
	s.FeedOverride, _ = r.At("F", 2)
	s.SpindleCur, _ = r.At("S", 0)
	s.SpindleTgt, _ = r.At("S", 1)
	s.SpindleOverride, _ = r.At("S", 2)
	if v, ok := r.At("T", 0); ok {
		s.Tool = int(v)
	} else {
		s.Tool = -1
	}
	s.ToolLengthOffset, _ = r.At("T", 1)
	if v, ok := r.At("P", 0); ok {
		s.PlayedLines = int(v)
	} else {
		s.PlayedLines = -1
	}
	if v, ok := r.At("P", 1); ok {
		s.PlayedPercent = int(v)
	}
	if v, ok := r.At("P", 2); ok {
		s.PlayedSeconds = int(v)
	}
	if v, ok := r.At("P", 3); ok {
		s.IsPlaying = v != 0
	}
	if v, ok := r.At("H", 0); ok {
		s.HaltReason = int(v)
	}
	return s
}

func main() {
	fail := 0
	check := func(ok bool, format string, args ...any) {
		tag := "ok  "
		if !ok {
			tag = "FAIL"
			fail++
		}
		fmt.Printf("%s %s\n", tag, fmt.Sprintf(format, args...))
	}

	// Sample line taken verbatim from the comment in Controller.parseBracketAngle.
	full := "<Idle|MPos:68.9980,-49.9240,40.0000,12.3456|WPos:68.9980,-49.9240,40.0000,5.3|R:0.0|G:0|F:12345.12,100.0|S:1.2,100.0|T:1|L:0>"
	rep, err := ParseBracketed(full, '<', '>')
	check(err == nil, "parse documented status line")
	st := InterpretStatus(rep)
	check(st.State == "Idle", "state == Idle (got %q)", st.State)
	check(st.MachineX == 68.998 && st.MachineA == 12.3456, "MPos x/a decoded")
	check(st.WorkA == 5.3, "WPos 4th axis decoded")
	check(st.ActiveCoordSystem == 0, "G:0 -> G54")
	check(st.Tool == 1, "tool 1")

	// Minimal 3-axis line with no optional keys: everything optional must degrade
	// gracefully rather than panic on a missing index.
	min := "<Run|MPos:1.0,2.0,3.0|WPos:0.5,0.5,0.5>"
	rep2, err := ParseBracketed(min, '<', '>')
	check(err == nil, "parse minimal status line")
	st2 := InterpretStatus(rep2)
	check(st2.State == "Run" && st2.MachineA == 0 && st2.Tool == -1 && st2.PlayedLines == -1,
		"missing optional keys degrade to sentinels")

	// Playback progress line.
	play := "<Run|MPos:1,2,3|WPos:1,2,3|P:1234,42,600,1|H:0>"
	rep3, _ := ParseBracketed(play, '<', '>')
	st3 := InterpretStatus(rep3)
	check(st3.PlayedLines == 1234 && st3.PlayedPercent == 42 && st3.PlayedSeconds == 600 && st3.IsPlaying,
		"playback progress decoded")

	// A trailing junk byte after '>' must not poison the last field.
	junky := "<Idle|MPos:1,2,3|WPos:1,2,3|T:2,0.5>\x00"
	rep4, err := ParseBracketed(junky, '<', '>')
	check(err == nil && InterpretStatus(rep4).Tool == 2, "trailing junk after '>' ignored")

	// An unknown future key must be preserved, not fatal.
	future := "<Idle|MPos:1,2,3|WPos:1,2,3|ZZ:9,8,7>"
	rep5, _ := ParseBracketed(future, '<', '>')
	check(len(rep5.Fields["ZZ"]) == 3, "unknown key kept in the generic map")

	// Diagnose report — same shape, braces, all-integer values, key with a
	// negative value (RSSI) and a multi-character key.
	diag := "{S:0,5000|L:0,0|F:1,0|V:0,1|G:0|T:0|E:0,0,0,0,0,0|P:0,0|A:1,0|RSSI:-57}"
	drep, err := ParseBracketed(diag, '{', '}')
	check(err == nil, "parse documented diagnose line")
	rssi, ok := drep.At("RSSI", 0)
	check(ok && rssi == -57, "RSSI:-57 decoded (split on FIRST colon)")
	check(len(drep.Fields["E"]) == 6, "endstop vector E has 6 entries")

	// Malformed input returns an error rather than panicking.
	_, err = ParseBracketed("no brackets here", '<', '>')
	check(err != nil, "malformed line returns an error")

	if fail > 0 {
		fmt.Printf("\n%d check(s) failed\n", fail)
		os.Exit(1)
	}
	fmt.Println("\nPASS")
}
