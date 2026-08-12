package makera

import (
	"bytes"
	"time"

	"github.com/rs/zerolog"
)

// Protocol detection.
//
// Two dialects share one TCP port with no version handshake, so a client must
// work out which it is talking to. The procedure is inverted from what a reader
// expects: the host sends RAW, deliberately unframed ASCII, and treats SILENCE
// as the signal for the newer framed protocol.
//
// An older machine echoes back, because raw text is its native language. A
// newer machine sees no 0x8668 header, concludes the bytes are not a frame, and
// discards them. Confirmed against a real Z1: three probes, three silences.
const (
	probeCommand  = "echo echo\n"
	probeAttempts = 3
	probeWait     = 100 * time.Millisecond
	probeReadSize = 64
)

// DetectProtocol probes a freshly opened transport and returns "makera" or
// "smoothie". Any failure yields "makera", which is the correct bias for new
// hardware.
func DetectProtocol(tr Transport, logger zerolog.Logger) string {
	drainTransport(tr)

	for i := range probeAttempts {
		if _, err := tr.Write([]byte(probeCommand)); err != nil {
			logger.Debug().Err(err).Int("attempt", i).Msg("protocol probe write failed")
			continue
		}
		time.Sleep(probeWait)

		buf := make([]byte, probeReadSize)
		n, err := tr.Read(buf)
		if err != nil || n == 0 {
			continue
		}
		if bytes.Contains(buf[:n], []byte("echo")) {
			logger.Debug().Msg("probe echoed: legacy smoothie protocol")
			return "smoothie"
		}
		logger.Debug().Bytes("reply", buf[:n]).Msg("probe drew a non-echo reply")
	}
	logger.Debug().Msg("probe drew silence: makera framed protocol")
	return DefaultProtocol
}

// drainTransport empties any pending bytes so a stale reply cannot be mistaken
// for a probe response.
func drainTransport(tr Transport) {
	buf := make([]byte, 1024)
	for range 32 {
		n, err := tr.Read(buf)
		if err != nil || n == 0 {
			return
		}
	}
}
