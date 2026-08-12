package makera

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/pkg/errors"
)

// Live camera on the Makera Z1.
//
// The camera is served by the Z1's ESP32 WiFi module, NOT the motion
// firmware: a WebSocket on port 82 at /ws_video that starts pushing frames
// once the client sends the text message "start_stream" — one whole JPEG per
// binary message, 640x480 by default at roughly 20fps. Because it is a
// separate service, using it never touches the machine's single control
// connection on port 2222, and nothing here can move anything.
//
// The only exposed setting is resolution, over HTTP on the module's port 80
// (Espressif framesize values; out-of-range values answer 200 and are then
// ignored, so only the measured-working set is offered). Exposure, gain and
// white balance are not reachable — the reference controller grades frames
// host-side for the same reason.
//
// Protocol source: the community controller's addons/camera/Z1Camera.py and
// websocket.py (MZ1-001 vendor). The WebSocket dialect is plain RFC 6455;
// upstream does not even verify the accept hash, so the ESP32 side is
// forgiving. This client is deliberately minimal rather than a dependency.

const (
	CameraPort        = 82
	cameraPath        = "/ws_video"
	cameraStartMsg    = "start_stream"
	CameraControlPort = 80
	cameraResPath     = "/api/camera/resolution"

	cameraHandshakeTimeout = 5 * time.Second
	cameraProbeTimeout     = 1500 * time.Millisecond
)

// WebSocket opcodes (RFC 6455 §5.2).
const (
	wsOpContinuation = 0x0
	wsOpText         = 0x1
	wsOpBinary       = 0x2
	wsOpClose        = 0x8
	wsOpPing         = 0x9
	wsOpPong         = 0xA
)

// CameraResolution is one of the framesize values the Z1's module accepts,
// each measured against real hardware by the reference controller. Frame
// rate falls as sizes climb (~20fps at 640x480, ~10 at 1600x1200).
type CameraResolution struct {
	Value  int
	Width  int
	Height int
}

var CameraResolutions = []CameraResolution{
	{10, 640, 480},
	{11, 800, 600},
	{12, 1024, 768},
	{13, 1280, 720},
	{14, 1280, 1024},
	{15, 1600, 1200},
}

// CameraHost strips the control port from a machine address, because the
// camera lives on its own ports.
func CameraHost(machineAddr string) string {
	if host, _, err := net.SplitHostPort(machineAddr); err == nil {
		return host
	}
	return machineAddr
}

// ErrCameraStreamClosed reports an orderly close from the camera side.
var ErrCameraStreamClosed = errors.New("camera ended the stream")

// CameraClient is one streaming session.
type CameraClient struct {
	conn net.Conn
	br   *bufio.Reader
}

// DialCamera connects, performs the WebSocket handshake and requests the
// stream. host is a bare host or ip; the port is the camera's own.
func DialCamera(ctx context.Context, host string) (*CameraClient, error) {
	return dialCameraAddr(ctx, net.JoinHostPort(host, fmt.Sprint(CameraPort)), host)
}

// dialCameraAddr is the port-explicit seam the tests use.
func dialCameraAddr(ctx context.Context, addr, hostHeader string) (*CameraClient, error) {
	d := net.Dialer{Timeout: cameraHandshakeTimeout}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, errors.Wrapf(err, "no camera at %s", addr)
	}
	c := &CameraClient{conn: conn, br: bufio.NewReaderSize(conn, 64*1024)}
	if err := c.handshake(hostHeader); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := c.writeFrame(wsOpText, []byte(cameraStartMsg)); err != nil {
		_ = conn.Close()
		return nil, errors.Wrap(err, "request stream")
	}
	return c, nil
}

func (c *CameraClient) handshake(host string) error {
	_ = c.conn.SetDeadline(time.Now().Add(cameraHandshakeTimeout))
	key := make([]byte, 16)
	if _, err := rand.Read(key); err != nil {
		return err
	}
	req := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
		"Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n",
		cameraPath, host, base64.StdEncoding.EncodeToString(key))
	if _, err := c.conn.Write([]byte(req)); err != nil {
		return errors.Wrap(err, "websocket handshake")
	}
	status, err := c.br.ReadString('\n')
	if err != nil {
		return errors.Wrap(err, "websocket handshake reply")
	}
	if !strings.Contains(status, " 101 ") {
		return errors.Errorf("camera refused the websocket upgrade: %s", strings.TrimSpace(status))
	}
	// Drain the remaining headers.
	for {
		line, err := c.br.ReadString('\n')
		if err != nil {
			return errors.Wrap(err, "websocket handshake headers")
		}
		if line == "\r\n" || line == "\n" {
			break
		}
	}
	_ = c.conn.SetDeadline(time.Time{})
	return nil
}

// NextFrame returns the next complete JPEG. It answers pings and skips text
// messages internally; ErrCameraStreamClosed reports an orderly close.
func (c *CameraClient) NextFrame(timeout time.Duration) ([]byte, error) {
	if timeout > 0 {
		_ = c.conn.SetReadDeadline(time.Now().Add(timeout))
		defer func() { _ = c.conn.SetReadDeadline(time.Time{}) }()
	}
	var pending []byte
	assembling := false
	for {
		fin, opcode, payload, err := c.readFrame()
		if err != nil {
			return nil, err
		}
		switch opcode {
		case wsOpClose:
			return nil, ErrCameraStreamClosed
		case wsOpPing:
			if err := c.writeFrame(wsOpPong, payload); err != nil {
				return nil, err
			}
			continue
		case wsOpPong, wsOpText:
			continue
		case wsOpBinary:
			pending = payload
			assembling = true
		case wsOpContinuation:
			if !assembling {
				continue // continuation of something we skipped
			}
			pending = append(pending, payload...)
		default:
			continue
		}
		if assembling && fin {
			return pending, nil
		}
	}
}

// Close closes the connection; the module treats that as end of session.
func (c *CameraClient) Close() error { return c.conn.Close() }

func (c *CameraClient) readFrame() (fin bool, opcode byte, payload []byte, err error) {
	var hdr [2]byte
	if _, err = io.ReadFull(c.br, hdr[:]); err != nil {
		return false, 0, nil, err
	}
	fin = hdr[0]&0x80 != 0
	opcode = hdr[0] & 0x0F
	masked := hdr[1]&0x80 != 0
	length := uint64(hdr[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	if length > 32<<20 {
		return false, 0, nil, errors.Errorf("camera frame of %d bytes exceeds the 32MB sanity bound", length)
	}
	var mask [4]byte
	if masked {
		if _, err = io.ReadFull(c.br, mask[:]); err != nil {
			return false, 0, nil, err
		}
	}
	payload = make([]byte, length)
	if _, err = io.ReadFull(c.br, payload); err != nil {
		return false, 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return fin, opcode, payload, nil
}

// writeFrame sends one client frame. Client frames MUST be masked (RFC 6455
// §5.3); the ESP32 enforces it.
func (c *CameraClient) writeFrame(opcode byte, payload []byte) error {
	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		return err
	}
	var buf bytes.Buffer
	buf.WriteByte(0x80 | opcode)
	switch {
	case len(payload) < 126:
		buf.WriteByte(0x80 | byte(len(payload)))
	case len(payload) <= 0xFFFF:
		buf.WriteByte(0x80 | 126)
		var ext [2]byte
		binary.BigEndian.PutUint16(ext[:], uint16(len(payload)))
		buf.Write(ext[:])
	default:
		buf.WriteByte(0x80 | 127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(len(payload)))
		buf.Write(ext[:])
	}
	buf.Write(mask[:])
	for i, b := range payload {
		buf.WriteByte(b ^ mask[i%4])
	}
	_, err := c.conn.Write(buf.Bytes())
	return err
}

// HasCamera reports whether a camera answers on host. It blocks up to the
// probe timeout.
func HasCamera(ctx context.Context, host string) bool {
	probeCtx, cancel := context.WithTimeout(ctx, cameraProbeTimeout)
	defer cancel()
	c, err := DialCamera(probeCtx, host)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

// SetCameraResolution switches the stream size via the module's HTTP API. A
// running stream keeps going and adopts the new size within a frame or two.
// Note the firmware answers 200 even to out-of-range values and then ignores
// them, which is why only the known-working set is accepted here.
func SetCameraResolution(ctx context.Context, host string, value int) error {
	known := false
	for _, r := range CameraResolutions {
		if r.Value == value {
			known = true
			break
		}
	}
	if !known {
		return errors.Errorf("resolution value %d is not in the known-working set (the firmware silently ignores others)", value)
	}
	body, _ := json.Marshal(map[string]int{"resolution": value})
	url := fmt.Sprintf("http://%s%s", net.JoinHostPort(host, fmt.Sprint(CameraControlPort)), cameraResPath)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return errors.Wrap(err, "camera resolution request")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return errors.Errorf("camera answered %s", resp.Status)
	}
	return nil
}
