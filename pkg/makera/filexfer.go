// SPDX-License-Identifier: GPL-2.0-only

package makera

import (
	"context"
	"crypto/md5"
	"encoding/binary"
	"encoding/hex"
	"hash"
	"io"
	"strings"
	"time"

	"github.com/pkg/errors"
)

// Framed file transfer.
//
// The exchange reuses XMODEM vocabulary — sequence numbers, cancel, retry — but
// inverts control: after the host sends the initiation command, THE MACHINE
// decides what happens next and the host answers requests. Three consequences
// drive this implementation:
//
//   - Blocks may be requested out of order. On a non-consecutive request the
//     host must seek, not assume a forward-only stream.
//   - Cancel can mean success. If the digest the host advertises matches what
//     is already on the SD card, the machine cancels — that is a cache hit, and
//     treating FILE_CAN as an unconditional error turns the fastest path into a
//     reported failure.
//   - The transfer and the status poller share one socket, so the driver takes
//     ownership of the frame stream for its duration (see Mode).
//
// Derived from the specification in docs/protocol.md, which was in turn derived
// from carveracontroller/XMODEM.py (Carvera Community Controller, GPL-2.0,
// commit 777482a). This file is a re-implementation against that specification
// rather than a line-by-line port.

const (
	// transferFrameTimeout bounds the wait for any single frame.
	transferFrameTimeout = 5 * time.Second
	// transferStallTimeout matches upstream: if the machine goes quiet for this
	// long the transfer is cancelled rather than hung.
	transferStallTimeout = 9 * time.Second
	// transferMaxRetries bounds FILE_RETRY attempts before giving up.
	transferMaxRetries = 10
)

// TransferProgress reports transfer advancement.
type TransferProgress struct {
	Block       int
	TotalBlocks int
	Bytes       int64
}

// DownloadResult describes how a download finished.
type DownloadResult struct {
	// CacheHit is true when the machine cancelled because the digest we
	// advertised already matched — nothing was transferred and the local file
	// is already correct.
	CacheHit bool
	Bytes    int64
	Blocks   int
	// AdvertisedMD5 is what the machine claimed, lowercased.
	AdvertisedMD5 string
	// ActualMD5 is what we computed over the received bytes.
	ActualMD5 string
	// Verified is true only when a usable digest was advertised AND matched.
	Verified bool
	// VerifySkipped explains why verification did not happen, if it did not.
	VerifySkipped string
	// Compressed is true when the payload looks like QuickLZ, which this
	// implementation does not decompress.
	Compressed bool
}

// beginTransfer takes ownership of the frame stream.
func (c *Client) beginTransfer() {
	c.drain()
	for {
		select {
		case <-c.frames:
		default:
			c.mode.Store(int32(ModeTransfer))
			return
		}
	}
}

func (c *Client) endTransfer() { c.mode.Store(int32(ModeControl)) }

// nextFrame waits for one frame from the transfer stream.
func (c *Client) nextFrame(ctx context.Context, timeout time.Duration) (Frame, error) {
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return Frame{}, ctx.Err()
	case <-t.C:
		return Frame{}, errTransferTimeout
	case f := <-c.frames:
		return f, nil
	}
}

var errTransferTimeout = errors.New("timed out waiting for a transfer frame")

func (c *Client) sendXfer(ptype PacketType, payload []byte) error {
	return c.write(BuildFrame(ptype, payload))
}

func u32(b []byte) uint32 { return binary.BigEndian.Uint32(b) }

func u32b(v uint32) []byte {
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], v)
	return b[:]
}

// Download fetches a remote file.
//
// Read-only with respect to the machine: it reads from the SD card and cannot
// cause motion. localDigest, when non-empty, is the MD5 of a copy already held
// locally; if the machine's copy matches, it cancels the transfer and this
// returns CacheHit without writing anything.
func (c *Client) Download(
	ctx context.Context, remotePath string, w io.Writer, localDigest string,
	onProgress func(TransferProgress),
) (DownloadResult, error) {
	var res DownloadResult

	c.beginTransfer()
	defer c.endTransfer()

	cmd := EscapeLine("download " + EscapePath(remotePath))
	c.logger.Debug().Str("path", remotePath).Msg("starting download")
	if err := c.write(c.proto.EncodeFileCommand([]byte(cmd))); err != nil {
		return res, errors.Wrap(err, "send download command")
	}

	const (
		stWaitMD5 = iota
		stWaitView
		stReadData
	)
	state := stWaitMD5

	digest := md5.New()
	var (
		total      int
		expect     uint32 = 1
		firstBytes []byte
		retries    int
		lastFrame  = time.Now()
	)

	for {
		f, err := c.nextFrame(ctx, transferFrameTimeout)
		if err != nil {
			if !errors.Is(err, errTransferTimeout) {
				return res, err
			}
			if time.Since(lastFrame) > transferStallTimeout {
				_ = c.sendXfer(PTypeFileCan, nil)
				return res, errors.Errorf("download stalled: no frame for %s", transferStallTimeout)
			}
			retries++
			if retries > transferMaxRetries {
				_ = c.sendXfer(PTypeFileCan, nil)
				return res, errors.Errorf("download failed after %d retries", transferMaxRetries)
			}
			if err := c.sendXfer(PTypeFileRetry, nil); err != nil {
				return res, err
			}
			continue
		}
		lastFrame = time.Now()

		// Control chatter can still arrive; only file-transfer types matter.
		if !f.Type.IsFileTransfer() {
			continue
		}
		if f.Type == PTypeFileCan {
			// Only meaningful as success if we asked for a cache check.
			return res, errors.New("machine cancelled the download")
		}

		switch state {
		case stWaitMD5:
			if f.Type != PTypeFileMD5 {
				continue
			}
			res.AdvertisedMD5 = strings.ToLower(strings.TrimSpace(string(f.Payload)))
			if localDigest != "" && res.AdvertisedMD5 == strings.ToLower(localDigest) {
				// Cache hit. Cancelling here IS the success path.
				_ = c.sendXfer(PTypeFileCan, nil)
				res.CacheHit = true
				res.Verified = true
				return res, nil
			}
			if err := c.sendXfer(PTypeFileView, nil); err != nil {
				return res, err
			}
			state = stWaitView

		case stWaitView:
			if f.Type != PTypeFileView {
				continue
			}
			if len(f.Payload) < 4 {
				return res, errors.Errorf("short FILE_VIEW payload: %d bytes", len(f.Payload))
			}
			total = int(u32(f.Payload[:4]))
			res.Blocks = total
			expect = 1
			if err := c.sendXfer(PTypeFileData, u32b(expect)); err != nil {
				return res, err
			}
			state = stReadData

		case stReadData:
			if f.Type != PTypeFileData {
				continue
			}
			if len(f.Payload) < 4 {
				return res, errors.Errorf("short FILE_DATA payload: %d bytes", len(f.Payload))
			}
			seq := u32(f.Payload[:4])
			if seq != expect {
				// Not the block we asked for. Re-request rather than accept it
				// out of order, so the file is never assembled wrongly.
				retries++
				if retries > transferMaxRetries {
					_ = c.sendXfer(PTypeFileCan, nil)
					return res, errors.Errorf("download failed: expected block %d, kept receiving %d", expect, seq)
				}
				if err := c.sendXfer(PTypeFileData, u32b(expect)); err != nil {
					return res, err
				}
				continue
			}
			retries = 0

			data := f.Payload[4:]
			if len(firstBytes) < 2 {
				firstBytes = append(firstBytes, data[:min(2-len(firstBytes), len(data))]...)
			}
			if _, err := w.Write(data); err != nil {
				return res, errors.Wrap(err, "write downloaded data")
			}
			digest.Write(data)
			res.Bytes += int64(len(data))

			if onProgress != nil {
				onProgress(TransferProgress{Block: int(seq), TotalBlocks: total, Bytes: res.Bytes})
			}

			if int(seq) < total {
				expect++
				if err := c.sendXfer(PTypeFileData, u32b(expect)); err != nil {
					return res, err
				}
				continue
			}

			// Last block.
			if err := c.sendXfer(PTypeFileEnd, nil); err != nil {
				return res, err
			}
			finalizeDownload(&res, digest, firstBytes)
			c.logger.Debug().Int64("bytes", res.Bytes).Bool("verified", res.Verified).Msg("download complete")
			return res, nil
		}
	}
}

// finalizeDownload applies the integrity policy.
//
// Three cases, in order:
//
//   - the advertised digest is not 32 lowercase hex characters: skip the check.
//     This is not paranoia — some Z1 firmware answers with the literal
//     placeholder "default_md5_hash_value_32_bytes_", which is exactly 32
//     characters long, so a length check would accept it as a digest.
//   - the payload begins with 0x00 0x00: it is QuickLZ-compressed, and the
//     advertised digest describes the DECOMPRESSED bytes. We do not decompress,
//     so verification is deferred and reported as skipped rather than failed.
//   - otherwise: require an exact match.
func finalizeDownload(res *DownloadResult, digest hash.Hash, firstBytes []byte) {
	res.ActualMD5 = hex.EncodeToString(digest.Sum(nil))

	if !IsHexDigest(res.AdvertisedMD5) {
		res.VerifySkipped = "machine advertised no usable digest"
		return
	}
	if len(firstBytes) >= 2 && firstBytes[0] == 0x00 && firstBytes[1] == 0x00 {
		res.Compressed = true
		res.VerifySkipped = "payload is QuickLZ-compressed; digest describes the decompressed bytes"
		return
	}
	res.Verified = res.ActualMD5 == res.AdvertisedMD5
	if !res.Verified {
		res.VerifySkipped = "digest mismatch"
	}
}

// UploadResult describes how an upload finished.
type UploadResult struct {
	// CacheHit is true when the machine already had a file with this digest.
	CacheHit bool
	Bytes    int64
	Blocks   int
}

// Upload sends a local file to the machine.
//
// WRITES TO THE MACHINE. This has been implemented against the specification
// but NOT exercised against hardware; see docs/observations-z1-1.0.15.md. Treat
// the first real run as a test, on a scratch path, with an operator present.
//
// r must be an io.ReaderAt because the machine may request blocks out of order
// and expects the host to seek. size is the total length in bytes.
func (c *Client) Upload(
	ctx context.Context, remotePath string, r io.ReaderAt, size int64, digest string,
	onProgress func(TransferProgress),
) (UploadResult, error) {
	var res UploadResult

	if !IsHexDigest(strings.ToLower(digest)) {
		return res, errors.Errorf("upload requires a 32-character hex MD5 of the local file, got %q", digest)
	}

	blockSize := c.tr.BlockSize()
	blocks := int((size + int64(blockSize) - 1) / int64(blockSize))
	res.Blocks = blocks

	c.beginTransfer()
	defer c.endTransfer()

	cmd := EscapeLine("upload " + EscapePath(remotePath))
	c.logger.Warn().Str("path", remotePath).Int64("bytes", size).Msg("uploading — this writes to the machine")
	if err := c.write(c.proto.EncodeFileCommand([]byte(cmd))); err != nil {
		return res, errors.Wrap(err, "send upload command")
	}
	if err := c.sendXfer(PTypeFileMD5, []byte(strings.ToLower(digest))); err != nil {
		return res, errors.Wrap(err, "send digest")
	}

	var (
		lastPayload []byte
		lastType    = PTypeFileMD5
		lastFrame   = time.Now()
		buf         = make([]byte, blockSize)
	)

	for {
		f, err := c.nextFrame(ctx, transferFrameTimeout)
		if err != nil {
			if !errors.Is(err, errTransferTimeout) {
				return res, err
			}
			if time.Since(lastFrame) > transferStallTimeout {
				_ = c.sendXfer(PTypeFileCan, nil)
				return res, errors.Errorf("upload stalled: no frame for %s", transferStallTimeout)
			}
			continue
		}
		lastFrame = time.Now()

		if !f.Type.IsFileTransfer() {
			continue
		}

		switch f.Type {
		case PTypeFileCan:
			// The machine already has this file. Cancel here means success.
			res.CacheHit = true
			return res, nil

		case PTypeFileRetry:
			if err := c.sendXfer(lastType, lastPayload); err != nil {
				return res, err
			}

		case PTypeFileMD5:
			lastType, lastPayload = PTypeFileMD5, []byte(strings.ToLower(digest))
			if err := c.sendXfer(lastType, lastPayload); err != nil {
				return res, err
			}

		case PTypeFileView:
			payload := append(u32b(uint32(blocks)), byte(blockSize>>8), byte(blockSize))
			lastType, lastPayload = PTypeFileView, payload
			if err := c.sendXfer(lastType, lastPayload); err != nil {
				return res, err
			}

		case PTypeFileData:
			if len(f.Payload) < 4 {
				return res, errors.Errorf("short FILE_DATA request: %d bytes", len(f.Payload))
			}
			seq := u32(f.Payload[:4])
			if seq == 0 || int(seq) > blocks {
				return res, errors.Errorf("machine requested block %d, outside 1..%d", seq, blocks)
			}
			// Seek: the machine may request any block, in any order.
			off := int64(seq-1) * int64(blockSize)
			n, err := r.ReadAt(buf, off)
			if err != nil && err != io.EOF {
				return res, errors.Wrapf(err, "read local block %d", seq)
			}
			payload := append(u32b(seq), buf[:n]...)
			lastType, lastPayload = PTypeFileData, payload
			if err := c.sendXfer(lastType, lastPayload); err != nil {
				return res, err
			}
			res.Bytes = int64(seq-1)*int64(blockSize) + int64(n)
			if onProgress != nil {
				onProgress(TransferProgress{Block: int(seq), TotalBlocks: blocks, Bytes: res.Bytes})
			}

		case PTypeFileEnd:
			c.logger.Info().Str("path", remotePath).Msg("upload complete")
			return res, nil
		}
	}
}
