// Experiment 02 — Go port of the Makera frame codec, checked against the golden
// vectors produced by scripts/01-frame-vectors.py.
//
// Assumption under test: the codec described in the design doc can be written in
// ~80 lines of dependency-free Go, and a byte-at-a-time receiver state machine
// resynchronises correctly when garbage precedes a frame or a frame is split
// across reads (which is what a TCP socket will actually do).
//
// Run:
//     cd scripts/02-goframe && GOWORK=off go run .
//
// Expected: every line prints "ok", final line "PASS".
package main

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
)

const (
	frameHeader = 0x8668
	frameEnd    = 0x55AA

	PTypeCtrlSingle = 0xA1
	PTypeCtrlMulti  = 0xA2
	PTypeFileStart  = 0xB0

	maxFrameDataLength = 8200
)

// crc16CCITT is poly 0x1021, init 0x0000, no reflection, no final XOR.
// It is computed over length+type+payload — never over header or footer.
func crc16CCITT(data []byte) uint16 {
	var crc uint16
	for _, b := range data {
		crc ^= uint16(b) << 8
		for i := 0; i < 8; i++ {
			if crc&0x8000 != 0 {
				crc = (crc << 1) ^ 0x1021
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}

// BuildFrame encodes one Makera frame.
//
//	header(2) | length(2) | type(1) | payload(N) | crc(2) | footer(2)
//	length = 1 (type) + N (payload) + 2 (crc)
func BuildFrame(ptype byte, payload []byte) []byte {
	length := 1 + len(payload) + 2
	body := make([]byte, 0, 3+len(payload))
	body = append(body, byte(length>>8), byte(length))
	body = append(body, ptype)
	body = append(body, payload...)
	crc := crc16CCITT(body)
	out := make([]byte, 0, len(body)+6)
	out = append(out, byte(frameHeader>>8), byte(frameHeader&0xFF))
	out = append(out, body...)
	out = append(out, byte(crc>>8), byte(crc))
	out = append(out, byte(frameEnd>>8), byte(frameEnd&0xFF))
	return out
}

// Frame is one decoded packet.
type Frame struct {
	Type    byte
	Payload []byte
}

type rxState int

const (
	waitHeader rxState = iota
	readLength
	readData
	checkFooter
)

// Decoder is a byte-at-a-time receiver. Feed it whatever a socket read returns;
// it emits zero or more complete frames. It never blocks and never allocates
// unboundedly: a bogus length field simply resets it to header hunting.
type Decoder struct {
	state    rxState
	body     []byte // length(2) + type(1) + payload(N) + crc(2)
	hdr      [2]byte
	ftr      [2]byte
	needed   int
	expected int
}

func (d *Decoder) Feed(data []byte) []Frame {
	var out []Frame
	for _, b := range data {
		if f, ok := d.feedByte(b); ok {
			out = append(out, f)
		}
	}
	return out
}

func (d *Decoder) feedByte(b byte) (Frame, bool) {
	switch d.state {
	case waitHeader:
		d.hdr[0], d.hdr[1] = d.hdr[1], b
		if uint16(d.hdr[0])<<8|uint16(d.hdr[1]) == frameHeader {
			d.state = readLength
			d.needed = 2
			d.body = d.body[:0]
		}
	case readLength:
		d.body = append(d.body, b)
		d.needed--
		if d.needed == 0 {
			d.expected = int(d.body[0])<<8 | int(d.body[1])
			if d.expected >= 0 && d.expected <= maxFrameDataLength {
				d.state = readData
				d.needed = d.expected
			} else {
				d.state = waitHeader
			}
		}
	case readData:
		d.body = append(d.body, b)
		d.needed--
		if d.needed == 0 {
			d.state = checkFooter
			d.needed = 2
		}
	case checkFooter:
		d.ftr[0], d.ftr[1] = d.ftr[1], b
		d.needed--
		if d.needed == 0 {
			d.state = waitHeader
			if uint16(d.ftr[0])<<8|uint16(d.ftr[1]) != frameEnd {
				return Frame{}, false
			}
			f, err := parseBody(d.body)
			if err != nil {
				return Frame{}, false
			}
			return f, true
		}
	}
	return Frame{}, false
}

var errBadCRC = errors.New("crc mismatch")

func parseBody(body []byte) (Frame, error) {
	if len(body) < 5 {
		return Frame{}, errors.New("short frame")
	}
	want := uint16(body[len(body)-2])<<8 | uint16(body[len(body)-1])
	if crc16CCITT(body[:len(body)-2]) != want {
		return Frame{}, errBadCRC
	}
	payload := make([]byte, len(body)-5)
	copy(payload, body[3:len(body)-2])
	return Frame{Type: body[2], Payload: payload}, nil
}

// ---------------------------------------------------------------------------

type vector struct {
	name    string
	ptype   byte
	payload string
	hexOut  string
}

// Golden vectors copied verbatim from the output of scripts/01-frame-vectors.py,
// which cross-checks a from-scratch encoder against the vendored Community
// Controller implementation.
var vectors = []vector{
	{"realtime '?'", PTypeCtrlSingle, "?", "86 68 00 04 a1 3f 35 33 55 aa"},
	{"realtime 0x18", PTypeCtrlSingle, "\x18", "86 68 00 04 a1 18 61 b6 55 aa"},
	{"realtime '!'", PTypeCtrlSingle, "!", "86 68 00 04 a1 21 c6 cc 55 aa"},
	{"realtime '~'", PTypeCtrlSingle, "~", "86 68 00 04 a1 7e 6d d6 55 aa"},
	{"command 'version'", PTypeCtrlMulti, "version", "86 68 00 0a a2 76 65 72 73 69 6f 6e cc a0 55 aa"},
	{"command 'model'", PTypeCtrlMulti, "model", "86 68 00 08 a2 6d 6f 64 65 6c 52 01 55 aa"},
	{"command 'G0 X10 Y10'", PTypeCtrlMulti, "G0 X10 Y10", "86 68 00 0d a2 47 30 20 58 31 30 20 59 31 30 9f fe 55 aa"},
	{"command 'diagnose'", PTypeCtrlMulti, "diagnose", "86 68 00 0b a2 64 69 61 67 6e 6f 73 65 76 c5 55 aa"},
	{"file-start upload", PTypeFileStart, "upload /sd/gcodes/part.nc\n", "86 68 00 1d b0 75 70 6c 6f 61 64 20 2f 73 64 2f 67 63 6f 64 65 73 2f 70 61 72 74 2e 6e 63 0a a4 fc 55 aa"},
	{"empty payload", PTypeCtrlMulti, "", "86 68 00 03 a2 c0 fb 55 aa"},
}

func mustHex(s string) []byte {
	b, err := hex.DecodeString(strings.ReplaceAll(s, " ", ""))
	if err != nil {
		panic(err)
	}
	return b
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

	if crc16CCITT([]byte("123456789")) != 0x31C3 {
		fmt.Println("FAIL crc check value")
		os.Exit(1)
	}
	check(true, `crc16("123456789") == 0x31C3`)

	// 1. Encoder matches the golden vectors byte for byte.
	for _, v := range vectors {
		got := BuildFrame(v.ptype, []byte(v.payload))
		check(bytes.Equal(got, mustHex(v.hexOut)), "encode %s -> %s", v.name, hex.EncodeToString(got))
	}

	// 2. Round-trip through the decoder.
	for _, v := range vectors {
		d := &Decoder{}
		frames := d.Feed(BuildFrame(v.ptype, []byte(v.payload)))
		ok := len(frames) == 1 && frames[0].Type == v.ptype && string(frames[0].Payload) == v.payload
		check(ok, "roundtrip %s", v.name)
	}

	// 3a. Resynchronisation: ordinary leading garbage (including a lone 0x86 not
	//     followed by 0x68) must not break the decoder — this happens whenever we
	//     attach to a machine mid-stream.
	{
		d := &Decoder{}
		junk := []byte{0x00, 0x86, 0xFF, 0x0A, 'o', 'k', '\n'}
		frames := d.Feed(append(junk, BuildFrame(PTypeCtrlMulti, []byte("version"))...))
		check(len(frames) == 1 && string(frames[0].Payload) == "version", "resync after leading garbage")
	}

	// 3b. KNOWN LIMITATION (shared with the upstream Python decoder): if the
	//     garbage happens to contain the two bytes 86 68 followed by a plausible
	//     length, the decoder locks onto the false header and swallows the frames
	//     that follow until the length runs out and the footer check fails. It
	//     recovers, but data is lost. A Go implementation should log this.
	{
		d := &Decoder{}
		falseHeader := []byte{0x86, 0x68, 0x01, 0x55} // claims a 341-byte body
		stream := append(falseHeader, BuildFrame(PTypeCtrlMulti, []byte("version"))...)
		swallowed := d.Feed(stream)
		// Enough follow-on traffic to run past the bogus length and re-sync.
		var tail []byte
		for i := 0; i < 40; i++ {
			tail = append(tail, BuildFrame(PTypeCtrlMulti, []byte("model"))...)
		}
		recovered := d.Feed(tail)
		check(len(swallowed) == 0, "false header swallows the frame behind it (known limitation)")
		check(len(recovered) > 0, "decoder recovers on later frames after a false header")
	}

	// 4. Split reads: a TCP socket splits frames anywhere. Feed one byte at a
	//    time and also at every possible 2-way split point.
	{
		full := BuildFrame(PTypeCtrlMulti, []byte("G0 X10 Y10"))
		allOK := true
		for split := 0; split <= len(full); split++ {
			d := &Decoder{}
			got := append(d.Feed(full[:split]), d.Feed(full[split:])...)
			if len(got) != 1 || string(got[0].Payload) != "G0 X10 Y10" {
				allOK = false
			}
		}
		check(allOK, "decode survives every 2-way split (%d positions)", len(full)+1)
	}

	// 5. Two frames back to back in one read.
	{
		d := &Decoder{}
		buf := append(BuildFrame(PTypeCtrlMulti, []byte("model")), BuildFrame(PTypeCtrlSingle, []byte("?"))...)
		frames := d.Feed(buf)
		check(len(frames) == 2 && frames[0].Type == PTypeCtrlMulti && frames[1].Type == PTypeCtrlSingle,
			"two frames in one read")
	}

	// 6. Corrupted CRC is dropped, and the decoder still reads the next frame.
	{
		bad := BuildFrame(PTypeCtrlMulti, []byte("version"))
		bad[6] ^= 0xFF // flip a payload byte, leaving the CRC stale
		d := &Decoder{}
		frames := d.Feed(append(bad, BuildFrame(PTypeCtrlMulti, []byte("model"))...))
		check(len(frames) == 1 && string(frames[0].Payload) == "model", "bad CRC dropped, next frame still parsed")
	}

	// 7. Bogus length field must not wedge the decoder.
	{
		d := &Decoder{}
		bogus := []byte{0x86, 0x68, 0xFF, 0xFF} // length 65535 > maxFrameDataLength
		frames := d.Feed(append(bogus, BuildFrame(PTypeCtrlMulti, []byte("model"))...))
		check(len(frames) == 1 && string(frames[0].Payload) == "model", "oversized length rejected without wedging")
	}

	if fail > 0 {
		fmt.Printf("\n%d check(s) failed\n", fail)
		os.Exit(1)
	}
	fmt.Println("\nPASS")
}
