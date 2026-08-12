package makera

import (
	"bufio"
	"context"
	"encoding/binary"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeCameraServer speaks just enough of the ESP32's dialect: HTTP 101
// upgrade, unmasked server frames, and an expectation that client frames
// arrive masked.
type fakeCameraServer struct {
	ln       net.Listener
	t        *testing.T
	gotStart chan string
	gotPong  chan []byte
}

func startFakeCamera(t *testing.T, script func(w io.Writer)) *fakeCameraServer {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	s := &fakeCameraServer{ln: ln, t: t, gotStart: make(chan string, 1), gotPong: make(chan []byte, 1)}
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		br := bufio.NewReader(conn)
		// Handshake: read until the blank line, answer 101.
		for {
			line, err := br.ReadString('\n')
			if err != nil {
				return
			}
			if line == "\r\n" {
				break
			}
		}
		_, _ = conn.Write([]byte("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"))

		// First client frame must be the masked start_stream text.
		op, payload := readClientFrame(s.t, br)
		if op == wsOpText {
			s.gotStart <- string(payload)
		}
		script(conn)
		// Absorb any pong the client sends back.
		if op, payload = readClientFrame(s.t, br); op == wsOpPong {
			s.gotPong <- payload
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return s
}

// readClientFrame parses one masked client frame (small payloads only).
func readClientFrame(t *testing.T, br *bufio.Reader) (byte, []byte) {
	var hdr [2]byte
	if _, err := io.ReadFull(br, hdr[:]); err != nil {
		return 0, nil
	}
	op := hdr[0] & 0x0F
	if hdr[1]&0x80 == 0 {
		t.Error("client frames must be masked (RFC 6455 §5.3; the ESP32 enforces it)")
	}
	length := int(hdr[1] & 0x7F)
	var mask [4]byte
	if _, err := io.ReadFull(br, mask[:]); err != nil {
		return 0, nil
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(br, payload); err != nil {
		return 0, nil
	}
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
	return op, payload
}

// writeServerFrame emits one unmasked server frame.
func writeServerFrame(w io.Writer, fin bool, opcode byte, payload []byte) {
	b0 := opcode
	if fin {
		b0 |= 0x80
	}
	hdr := []byte{b0}
	switch {
	case len(payload) < 126:
		hdr = append(hdr, byte(len(payload)))
	default:
		hdr = append(hdr, 126)
		var ext [2]byte
		binary.BigEndian.PutUint16(ext[:], uint16(len(payload)))
		hdr = append(hdr, ext[:]...)
	}
	_, _ = w.Write(append(hdr, payload...))
}

func TestCameraClientStreamsJPEGs(t *testing.T) {
	big := strings.Repeat("J", 300) // exercises the 126 length form
	s := startFakeCamera(t, func(w io.Writer) {
		writeServerFrame(w, true, wsOpPing, []byte("beat"))         // must be answered, not surfaced
		writeServerFrame(w, true, wsOpText, []byte("ignore me"))    // text is skipped
		writeServerFrame(w, false, wsOpBinary, []byte("head"))      // fragmented JPEG...
		writeServerFrame(w, true, wsOpContinuation, []byte("tail")) // ...completed
		writeServerFrame(w, true, wsOpBinary, []byte(big))          // whole JPEG
		writeServerFrame(w, true, wsOpClose, nil)                   // orderly end
	})

	c, err := dialCameraAddr(context.Background(), s.ln.Addr().String(), "test-camera")
	require.NoError(t, err)
	defer func() { _ = c.Close() }()

	select {
	case msg := <-s.gotStart:
		assert.Equal(t, cameraStartMsg, msg, "the stream starts only when asked")
	case <-time.After(2 * time.Second):
		t.Fatal("server never received start_stream")
	}

	frame, err := c.NextFrame(2 * time.Second)
	require.NoError(t, err)
	assert.Equal(t, "headtail", string(frame), "fragmented messages must reassemble")

	frame, err = c.NextFrame(2 * time.Second)
	require.NoError(t, err)
	assert.Equal(t, big, string(frame))

	_, err = c.NextFrame(2 * time.Second)
	assert.ErrorIs(t, err, ErrCameraStreamClosed)

	select {
	case pong := <-s.gotPong:
		assert.Equal(t, "beat", string(pong), "pings must be answered with their payload")
	case <-time.After(2 * time.Second):
		t.Fatal("client never answered the ping")
	}
}
