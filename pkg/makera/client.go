// SPDX-License-Identifier: GPL-2.0-only

package makera

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/errors"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

// Mode determines who owns the inbound frame stream.
//
// The status poller and a file transfer read the same TCP connection, and the
// machine accepts only one connection. Published clients solve this by pausing
// a reader thread and busy-waiting up to a second for it to park. Giving the
// connection exactly one reader and transferring ownership with a flag removes
// the race entirely: there is never a second consumer to lose to.
type Mode int32

const (
	ModeControl Mode = iota
	ModeTransfer
)

// sentinel terminates a command's output. The firmware processes its line
// queue in order, so when `echo \x04` comes back, everything before it belongs
// to the command that preceded it. Confirmed on hardware, where the reply
// arrives as a NORMAL_INFO frame carrying "echo: \x04".
const (
	sentinelCmd  = "echo \x04"
	sentinelByte = "\x04"
)

// Realtime control bytes.
const (
	RealtimeStatus    byte = '?'
	RealtimeHold      byte = '!'
	RealtimeResume    byte = '~'
	RealtimeSoftReset byte = 0x18
	RealtimeJogKeep   byte = 0x1A // Makera protocol; Smoothie uses '1'
)

// MachineInfo is the identity of a connected machine.
type MachineInfo struct {
	Model       string
	ModelID     int
	FuncSetting int
	State       string // trailing field on real firmware
	Version     string
	Community   bool // version contains 'c'
	FileTypes   string
	Protocol    string
	ClockEpoch  int64
}

// AcceptsCompressedUploads reports whether the machine advertises `.lz`
// support. Real Z1 firmware answers `nc`, meaning raw uploads only.
func (i MachineInfo) AcceptsCompressedUploads() bool {
	return strings.Contains(strings.ToLower(i.FileTypes), "lz")
}

// Options configure a Client.
type Options struct {
	Address        string
	ProtocolName   string // "auto", "makera", "smoothie"
	ConnectTimeout time.Duration
	ReadTimeout    time.Duration
	CommandTimeout time.Duration
	// OnFrame, when set, is called for every frame in each direction. Used by
	// `z1ctl proto sniff`.
	OnFrame func(outbound bool, f Frame)
}

// DefaultOptions returns sensible timeouts.
func DefaultOptions() Options {
	return Options{
		ProtocolName:   "auto",
		ConnectTimeout: 2 * time.Second,
		ReadTimeout:    300 * time.Millisecond,
		CommandTimeout: 15 * time.Second,
	}
}

// Client is a connected machine session.
type Client struct {
	tr    Transport
	proto Protocol
	opts  Options

	mode atomic.Int32
	msgs chan Message

	mu     sync.RWMutex
	info   MachineInfo
	logger zerolog.Logger

	cancel context.CancelFunc
	wg     sync.WaitGroup
	closed atomic.Bool
	readEr atomic.Pointer[error]
}

// Dial connects, detects the protocol and starts the reader.
func Dial(ctx context.Context, opts Options) (*Client, error) {
	tr, err := DialTCP(ctx, opts.Address, opts.ConnectTimeout, opts.ReadTimeout)
	if err != nil {
		return nil, err
	}
	c := &Client{
		tr:     tr,
		opts:   opts,
		msgs:   make(chan Message, 256),
		logger: log.With().Str("component", "makera.Client").Str("addr", tr.Describe()).Logger(),
	}

	name := opts.ProtocolName
	if name == "" || name == "auto" {
		name = DetectProtocol(tr, c.logger)
	}
	c.proto = NewProtocol(name)
	c.mu.Lock()
	c.info.Protocol = name
	c.mu.Unlock()
	c.logger.Info().Str("protocol", name).Msg("connected")

	runCtx, cancel := context.WithCancel(context.Background())
	c.cancel = cancel
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		c.readLoop(runCtx)
	}()
	return c, nil
}

// Close stops the reader and closes the transport.
func (c *Client) Close() error {
	if !c.closed.CompareAndSwap(false, true) {
		return nil
	}
	c.cancel()
	err := c.tr.Close()
	c.wg.Wait()
	return err
}

// Info returns the cached machine identity.
func (c *Client) Info() MachineInfo {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.info
}

// Protocol returns the negotiated protocol name.
func (c *Client) Protocol() string { return c.proto.Name() }

// Drops returns the number of frames discarded for a bad length, footer or CRC.
// A non-zero value means the receiver desynchronised — see the false-header
// limitation documented on Decoder.
func (c *Client) Drops() int { return c.proto.Drops() }

// readLoop is the only goroutine that touches the transport's Read.
func (c *Client) readLoop(ctx context.Context) {
	buf := make([]byte, 4096)
	for {
		if ctx.Err() != nil {
			return
		}
		n, err := c.tr.Read(buf)
		if err != nil {
			if IsTimeout(err) {
				continue
			}
			if ctx.Err() == nil && !c.closed.Load() {
				c.readEr.Store(&err)
				c.logger.Debug().Err(err).Msg("read loop ended")
			}
			return
		}
		for _, m := range c.proto.Feed(buf[:n]) {
			// A firmware announcement can switch the dialect mid-session.
			if announced := ProtocolFromAnnouncement(m.Text); announced != "" && announced != c.proto.Name() {
				c.logger.Info().Str("protocol", announced).Msg("switching protocol on announcement")
				c.proto = NewProtocol(announced)
			}
			select {
			case c.msgs <- m:
			case <-ctx.Done():
				return
			default:
				// Never block the reader on a slow consumer; dropping the
				// oldest keeps status current, which is what matters.
				select {
				case <-c.msgs:
				default:
				}
				select {
				case c.msgs <- m:
				default:
				}
			}
		}
	}
}

func (c *Client) write(b []byte) error {
	if err := c.readErr(); err != nil {
		return err
	}
	if _, err := c.tr.Write(b); err != nil {
		return errors.Wrap(err, "write to machine")
	}
	return nil
}

func (c *Client) readErr() error {
	if p := c.readEr.Load(); p != nil {
		return errors.Wrap(*p, "connection lost")
	}
	return nil
}

// drain empties any buffered messages, so a command's reply cannot be confused
// with unsolicited output that arrived before it.
func (c *Client) drain() {
	for {
		select {
		case <-c.msgs:
		default:
			return
		}
	}
}

// Command sends a text command and collects its output up to the sentinel.
//
// The command and the sentinel are written separately but back to back; the
// firmware's in-order line processing is what makes this reliable.
func (c *Client) Command(ctx context.Context, cmd string) ([]Message, error) {
	if err := AssertNotMotion(cmd); err != nil {
		return nil, err
	}
	return c.commandUnchecked(ctx, cmd)
}

// commandUnchecked bypasses the motion guard. Callers must have obtained
// explicit authorisation; see MotionCommand.
func (c *Client) commandUnchecked(ctx context.Context, cmd string) ([]Message, error) {
	c.drain()
	c.logger.Debug().Str("cmd", cmd).Msg("send")
	if err := c.write(c.proto.EncodeCommand([]byte(cmd))); err != nil {
		return nil, err
	}
	if err := c.write(c.proto.EncodeCommand([]byte(sentinelCmd))); err != nil {
		return nil, err
	}

	timeout := c.opts.CommandTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()

	var out []Message
	for {
		select {
		case <-ctx.Done():
			return out, ctx.Err()
		case <-deadline.C:
			return out, errors.Errorf("timeout after %s waiting for %q to complete", timeout, cmd)
		case m := <-c.msgs:
			if strings.Contains(m.Text, sentinelByte) {
				return out, nil
			}
			if m.Kind == MessageLoadError {
				return out, errors.Errorf("machine reported an error running %q", cmd)
			}
			if m.Kind == MessageLoadEOF {
				continue
			}
			if m.Text != "" {
				out = append(out, m)
			}
		}
	}
}

// CommandText is Command flattened to lines of text.
func (c *Client) CommandText(ctx context.Context, cmd string) ([]string, error) {
	msgs, err := c.Command(ctx, cmd)
	if err != nil {
		return nil, err
	}
	return Lines(msgs), nil
}

// Lines flattens messages into individual text lines. Bulk listings pack many
// records into one frame and the split between frames is not guaranteed to be
// record-aligned, so callers must never treat one message as one record.
func Lines(msgs []Message) []string {
	var out []string
	for _, m := range msgs {
		for _, line := range strings.Split(m.Text, "\n") {
			line = strings.TrimRight(line, "\r")
			if strings.TrimSpace(line) != "" {
				out = append(out, line)
			}
		}
	}
	return out
}

// Realtime sends one or more realtime control bytes in a single write.
func (c *Client) Realtime(chars ...byte) error {
	for _, ch := range chars {
		if err := AssertRealtimeAllowed(ch); err != nil {
			return err
		}
	}
	return c.write(c.proto.EncodeRealtime(chars...))
}

// QueryStatus sends the realtime '?' and parses the reply.
func (c *Client) QueryStatus(ctx context.Context) (Status, error) {
	c.drain()
	if err := c.write(c.proto.EncodeRealtime(RealtimeStatus)); err != nil {
		return Status{}, err
	}
	line, err := c.awaitBracketed(ctx, '<', 2*time.Second)
	if err != nil {
		return Status{}, errors.Wrap(err, "query status")
	}
	rep, err := ParseReport(line, '<', '>')
	if err != nil {
		return Status{}, err
	}
	return InterpretStatus(rep), nil
}

// QueryDiagnose sends `diagnose` and parses the reply.
func (c *Client) QueryDiagnose(ctx context.Context) (Diagnose, error) {
	msgs, err := c.commandUnchecked(ctx, "diagnose")
	if err != nil {
		return Diagnose{}, errors.Wrap(err, "query diagnose")
	}
	for _, line := range Lines(msgs) {
		if strings.Contains(line, "{") {
			rep, err := ParseReport(line, '{', '}')
			if err != nil {
				return Diagnose{}, err
			}
			return InterpretDiagnose(rep), nil
		}
	}
	return Diagnose{}, errors.New("no diagnose report in reply")
}

func (c *Client) awaitBracketed(ctx context.Context, open byte, timeout time.Duration) (string, error) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-deadline.C:
			return "", errors.Errorf("timeout after %s", timeout)
		case m := <-c.msgs:
			if strings.IndexByte(m.Text, open) >= 0 {
				return m.Text, nil
			}
		}
	}
}

// Identify queries version, model and file types and caches the result.
//
// Note that `help` on real firmware does not list model, ftype or time even
// though all three work: the firmware documents only its Smoothieware base
// command set, so treat `help` as a lower bound on the command surface.
func (c *Client) Identify(ctx context.Context) (MachineInfo, error) {
	info := c.Info()

	if lines, err := c.CommandText(ctx, "version"); err == nil {
		for _, l := range lines {
			if v, ok := ParseVersionLine(l); ok {
				info.Version = v
				info.Community = strings.Contains(strings.ToLower(v), "c")
			}
		}
	}
	if lines, err := c.CommandText(ctx, "model"); err == nil {
		for _, l := range lines {
			if m, ok := ParseModelLine(l); ok {
				info.Model, info.ModelID = m.Model, m.ModelID
				info.FuncSetting, info.State = m.FuncSetting, m.State
			}
		}
	}
	if lines, err := c.CommandText(ctx, "ftype"); err == nil {
		for _, l := range lines {
			if v, ok := ParseKeyValueLine(l, "ftype"); ok {
				info.FileTypes = v
			}
		}
	}
	if lines, err := c.CommandText(ctx, "time"); err == nil {
		for _, l := range lines {
			if v, ok := ParseKeyValueLine(l, "time"); ok {
				info.ClockEpoch = parseInt64(v)
			}
		}
	}

	info.Protocol = c.proto.Name()
	c.mu.Lock()
	c.info = info
	c.mu.Unlock()
	return info, nil
}
