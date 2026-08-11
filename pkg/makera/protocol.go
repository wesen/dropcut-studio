// SPDX-License-Identifier: GPL-2.0-only

package makera

import (
	"bytes"
	"strings"
)

// MessageKind classifies a decoded machine message.
type MessageKind int

const (
	// MessageLine is ordinary machine output: a status report, a diagnose
	// report, or an informational line. The packet type tells you why the
	// line arrived, not how to parse it — the structure is in the text.
	MessageLine MessageKind = iota
	// MessageLoadChunk is part of a bulk listing (ls, cat, config dump).
	MessageLoadChunk
	// MessageLoadEOF terminates a bulk listing.
	MessageLoadEOF
	// MessageLoadError signals a failed bulk listing.
	MessageLoadError
)

// Message is one decoded, newline-trimmed unit of machine output.
type Message struct {
	Kind MessageKind
	Text string
	Type PacketType // original frame type, retained for diagnostics
}

// Protocol encodes commands and decodes machine output for one wire dialect.
//
// Two implementations exist: MakeraProtocol (framed binary, used by the Z1 and
// all recent firmware) and SmoothieProtocol (newline-delimited text, used by
// older Carvera firmware).
type Protocol interface {
	Name() string
	// UsesFramedTransfer reports whether file transfers use the framed
	// exchange rather than classic XMODEM.
	UsesFramedTransfer() bool
	// EncodeCommand encodes a text command (G-code, $-command, shell).
	EncodeCommand(data []byte) []byte
	// EncodeRealtime encodes one or more single-byte realtime controls.
	// All bytes MUST reach the socket in a single write: sending '?' and a
	// jog keepalive as separate writes races other traffic and leaves
	// orphaned bytes in the firmware's command buffer.
	EncodeRealtime(chars ...byte) []byte
	// EncodeFileCommand encodes an upload/download initiation command.
	EncodeFileCommand(data []byte) []byte
	// Feed consumes inbound bytes and returns any completed messages.
	Feed(data []byte) []Message
	// Reset clears receive state for a new connection or after an error.
	Reset()
	// Drops reports frames discarded for a bad length, footer or CRC.
	Drops() int
}

// ---------------------------------------------------------------------------
// Makera framed protocol
// ---------------------------------------------------------------------------

// MakeraProtocol implements the framed binary dialect used by the Z1.
type MakeraProtocol struct {
	dec Decoder
}

var _ Protocol = &MakeraProtocol{}

func NewMakeraProtocol() *MakeraProtocol { return &MakeraProtocol{} }

func (p *MakeraProtocol) Name() string             { return "makera" }
func (p *MakeraProtocol) UsesFramedTransfer() bool { return true }
func (p *MakeraProtocol) Reset()                   { p.dec.Reset() }
func (p *MakeraProtocol) Drops() int               { return p.dec.Drops }

// EncodeCommand strips trailing newlines. This is not cosmetic: the frame
// already delimits the message, and a trailing newline breaks firmware numeric
// parsers that use strtol, which requires *end == '\0'. `baud 115200\n` inside
// a frame fails to parse for exactly this reason.
func (p *MakeraProtocol) EncodeCommand(data []byte) []byte {
	return BuildFrame(PTypeCtrlMulti, bytes.TrimRight(data, "\r\n"))
}

func (p *MakeraProtocol) EncodeRealtime(chars ...byte) []byte {
	var out []byte
	for _, c := range chars {
		out = append(out, BuildFrame(PTypeCtrlSingle, []byte{c})...)
	}
	return out
}

// EncodeFileCommand appends a newline if absent — the opposite of
// EncodeCommand, because the firmware reads this payload as a line.
func (p *MakeraProtocol) EncodeFileCommand(data []byte) []byte {
	if !bytes.HasSuffix(data, []byte("\n")) {
		data = append(append([]byte{}, data...), '\n')
	}
	return BuildFrame(PTypeFileStart, data)
}

func (p *MakeraProtocol) Feed(data []byte) []Message {
	var out []Message
	for _, f := range p.dec.Feed(data) {
		// File-transfer frames belong to the transfer driver. If any reach
		// the control parser, ignore them rather than treat them as text.
		if f.Type.IsFileTransfer() {
			continue
		}
		switch f.Type {
		case PTypeLoadFinish:
			out = append(out, Message{Kind: MessageLoadEOF, Type: f.Type})
			continue
		case PTypeLoadError:
			out = append(out, Message{Kind: MessageLoadError, Type: f.Type})
			continue
		}
		if len(f.Payload) == 0 {
			continue
		}
		kind := MessageLine
		if f.Type == PTypeLoadInfo {
			kind = MessageLoadChunk
		}
		out = append(out, Message{
			Kind: kind,
			Text: strings.TrimRight(string(f.Payload), "\r\n"),
			Type: f.Type,
		})
	}
	return out
}

// ---------------------------------------------------------------------------
// Legacy Smoothieware text protocol
// ---------------------------------------------------------------------------

const (
	byteEOT = 0x04
	byteCAN = 0x16
)

// SmoothieProtocol implements the legacy newline-delimited text dialect used
// by older Carvera firmware. Included so protocol autodetection is meaningful;
// legacy file transfer (classic XMODEM) is deliberately not implemented.
type SmoothieProtocol struct {
	line []byte
}

var _ Protocol = &SmoothieProtocol{}

func NewSmoothieProtocol() *SmoothieProtocol { return &SmoothieProtocol{} }

func (p *SmoothieProtocol) Name() string             { return "smoothie" }
func (p *SmoothieProtocol) UsesFramedTransfer() bool { return false }
func (p *SmoothieProtocol) Reset()                   { p.line = p.line[:0] }
func (p *SmoothieProtocol) Drops() int               { return 0 }

func (p *SmoothieProtocol) EncodeCommand(data []byte) []byte {
	if bytes.HasSuffix(data, []byte("\n")) {
		return data
	}
	return append(append([]byte{}, data...), '\n')
}

func (p *SmoothieProtocol) EncodeRealtime(chars ...byte) []byte {
	return append([]byte{}, chars...)
}

func (p *SmoothieProtocol) EncodeFileCommand(data []byte) []byte {
	return p.EncodeCommand(data)
}

func (p *SmoothieProtocol) Feed(data []byte) []Message {
	var out []Message
	for _, b := range data {
		switch b {
		case byteEOT, byteCAN:
			if len(p.line) > 0 {
				out = append(out, Message{Kind: MessageLoadChunk, Text: string(p.line)})
				p.line = p.line[:0]
			}
			kind := MessageLoadEOF
			if b == byteCAN {
				kind = MessageLoadError
			}
			out = append(out, Message{Kind: kind})
		case '\n':
			out = append(out, Message{
				Kind: MessageLine,
				Text: strings.TrimRight(string(p.line), "\r"),
			})
			p.line = p.line[:0]
		default:
			p.line = append(p.line, b)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// DefaultProtocol is the correct bias for new hardware: if detection fails for
// any reason, assume the newer framed dialect.
const DefaultProtocol = "makera"

// NewProtocol builds a protocol by registered name.
func NewProtocol(name string) Protocol {
	switch name {
	case "smoothie":
		return NewSmoothieProtocol()
	default:
		return NewMakeraProtocol()
	}
}

// ProtocolFromAnnouncement parses a firmware protocol announcement (the M485
// family) and returns a protocol name, or "" if the text is unrelated.
func ProtocolFromAnnouncement(text string) string {
	lower := strings.ToLower(text)
	switch {
	case strings.Contains(lower, "makera communication protocol"),
		strings.Contains(lower, "current communication protocol: makera"):
		return "makera"
	case strings.Contains(lower, "smoothie communication protocol"),
		strings.Contains(lower, "current communication protocol: smoothie"):
		return "smoothie"
	}
	return ""
}
