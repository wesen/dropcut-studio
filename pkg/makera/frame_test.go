package makera

import (
	"bytes"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Golden vectors produced by ttmp scripts/01-frame-vectors.py, which
// cross-checks a from-scratch encoder against the vendored upstream
// implementation. Every one of these was also accepted by a real Z1.
var goldenVectors = []struct {
	name    string
	ptype   PacketType
	payload string
	hex     string
}{
	{"realtime ?", PTypeCtrlSingle, "?", "86 68 00 04 a1 3f 35 33 55 aa"},
	{"realtime 0x18", PTypeCtrlSingle, "\x18", "86 68 00 04 a1 18 61 b6 55 aa"},
	{"realtime !", PTypeCtrlSingle, "!", "86 68 00 04 a1 21 c6 cc 55 aa"},
	{"realtime ~", PTypeCtrlSingle, "~", "86 68 00 04 a1 7e 6d d6 55 aa"},
	{"version", PTypeCtrlMulti, "version", "86 68 00 0a a2 76 65 72 73 69 6f 6e cc a0 55 aa"},
	{"model", PTypeCtrlMulti, "model", "86 68 00 08 a2 6d 6f 64 65 6c 52 01 55 aa"},
	{"G0 X10 Y10", PTypeCtrlMulti, "G0 X10 Y10", "86 68 00 0d a2 47 30 20 58 31 30 20 59 31 30 9f fe 55 aa"},
	{"diagnose", PTypeCtrlMulti, "diagnose", "86 68 00 0b a2 64 69 61 67 6e 6f 73 65 76 c5 55 aa"},
	{"file-start upload", PTypeFileStart, "upload /sd/gcodes/part.nc\n",
		"86 68 00 1d b0 75 70 6c 6f 61 64 20 2f 73 64 2f 67 63 6f 64 65 73 2f 70 61 72 74 2e 6e 63 0a a4 fc 55 aa"},
	{"empty payload", PTypeCtrlMulti, "", "86 68 00 03 a2 c0 fb 55 aa"},
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(strings.ReplaceAll(s, " ", ""))
	require.NoError(t, err)
	return b
}

func TestCRC16CheckValue(t *testing.T) {
	// Guards against someone "fixing" this to CRC-16/CCITT-FALSE (init 0xFFFF),
	// whose check value is 0x29B1. Ours inits to 0x0000.
	assert.Equal(t, uint16(0x31C3), CRC16CCITT([]byte("123456789")))
}

func TestBuildFrameGoldenVectors(t *testing.T) {
	for _, v := range goldenVectors {
		t.Run(v.name, func(t *testing.T) {
			got := BuildFrame(v.ptype, []byte(v.payload))
			assert.Equal(t, mustHex(t, v.hex), got)

			// Structural invariants a future refactor must not break.
			require.GreaterOrEqual(t, len(got), 9)
			assert.Equal(t, byte(0x86), got[0])
			assert.Equal(t, byte(0x68), got[1])
			assert.Equal(t, byte(0x55), got[len(got)-2])
			assert.Equal(t, byte(0xAA), got[len(got)-1])
			declared := int(got[2])<<8 | int(got[3])
			assert.Equal(t, 1+len(v.payload)+2, declared,
				"length field must cover type + payload + crc, not payload alone")
			assert.Equal(t, 2+2+declared+2, len(got))
		})
	}
}

func TestDecoderRoundTrip(t *testing.T) {
	for _, v := range goldenVectors {
		t.Run(v.name, func(t *testing.T) {
			d := &Decoder{}
			frames := d.Feed(BuildFrame(v.ptype, []byte(v.payload)))
			require.Len(t, frames, 1)
			assert.Equal(t, v.ptype, frames[0].Type)
			assert.Equal(t, v.payload, string(frames[0].Payload))
			assert.Zero(t, d.Drops)
		})
	}
}

func TestDecoderSurvivesEverySplit(t *testing.T) {
	// A TCP socket splits frames anywhere. Every split point must work.
	full := BuildFrame(PTypeCtrlMulti, []byte("G0 X10 Y10"))
	for split := 0; split <= len(full); split++ {
		d := &Decoder{}
		got := append(d.Feed(full[:split]), d.Feed(full[split:])...)
		require.Len(t, got, 1, "split at %d", split)
		assert.Equal(t, "G0 X10 Y10", string(got[0].Payload))
	}
}

func TestDecoderMultipleFramesPerRead(t *testing.T) {
	d := &Decoder{}
	buf := append(BuildFrame(PTypeCtrlMulti, []byte("model")),
		BuildFrame(PTypeCtrlSingle, []byte("?"))...)
	frames := d.Feed(buf)
	require.Len(t, frames, 2)
	assert.Equal(t, PTypeCtrlMulti, frames[0].Type)
	assert.Equal(t, PTypeCtrlSingle, frames[1].Type)
}

func TestDecoderResyncAfterGarbage(t *testing.T) {
	d := &Decoder{}
	junk := []byte{0x00, 0x86, 0xFF, 0x0A, 'o', 'k', '\n'}
	frames := d.Feed(append(junk, BuildFrame(PTypeCtrlMulti, []byte("version"))...))
	require.Len(t, frames, 1)
	assert.Equal(t, "version", string(frames[0].Payload))
}

func TestDecoderDropsBadCRCAndContinues(t *testing.T) {
	bad := BuildFrame(PTypeCtrlMulti, []byte("version"))
	bad[6] ^= 0xFF // corrupt a payload byte, leaving the CRC stale
	d := &Decoder{}
	frames := d.Feed(append(bad, BuildFrame(PTypeCtrlMulti, []byte("model"))...))
	require.Len(t, frames, 1)
	assert.Equal(t, "model", string(frames[0].Payload))
	assert.Equal(t, 1, d.Drops)
}

func TestDecoderRejectsOversizedLength(t *testing.T) {
	d := &Decoder{}
	bogus := []byte{0x86, 0x68, 0xFF, 0xFF} // 65535 > MaxFrameDataLength
	frames := d.Feed(append(bogus, BuildFrame(PTypeCtrlMulti, []byte("model"))...))
	require.Len(t, frames, 1)
	assert.Equal(t, "model", string(frames[0].Payload))
	assert.Equal(t, 1, d.Drops)
}

// TestDecoderFalseHeaderIsLossy documents a known limitation rather than
// asserting desirable behaviour. The protocol has no byte-stuffing, so a
// payload or garbage run containing 86 68 plus a plausible length is
// indistinguishable from a real header. Upstream behaves identically.
func TestDecoderFalseHeaderIsLossy(t *testing.T) {
	d := &Decoder{}
	falseHeader := []byte{0x86, 0x68, 0x01, 0x55} // claims a 341-byte body
	swallowed := d.Feed(append(falseHeader, BuildFrame(PTypeCtrlMulti, []byte("version"))...))
	assert.Empty(t, swallowed, "the frame behind a false header is lost")

	var tail []byte
	for range 40 {
		tail = append(tail, BuildFrame(PTypeCtrlMulti, []byte("model"))...)
	}
	recovered := d.Feed(tail)
	assert.NotEmpty(t, recovered, "decoder must recover on later frames")
}

func TestParseBodyRejectsShortInput(t *testing.T) {
	_, err := ParseBody([]byte{0x00, 0x03})
	assert.Error(t, err)
}

func TestPacketTypeClassification(t *testing.T) {
	assert.True(t, PTypeFileData.IsFileTransfer())
	assert.False(t, PTypeStatusRes.IsFileTransfer())
	assert.Equal(t, "CTRL_MULTI", PTypeCtrlMulti.String())
	assert.Equal(t, "UNKNOWN", PacketType(0x77).String())
}

func TestDecoderResetClearsState(t *testing.T) {
	d := &Decoder{}
	half := BuildFrame(PTypeCtrlMulti, []byte("version"))
	d.Feed(half[:6])
	d.Reset()
	frames := d.Feed(BuildFrame(PTypeCtrlMulti, []byte("model")))
	require.Len(t, frames, 1)
	assert.True(t, bytes.Equal([]byte("model"), frames[0].Payload))
}
