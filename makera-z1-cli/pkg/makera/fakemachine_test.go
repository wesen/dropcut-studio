package makera

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeMachine is a Transport that plays the machine side of the framed file
// transfer. It exists because the transfer is machine-driven: the interesting
// behaviours — out-of-order block requests, retry, cancel-as-success — are
// things only the machine can initiate, so they cannot be exercised by driving
// a real one either.
type fakeMachine struct {
	mu  sync.Mutex
	dec Decoder
	out bytes.Buffer

	// file being served on download
	file      []byte
	digest    string
	blockSize int

	// upload capture
	received map[uint32][]byte
	uploaded bytes.Buffer

	// behaviour switches
	cancelOnMD5       bool // pretend the digest matched: cache hit
	scrambleBlock     int  // serve this block once with the wrong sequence
	scrambleDone      bool
	requestOutOfOrder bool // on upload, ask for blocks in a jumbled order
	askedOrder        []uint32
	retryOnce         bool
	retryDone         bool

	// download state
	dlState int
	dlSeq   uint32

	// upload state
	ulBlocks   uint32
	ulBlockLen int
	ulNext     uint32
	closed     bool

	// -------- control-path state (MZ1-003) --------

	// state is the machine state word in status reports.
	state string
	// haltCode is emitted as H: while state is Alarm.
	haltCode int
	// homed selects real coordinates versus the -1,-1,-1 unhomed sentinel.
	homed bool
	// endstops is the E: vector for diagnose replies. Eight fields with
	// E[5]=1 (cover closed) is the realistic default.
	endstops []string
	// estop is diagnose I[0].
	estop bool
	// playing, when non-nil, is emitted as the P: key.
	playing *Playback

	// cmds records every text command received, in order.
	cmds []string

	// jogging state, driven by $J -c / keepalives / 0x19.
	jogging         bool
	jogLastKeep     time.Time
	jogKeepTimes    []time.Time
	jogDeadman      time.Duration
	jogGotStop      bool // 0x19 received
	jogDeadmanFired bool
	suppressJogAck  bool // do not answer 0x19 with ^Y

	// replies maps a received command verb-line to a canned reply.
	replies map[string]string
}

const (
	fmIdle = iota
	fmSentMD5
	fmSentView
	fmSending
)

func newFakeMachine(file []byte, blockSize int) *fakeMachine {
	sum := md5.Sum(file)
	return &fakeMachine{
		file:       file,
		digest:     hex.EncodeToString(sum[:]),
		blockSize:  blockSize,
		received:   map[uint32][]byte{},
		state:      "Idle",
		homed:      true,
		endstops:   []string{"0", "0", "0", "0", "0", "1", "1", "0"},
		jogDeadman: 600 * time.Millisecond,
		replies:    map[string]string{},
	}
}

// jogActiveNow applies the firmware's dead-man: a jog whose last keepalive is
// older than the window has already been stopped by the machine.
func (m *fakeMachine) jogActiveNow() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.jogActiveLocked()
}

func (m *fakeMachine) jogActiveLocked() bool {
	if m.jogging && time.Since(m.jogLastKeep) > m.jogDeadman {
		m.jogging = false
		m.jogDeadmanFired = true
	}
	return m.jogging
}

func (m *fakeMachine) statusReport() string {
	pos := "-1.0000,-1.0000,-1.0000,0.0000,0.0000"
	if m.homed {
		pos = "10.0000,20.0000,30.0000,0.0000,0.0000"
	}
	rep := "<" + m.state + "|MPos:" + pos + "|WPos:" + pos +
		"|F:0.0,3000.0,100.0|S:0.0,0.0,100.0|T:-1,0.0"
	if m.state == "Alarm" && m.haltCode != 0 {
		rep += "|H:" + itoaTest(m.haltCode)
	}
	if m.playing != nil {
		rep += "|P:" + itoaTest(m.playing.Lines) + "," + itoaTest(m.playing.Percent) +
			"," + itoaTest(m.playing.Seconds) + ",1"
	}
	return rep + ">"
}

func (m *fakeMachine) diagnoseReport() string {
	i0 := "0"
	if m.estop {
		i0 = "1"
	}
	rep := "{S:0,0.0|W:12.0|E:" + join(m.endstops) + "|P:0,0|I:" + i0 + ",0,0,0|RSSI:-57}"
	return rep
}

func itoaTest(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		return "-" + string(b)
	}
	return string(b)
}

func join(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += ","
		}
		out += p
	}
	return out
}

// handleRealtime plays the firmware's realtime byte handling. Caller holds m.mu.
func (m *fakeMachine) handleRealtime(b byte) {
	switch b {
	case '?':
		m.jogActiveLocked() // lazily apply the dead-man
		m.reply(PTypeStatusRes, []byte(m.statusReport()+"\r\n"))
	case RealtimeJogKeep:
		if m.jogActiveLocked() {
			m.jogLastKeep = time.Now()
			m.jogKeepTimes = append(m.jogKeepTimes, m.jogLastKeep)
		}
	case RealtimeJogStop:
		m.jogGotStop = true
		m.jogging = false
		if !m.suppressJogAck {
			m.reply(PTypeNormalInfo, []byte("^Y\r\n"))
		}
	case RealtimeHold:
		m.state = "Hold"
	}
}

// handleCommand plays the firmware's line-command handling. Caller holds m.mu.
func (m *fakeMachine) handleCommand(cmd string) {
	m.cmds = append(m.cmds, cmd)
	switch {
	case cmd == "echo \x04":
		m.reply(PTypeNormalInfo, []byte("echo: \x04\r\n"))
	case strings.HasPrefix(cmd, "echo "):
		m.reply(PTypeNormalInfo, []byte("echo: "+cmd[len("echo "):]+"\r\n"))
	case cmd == "diagnose":
		m.reply(PTypeDiagRes, []byte(m.diagnoseReport()+"\r\n"))
	case strings.HasPrefix(cmd, "$J -c"):
		if m.state == "Idle" {
			m.jogging = true
			m.jogDeadmanFired = false
			m.jogLastKeep = time.Now()
		}
	default:
		if reply, ok := m.replies[cmd]; ok {
			m.reply(PTypeNormalInfo, []byte(reply+"\r\n"))
		}
	}
}

func (m *fakeMachine) BlockSize() int   { return m.blockSize }
func (m *fakeMachine) Describe() string { return "fake" }
func (m *fakeMachine) Close() error     { m.mu.Lock(); m.closed = true; m.mu.Unlock(); return nil }

func (m *fakeMachine) Read(p []byte) (int, error) {
	deadline := time.Now().Add(2 * time.Second)
	for {
		m.mu.Lock()
		if m.closed {
			m.mu.Unlock()
			return 0, io.EOF
		}
		if m.out.Len() > 0 {
			n, err := m.out.Read(p)
			m.mu.Unlock()
			return n, err
		}
		m.mu.Unlock()
		if time.Now().After(deadline) {
			return 0, timeoutError{}
		}
		time.Sleep(time.Millisecond)
	}
}

type timeoutError struct{}

func (timeoutError) Error() string   { return "fake read timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

func (m *fakeMachine) Write(p []byte) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, f := range m.dec.Feed(p) {
		m.handle(f)
	}
	return len(p), nil
}

func (m *fakeMachine) reply(ptype PacketType, payload []byte) {
	m.out.Write(BuildFrame(ptype, payload))
}

func (m *fakeMachine) blocks() uint32 {
	return uint32((len(m.file) + m.blockSize - 1) / m.blockSize)
}

// handle plays the machine side. Caller holds m.mu.
func (m *fakeMachine) handle(f Frame) {
	switch f.Type {
	case PTypeCtrlSingle:
		if len(f.Payload) == 1 {
			m.handleRealtime(f.Payload[0])
		}
		return
	case PTypeCtrlMulti:
		m.handleCommand(string(f.Payload))
		return
	}
	switch f.Type {
	case PTypeFileStart:
		cmd := string(f.Payload)
		switch {
		case bytes.HasPrefix([]byte(cmd), []byte("download")):
			m.dlState = fmSentMD5
			m.reply(PTypeFileMD5, []byte(m.digest))
		case bytes.HasPrefix([]byte(cmd), []byte("upload")):
			m.ulNext = 0 // wait for the host's digest first
		}

	case PTypeFileView:
		if m.dlState == fmSentMD5 && len(f.Payload) == 0 {
			// Host is asking for the layout.
			m.dlState = fmSentView
			m.reply(PTypeFileView, u32b(m.blocks()))
			return
		}
		// Upload: host answered with packetCount + blockSize.
		if len(f.Payload) >= 6 {
			m.ulBlocks = u32(f.Payload[:4])
			m.ulBlockLen = int(f.Payload[4])<<8 | int(f.Payload[5])
			m.ulNext = 1
			m.requestNextUploadBlock()
		}

	case PTypeFileMD5:
		// Upload: the host advertised a digest.
		if m.cancelOnMD5 {
			m.reply(PTypeFileCan, nil)
			return
		}
		m.reply(PTypeFileView, nil) // ask for the layout

	case PTypeFileData:
		if len(f.Payload) < 4 {
			return
		}
		seq := u32(f.Payload[:4])
		if len(f.Payload) == 4 {
			// Download: the host is requesting a block.
			m.serveBlock(seq)
			return
		}
		// Upload: the host is delivering a block.
		data := append([]byte(nil), f.Payload[4:]...)
		m.received[seq] = data
		if m.retryOnce && !m.retryDone {
			m.retryDone = true
			m.reply(PTypeFileRetry, nil)
			return
		}
		if int(seq) >= int(m.ulBlocks) {
			m.assembleUpload()
			m.reply(PTypeFileEnd, nil)
			return
		}
		m.ulNext++
		m.requestNextUploadBlock()

	case PTypeFileEnd:
		// Download finished; nothing to do.
	case PTypeFileCan:
		// Host cancelled.
	}
}

func (m *fakeMachine) requestNextUploadBlock() {
	seq := m.ulNext
	if m.requestOutOfOrder && seq == 1 && m.ulBlocks >= 3 {
		// Ask for the LAST block first, to prove the host seeks rather than
		// streaming forward.
		seq = m.ulBlocks
		m.ulNext = m.ulBlocks
	}
	m.askedOrder = append(m.askedOrder, seq)
	m.reply(PTypeFileData, u32b(seq))
}

func (m *fakeMachine) assembleUpload() {
	m.uploaded.Reset()
	for i := uint32(1); i <= m.ulBlocks; i++ {
		m.uploaded.Write(m.received[i])
	}
}

func (m *fakeMachine) serveBlock(seq uint32) {
	start := int(seq-1) * m.blockSize
	if start >= len(m.file) {
		return
	}
	end := min(start+m.blockSize, len(m.file))

	sent := seq
	if m.scrambleBlock > 0 && int(seq) == m.scrambleBlock && !m.scrambleDone {
		// Serve the right data under the WRONG sequence number once. The host
		// must reject it and re-request rather than write it in the wrong place.
		m.scrambleDone = true
		sent = seq + 7
	}
	m.reply(PTypeFileData, append(u32b(sent), m.file[start:end]...))
}

// ---------------------------------------------------------------------------

func newFakeClient(t *testing.T, m *fakeMachine) *Client {
	t.Helper()
	c := &Client{
		tr:     m,
		proto:  NewMakeraProtocol(),
		opts:   DefaultOptions(),
		msgs:   make(chan Message, 64),
		frames: make(chan Frame, 64),
		logger: zerolog.Nop(),
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.cancel = cancel
	c.wg.Add(1)
	go func() { defer c.wg.Done(); c.readLoop(ctx) }()
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestDownloadHappyPath(t *testing.T) {
	file := bytes.Repeat([]byte("G0 X1 Y1\n"), 500) // spans several blocks
	m := newFakeMachine(file, 128)
	c := newFakeClient(t, m)

	var out bytes.Buffer
	var lastProgress TransferProgress
	res, err := c.Download(context.Background(), "/sd/gcodes/part.nc", &out, "",
		func(p TransferProgress) { lastProgress = p })
	require.NoError(t, err)

	assert.Equal(t, file, out.Bytes(), "received bytes must match the machine's file")
	assert.EqualValues(t, len(file), res.Bytes)
	assert.True(t, res.Verified, "digest was usable and should have matched")
	assert.Equal(t, m.digest, res.ActualMD5)
	assert.Equal(t, lastProgress.TotalBlocks, res.Blocks)
}

// TestDownloadCacheHit covers the case that reads as a failure if you take
// FILE_CAN at face value: the machine cancels because we already have the file.
func TestDownloadCacheHit(t *testing.T) {
	file := []byte("G0 X1\n")
	m := newFakeMachine(file, 128)
	c := newFakeClient(t, m)

	var out bytes.Buffer
	res, err := c.Download(context.Background(), "/sd/gcodes/part.nc", &out, m.digest, nil)
	require.NoError(t, err)

	assert.True(t, res.CacheHit)
	assert.True(t, res.Verified)
	assert.Zero(t, out.Len(), "a cache hit must not write anything")
}

// TestDownloadRejectsOutOfOrderBlock proves the host never assembles a file
// wrongly: a block arriving under the wrong sequence number is re-requested,
// not written.
func TestDownloadRejectsOutOfOrderBlock(t *testing.T) {
	file := bytes.Repeat([]byte("ABCDEFGH"), 100)
	m := newFakeMachine(file, 64)
	m.scrambleBlock = 2
	c := newFakeClient(t, m)

	var out bytes.Buffer
	res, err := c.Download(context.Background(), "/sd/gcodes/part.nc", &out, "", nil)
	require.NoError(t, err)
	assert.Equal(t, file, out.Bytes())
	assert.True(t, res.Verified)
}

// TestDownloadSkipsVerificationOnPlaceholderDigest is the Z1 firmware quirk:
// the placeholder is exactly 32 characters, so only a hex check rejects it.
func TestDownloadSkipsVerificationOnPlaceholderDigest(t *testing.T) {
	file := []byte("G0 X1\n")
	m := newFakeMachine(file, 128)
	m.digest = "default_md5_hash_value_32_bytes_"
	require.Len(t, m.digest, 32)
	c := newFakeClient(t, m)

	var out bytes.Buffer
	res, err := c.Download(context.Background(), "/sd/gcodes/part.nc", &out, "", nil)
	require.NoError(t, err)

	assert.Equal(t, file, out.Bytes(), "the transfer itself must still succeed")
	assert.False(t, res.Verified)
	assert.Contains(t, res.VerifySkipped, "no usable digest")
}

func TestDownloadDetectsCompressedPayload(t *testing.T) {
	file := append([]byte{0x00, 0x00}, bytes.Repeat([]byte("z"), 50)...)
	m := newFakeMachine(file, 128)
	c := newFakeClient(t, m)

	var out bytes.Buffer
	res, err := c.Download(context.Background(), "/sd/gcodes/part.nc.lz", &out, "", nil)
	require.NoError(t, err)

	assert.True(t, res.Compressed)
	assert.False(t, res.Verified, "the digest describes decompressed bytes we cannot produce")
	assert.Contains(t, res.VerifySkipped, "QuickLZ")
}

func TestUploadHappyPath(t *testing.T) {
	file := bytes.Repeat([]byte("M3 S10000\n"), 300)
	m := newFakeMachine(nil, 128)
	m.blockSize = 128
	c := newFakeClient(t, m)

	sum := md5.Sum(file)
	res, err := c.Upload(context.Background(), "/sd/gcodes/new.nc",
		bytes.NewReader(file), int64(len(file)), hex.EncodeToString(sum[:]), nil)
	require.NoError(t, err)

	assert.False(t, res.CacheHit)
	assert.Equal(t, file, m.uploaded.Bytes(), "machine must reassemble exactly what we sent")
}

// TestUploadSeeksForOutOfOrderRequest is the behaviour a forward-only stream
// implementation gets wrong: the machine asks for the last block first.
func TestUploadSeeksForOutOfOrderRequest(t *testing.T) {
	file := bytes.Repeat([]byte("0123456789"), 100) // 1000 bytes, 8 blocks
	m := newFakeMachine(nil, 128)
	m.requestOutOfOrder = true
	c := newFakeClient(t, m)

	sum := md5.Sum(file)
	_, err := c.Upload(context.Background(), "/sd/gcodes/new.nc",
		bytes.NewReader(file), int64(len(file)), hex.EncodeToString(sum[:]), nil)
	require.NoError(t, err)

	require.NotEmpty(t, m.askedOrder)
	assert.NotEqual(t, uint32(1), m.askedOrder[0], "the fake must have asked out of order")

	// The block the machine asked for first must hold the RIGHT bytes, which
	// only happens if the host seeked.
	firstAsked := m.askedOrder[0]
	start := int(firstAsked-1) * m.blockSize
	end := min(start+m.blockSize, len(file))
	assert.Equal(t, file[start:end], m.received[firstAsked])
}

func TestUploadRetryResendsLastFrame(t *testing.T) {
	file := bytes.Repeat([]byte("X"), 300)
	m := newFakeMachine(nil, 128)
	m.retryOnce = true
	c := newFakeClient(t, m)

	sum := md5.Sum(file)
	_, err := c.Upload(context.Background(), "/sd/gcodes/new.nc",
		bytes.NewReader(file), int64(len(file)), hex.EncodeToString(sum[:]), nil)
	require.NoError(t, err)
	assert.Equal(t, file, m.uploaded.Bytes())
}

func TestUploadCacheHit(t *testing.T) {
	file := []byte("G0 X1\n")
	m := newFakeMachine(nil, 128)
	m.cancelOnMD5 = true
	c := newFakeClient(t, m)

	sum := md5.Sum(file)
	res, err := c.Upload(context.Background(), "/sd/gcodes/new.nc",
		bytes.NewReader(file), int64(len(file)), hex.EncodeToString(sum[:]), nil)
	require.NoError(t, err)
	assert.True(t, res.CacheHit, "FILE_CAN after the digest means the machine already has it")
}

func TestUploadRejectsBadDigest(t *testing.T) {
	m := newFakeMachine(nil, 128)
	c := newFakeClient(t, m)
	_, err := c.Upload(context.Background(), "/sd/x.nc", bytes.NewReader([]byte("a")), 1, "not-a-digest", nil)
	assert.Error(t, err)
}

// TestTransferModeRestoresControl guards the ownership handover: after a
// transfer the control path must work again.
func TestTransferModeRestoresControl(t *testing.T) {
	m := newFakeMachine([]byte("G0 X1\n"), 128)
	c := newFakeClient(t, m)

	var out bytes.Buffer
	_, err := c.Download(context.Background(), "/sd/x.nc", &out, "", nil)
	require.NoError(t, err)
	assert.Equal(t, ModeControl, Mode(c.mode.Load()))
}
