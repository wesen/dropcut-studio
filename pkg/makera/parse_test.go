// SPDX-License-Identifier: GPL-2.0-only

package makera

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Every fixture in this file was captured verbatim from Makera_Z1_012146
// running firmware 1.0.15.0.1.11 on 2026-08-11. They are the ground truth the
// parsers exist to handle, including the parts that contradict published
// clients.

const (
	liveStatusLine = `<Idle|MPos:-1.0000,-1.0000,-1.0000,0.0000,0.0000|WPos:189.5200,192.7300,77.1609,-90.0000,0.0000|F:0.0,2000.0,100.0|S:0.0,10000.0,100.0,0,22.9,23.0,0,0,0,0|T:2,0.054,-1|L:0, 0, 0, 0.0,100.0|C:3,1,0,1|E:0,0,0,57,7610|OTA:0,0>`
	liveDiagLine   = `{S:0,10000,0,0,22,23|L:0,0|V:1,27|F:0,0|G:1,0,0,0,0|T:0|C:1|E:0,0,0,0,0,1,1,0|P:0,0|I:0|RSSI:-47}`
)

func TestParseLiveStatusReport(t *testing.T) {
	rep, err := ParseReport(liveStatusLine, '<', '>')
	require.NoError(t, err)
	s := InterpretStatus(rep)

	assert.Equal(t, "Idle", s.State)

	// Five axes, not three or four. Confirmed independently by `get pos`.
	assert.Equal(t, 5, len(rep.Fields["MPos"]))
	assert.Equal(t, 5, len(rep.Fields["WPos"]))
	assert.InDelta(t, 189.52, s.Work.X, 1e-9)
	assert.InDelta(t, -90.0, s.Work.A, 1e-9)

	// Stock firmware omits G:, so the active WCS is unknown from status alone.
	assert.False(t, s.CoordSystemKnown, "stock firmware does not report G:")

	// Unhomed sentinel must be surfaced rather than reported as a position.
	assert.False(t, s.Homed)

	assert.Equal(t, 2, s.Tool)
	assert.InDelta(t, 0.054, s.ToolLengthOffset, 1e-9)
	assert.InDelta(t, 2000.0, s.Feed.Target, 1e-9)
	assert.InDelta(t, 10000.0, s.Spindle.Target, 1e-9)
	assert.Nil(t, s.Playing, "no P: key means no job running")

	// Undocumented keys must survive as data rather than break the parse.
	assert.Equal(t, []float64{0, 0, 0, 57, 7610}, rep.Fields["E"])
	assert.Equal(t, []float64{0, 0}, rep.Fields["OTA"])
}

// TestParseStatusValuesWithSpaces guards the one detail that reading upstream
// source could never reveal: real machines pad values with spaces. Python's
// float() accepts them silently, so the Python clients never had to care.
func TestParseStatusValuesWithSpaces(t *testing.T) {
	rep, err := ParseReport(liveStatusLine, '<', '>')
	require.NoError(t, err)
	require.Contains(t, liveStatusLine, "L:0, 0, 0, 0.0,100.0")
	assert.Equal(t, []float64{0, 0, 0, 0, 100}, rep.Fields["L"])
}

func TestParseLiveDiagnoseReport(t *testing.T) {
	rep, err := ParseReport(liveDiagLine, '{', '}')
	require.NoError(t, err)
	d := InterpretDiagnose(rep)

	// Multi-character key with a negative value: proves the split-on-first-
	// colon rule is required.
	assert.Equal(t, -47, d.RSSI)

	// EIGHT endstop values where published clients map six. Until the field
	// order is established empirically, no accessor may claim to know which
	// index is the cover interlock.
	assert.Len(t, d.Endstops, 8)
	assert.False(t, d.EndstopMappingKnown(),
		"stock Z1 firmware sends 8 endstop values; the mapping is unconfirmed")

	assert.False(t, d.EStop)
	assert.Equal(t, 6, len(rep.Fields["S"]))
	assert.Equal(t, 5, len(rep.Fields["G"]))
}

func TestParseReportRobustness(t *testing.T) {
	t.Run("trailing junk after the closer is ignored", func(t *testing.T) {
		rep, err := ParseReport("<Idle|MPos:1,2,3|WPos:1,2,3|T:2,0.5>\x00", '<', '>')
		require.NoError(t, err)
		assert.Equal(t, 2, InterpretStatus(rep).Tool)
	})
	t.Run("unknown future key is kept", func(t *testing.T) {
		rep, err := ParseReport("<Idle|MPos:1,2,3|WPos:1,2,3|ZZ:9,8,7>", '<', '>')
		require.NoError(t, err)
		assert.Equal(t, []float64{9, 8, 7}, rep.Fields["ZZ"])
	})
	t.Run("one malformed field does not discard the report", func(t *testing.T) {
		rep, err := ParseReport("<Run|MPos:1,2,3|BAD:abc|T:4,0>", '<', '>')
		require.NoError(t, err)
		assert.Equal(t, "Run", rep.State)
		assert.NotContains(t, rep.Fields, "BAD")
		assert.Equal(t, 4, InterpretStatus(rep).Tool)
	})
	t.Run("malformed line errors", func(t *testing.T) {
		_, err := ParseReport("no brackets here", '<', '>')
		assert.Error(t, err)
	})
	t.Run("playback progress", func(t *testing.T) {
		rep, err := ParseReport("<Run|MPos:1,2,3|WPos:1,2,3|P:1234,42,600,1>", '<', '>')
		require.NoError(t, err)
		s := InterpretStatus(rep)
		require.NotNil(t, s.Playing)
		assert.Equal(t, 1234, s.Playing.Lines)
		assert.Equal(t, 42, s.Playing.Percent)
		assert.True(t, s.Playing.Active)
	})
}

func TestParseVersionKeepsAllComponents(t *testing.T) {
	v, ok := ParseVersionLine("version = 1.0.15.0.1.11")
	require.True(t, ok)
	assert.Equal(t, "1.0.15.0.1.11", v,
		"upstream's three-component regex truncates this to 1.0.15")
}

func TestParseModelLineFiveFields(t *testing.T) {
	m, ok := ParseModelLine("model = Z1, 3, 1, 0, Idle")
	require.True(t, ok)
	assert.Equal(t, "Z1", m.Model)
	assert.Equal(t, 3, m.ModelID)
	assert.Equal(t, 1, m.FuncSetting)
	assert.Equal(t, "Idle", m.State, "published clients discard this field")
}

func TestParseListingLiveCapture(t *testing.T) {
	// Verbatim, including the one-vs-two space inconsistency.
	lines := []string{
		".md5/ 0 20260516120042",
		"Examples/ 0 20260516120042",
		".lz/ 0 20260520133900",
		"goto-pack-pos-z1.nc  54 20260522094322",
		"MakeraBadge.nc  328417 20260731185808",
		"pattern-tests/ 0 20260801052734",
		"MakeraStudioWolf_TOP_20260802182236.nc  7617549 20260802182430",
		"Load directory finished.",
	}
	entries := ParseListing(lines)
	require.Len(t, entries, 7)

	assert.Equal(t, ".md5", entries[0].Name)
	assert.True(t, entries[0].IsDir, "trailing slash is the only directory marker")
	assert.EqualValues(t, 0, entries[0].Size)

	assert.Equal(t, "goto-pack-pos-z1.nc", entries[3].Name)
	assert.False(t, entries[3].IsDir)
	assert.EqualValues(t, 54, entries[3].Size)
	assert.Equal(t, 2026, entries[3].ModTime.Year())
	assert.Equal(t, 5, int(entries[3].ModTime.Month()))
	assert.Equal(t, 22, entries[3].ModTime.Day())

	assert.EqualValues(t, 7617549, entries[6].Size)
}

func TestParseListingHandlesEscapedSpacesInNames(t *testing.T) {
	entries := ParseListing([]string{"my\x01file.nc  100 20260801052734"})
	require.Len(t, entries, 1)
	assert.Equal(t, "my file.nc", entries[0].Name)
	assert.EqualValues(t, 100, entries[0].Size)
}

func TestParseMD5Concatenated(t *testing.T) {
	digest, path, ok := ParseMD5("b66caa6121c39f971ff5d97b5158b57e/sd/gcodes/goto-pack-pos-z1.nc")
	require.True(t, ok)
	assert.Equal(t, "b66caa6121c39f971ff5d97b5158b57e", digest)
	assert.Equal(t, "/sd/gcodes/goto-pack-pos-z1.nc", path)
}

// TestParseMD5RejectsPlaceholder is the reason ParseMD5 validates hex rather
// than length: the placeholder some Z1 firmware returns is exactly 32
// characters long.
func TestParseMD5RejectsPlaceholder(t *testing.T) {
	require.Len(t, "default_md5_hash_value_32_bytes_", 32)
	_, _, ok := ParseMD5("default_md5_hash_value_32_bytes_/sd/gcodes/part.nc")
	assert.False(t, ok, "32 characters is not the same as 32 hex digits")
	assert.False(t, IsHexDigest("default_md5_hash_value_32_bytes_"))
	assert.True(t, IsHexDigest("b66caa6121c39f971ff5d97b5158b57e"))
}

func TestParseWCSLiveCapture(t *testing.T) {
	lines := []string{
		"[current WCS: G54]",
		"[G54:-190.5200,-193.7300,-78.2153,90.0000,0.0000]",
		"[G55:0.0000,0.0000,0.0000,0.0000,0.0000]",
		"[G28:0.0000,0.0000,0.0000]",
		"[Tool Offset:0.0000,0.0000,0.0544]",
		"[PRB:0.0000,0.0000,0.0000:0]",
	}
	w := ParseWCS(lines)
	assert.Equal(t, "G54", w.Current)
	require.Contains(t, w.Offsets, "G54")
	assert.Len(t, w.Offsets["G54"], 5, "five components on stock firmware, six on community")
	assert.InDelta(t, -190.52, w.Offsets["G54"][0], 1e-9)
	assert.Len(t, w.Offsets["G28"], 3)
	assert.Len(t, w.Offsets["PRB"], 3, "the trailing :0 success flag must not be parsed as a coordinate")
	assert.InDelta(t, 0.0544, w.Offsets["Tool Offset"][2], 1e-9)
}

func TestParseModalState(t *testing.T) {
	words := ParseModalState([]string{"[G0 G54 G17 G21 G90 G94 M0 M5 M9 T0 F2000.0000 S1.0000]"})
	assert.Contains(t, words, "G54")
	assert.Contains(t, words, "G21")
	assert.Contains(t, words, "M5")
}

func TestWorkOffsetWithoutRotation(t *testing.T) {
	s := Status{Machine: Axes{X: 10, Y: 20, Z: 30}, Work: Axes{X: 1, Y: 2, Z: 3}}
	wco := s.WorkOffset()
	assert.InDelta(t, 9, wco.X, 1e-9)
	assert.InDelta(t, 18, wco.Y, 1e-9)
	assert.InDelta(t, 27, wco.Z, 1e-9)
}

func TestParseAnnouncementLiveCapture(t *testing.T) {
	m, err := ParseAnnouncement([]byte("Makera_Z1_012146,192.168.0.55,2222,0,Idle"))
	require.NoError(t, err)
	assert.Equal(t, "Makera_Z1_012146", m.Name)
	assert.Equal(t, "192.168.0.55", m.IP)
	assert.Equal(t, 2222, m.Port)
	assert.False(t, m.Busy)
	assert.Equal(t, "Idle", m.State, "the fifth field published clients discard")
	assert.Equal(t, "192.168.0.55:2222", m.Addr())
}

func TestParseAnnouncementRejections(t *testing.T) {
	_, err := ParseAnnouncement([]byte("tooshort,1.2.3.4,2222"))
	assert.Error(t, err)
	_, err = ParseAnnouncement([]byte("bad,1.2.3.4,notaport,0"))
	assert.Error(t, err)
}

func TestEscapeRoundTrip(t *testing.T) {
	// Spaces are escaped per-path; the other four across the whole line.
	assert.Equal(t, "my\x01file.nc", EscapePath("my file.nc"))
	assert.Equal(t, "a/b/c", EscapePath(`a\b\c`))
	assert.Equal(t, "ls -e -s \x02x", EscapeLine("ls -e -s ?x"))
	assert.Equal(t, "my file.nc", Unescape(EscapePath("my file.nc")))
	assert.Equal(t, "a?b&c!d~e", Unescape(EscapeLine("a?b&c!d~e")))
}
