// Makera framed binary protocol codec.
//
// Written from the specification in ttmp MZ1-001 (docs/protocol.md), not ported
// from upstream. Validated offline against golden vectors and, on 2026-08-11,
// against a real Makera Z1 running firmware 1.0.15.0.1.11 with zero decode
// failures across five sessions.
package makera

import (
	"github.com/pkg/errors"
)

// Wire constants.
//
//	header(2) | length(2) | type(1) | payload(N) | crc(2) | footer(2)
//	length = 1 (type) + N (payload) + 2 (crc)
//	crc covers length+type+payload — never the header or footer
//	big-endian throughout
const (
	FrameHeader = 0x8668
	FrameEnd    = 0x55AA

	// MaxFrameDataLength bounds the declared length field. The largest
	// legitimate frame is a Wi-Fi file-data block: 8192 data + 4 sequence
	// + 1 type + 2 crc = 8199.
	MaxFrameDataLength = 8200
)

// PacketType identifies what a frame carries.
type PacketType byte

const (
	PTypeCtrlSingle PacketType = 0xA1 // host→machine: one realtime control byte
	PTypeCtrlMulti  PacketType = 0xA2 // host→machine: a text command
	PTypeFileStart  PacketType = 0xB0 // host→machine: "upload …" / "download …"
	PTypeFileMD5    PacketType = 0xB1
	PTypeFileView   PacketType = 0xB2
	PTypeFileData   PacketType = 0xB3
	PTypeFileEnd    PacketType = 0xB4
	PTypeFileCan    PacketType = 0xB5
	PTypeFileRetry  PacketType = 0xB6
	PTypeStatusRes  PacketType = 0x81 // machine→host: reply to '?'
	PTypeDiagRes    PacketType = 0x82 // machine→host: reply to "diagnose"
	PTypeLoadInfo   PacketType = 0x83 // machine→host: bulk listing chunk
	PTypeLoadFinish PacketType = 0x84 // machine→host: bulk listing EOF
	PTypeLoadError  PacketType = 0x85
	PTypeNormalInfo PacketType = 0x90 // machine→host: unsolicited text
)

var pTypeNames = map[PacketType]string{
	PTypeCtrlSingle: "CTRL_SINGLE", PTypeCtrlMulti: "CTRL_MULTI",
	PTypeFileStart: "FILE_START", PTypeFileMD5: "FILE_MD5",
	PTypeFileView: "FILE_VIEW", PTypeFileData: "FILE_DATA",
	PTypeFileEnd: "FILE_END", PTypeFileCan: "FILE_CAN",
	PTypeFileRetry: "FILE_RETRY", PTypeStatusRes: "STATUS_RES",
	PTypeDiagRes: "DIAG_RES", PTypeLoadInfo: "LOAD_INFO",
	PTypeLoadFinish: "LOAD_FINISH", PTypeLoadError: "LOAD_ERROR",
	PTypeNormalInfo: "NORMAL_INFO",
}

func (t PacketType) String() string {
	if n, ok := pTypeNames[t]; ok {
		return n
	}
	return "UNKNOWN"
}

// IsFileTransfer reports whether this type belongs to the file-transfer
// exchange. Those frames are owned by the transfer driver; the control-mode
// dispatcher must ignore them rather than treat them as machine output.
func (t PacketType) IsFileTransfer() bool {
	switch t {
	case PTypeFileStart, PTypeFileMD5, PTypeFileView,
		PTypeFileData, PTypeFileEnd, PTypeFileCan, PTypeFileRetry:
		return true
	}
	return false
}

// CRC16CCITT is polynomial 0x1021, init 0x0000, no reflection, no final XOR.
//
// Note this is NOT CRC-16/CCITT-FALSE, which inits to 0xFFFF. The check value
// here is crc16("123456789") == 0x31C3.
func CRC16CCITT(data []byte) uint16 {
	var crc uint16
	for _, b := range data {
		crc ^= uint16(b) << 8
		for range 8 {
			if crc&0x8000 != 0 {
				crc = (crc << 1) ^ 0x1021
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}

// BuildFrame encodes one frame. The caller is responsible for newline policy;
// see Protocol implementations, where it differs by packet type.
func BuildFrame(ptype PacketType, payload []byte) []byte {
	length := 1 + len(payload) + 2
	body := make([]byte, 0, 3+len(payload))
	body = append(body, byte(length>>8), byte(length))
	body = append(body, byte(ptype))
	body = append(body, payload...)
	crc := CRC16CCITT(body)

	out := make([]byte, 0, len(body)+6)
	out = append(out, byte(FrameHeader>>8), byte(FrameHeader&0xFF))
	out = append(out, body...)
	out = append(out, byte(crc>>8), byte(crc))
	out = append(out, byte(FrameEnd>>8), byte(FrameEnd&0xFF))
	return out
}

// Frame is one decoded packet.
type Frame struct {
	Type    PacketType
	Payload []byte
}

type rxState int

const (
	rxWaitHeader rxState = iota
	rxReadLength
	rxReadData
	rxCheckFooter
)

// Decoder is an incremental frame parser. Feed it whatever a socket read
// returns; it emits zero or more complete frames.
//
// Known limitation, shared with the upstream Python decoder: the protocol has
// no byte-stuffing, so garbage containing the bytes 86 68 followed by a
// plausible length makes the decoder lock onto a false header and swallow the
// frames behind it until the declared length runs out. It recovers when the
// footer check fails, but data is lost. Drops is incremented so callers can see
// it happening instead of silently losing frames.
type Decoder struct {
	state    rxState
	body     []byte
	hdr      [2]byte
	ftr      [2]byte
	needed   int
	expected int

	// Drops counts frames rejected for a bad length, footer or CRC.
	Drops int
}

// Reset clears parser state without discarding statistics.
func (d *Decoder) Reset() {
	d.state = rxWaitHeader
	d.body = d.body[:0]
	d.hdr = [2]byte{}
	d.ftr = [2]byte{}
	d.needed = 2
	d.expected = 0
}

// Feed consumes bytes and returns any frames completed by them.
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
	case rxWaitHeader:
		d.hdr[0], d.hdr[1] = d.hdr[1], b
		if uint16(d.hdr[0])<<8|uint16(d.hdr[1]) == FrameHeader {
			d.state = rxReadLength
			d.needed = 2
			d.body = d.body[:0]
		}

	case rxReadLength:
		d.body = append(d.body, b)
		d.needed--
		if d.needed == 0 {
			d.expected = int(d.body[0])<<8 | int(d.body[1])
			if d.expected >= 0 && d.expected <= MaxFrameDataLength {
				d.state = rxReadData
				d.needed = d.expected
			} else {
				d.Drops++
				d.state = rxWaitHeader
			}
		}

	case rxReadData:
		d.body = append(d.body, b)
		d.needed--
		if d.needed == 0 {
			d.state = rxCheckFooter
			d.needed = 2
		}

	case rxCheckFooter:
		d.ftr[0], d.ftr[1] = d.ftr[1], b
		d.needed--
		if d.needed != 0 {
			break
		}
		d.state = rxWaitHeader
		if uint16(d.ftr[0])<<8|uint16(d.ftr[1]) != FrameEnd {
			d.Drops++
			return Frame{}, false
		}
		f, err := ParseBody(d.body)
		if err != nil {
			d.Drops++
			return Frame{}, false
		}
		return f, true
	}
	return Frame{}, false
}

// ErrBadCRC is returned when an assembled frame body fails its checksum.
var ErrBadCRC = errors.New("frame crc mismatch")

// ParseBody validates an assembled frame body (length|type|payload|crc) and
// extracts the packet. Exported so `z1ctl proto decode` can reuse it.
func ParseBody(body []byte) (Frame, error) {
	if len(body) < 5 {
		return Frame{}, errors.Errorf("short frame body: %d bytes", len(body))
	}
	want := uint16(body[len(body)-2])<<8 | uint16(body[len(body)-1])
	if got := CRC16CCITT(body[:len(body)-2]); got != want {
		return Frame{}, errors.Wrapf(ErrBadCRC, "want %04x got %04x", want, got)
	}
	payload := make([]byte, len(body)-5)
	copy(payload, body[3:len(body)-2])
	return Frame{Type: PacketType(body[2]), Payload: payload}, nil
}
