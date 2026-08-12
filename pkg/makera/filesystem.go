// SPDX-License-Identifier: GPL-2.0-only

package makera

import (
	"context"
	"strings"

	"github.com/pkg/errors"
)

// Authorised filesystem mutations.
//
// These are a different risk class from motion. None of them can move an axis,
// start a spindle or injure anyone; what they can do is destroy data. They are
// therefore not gated behind a confirmation flag the way motion is — typing
// `rm` IS the intent — but they are still kept off Client.Command's guarded
// path, so they cannot be reached by accident from a generic command string.
//
// Every one of them names itself: a reader of any call site can see that the
// machine's filesystem is being changed.

// errorIndicators are substrings the firmware uses to report a failed
// operation. It answers nothing at all on success, so a reply is bad news.
var errorIndicators = []string{
	"error", "fail", "not found", "no such", "invalid",
	"could not", "cannot", "denied", "exists",
}

// checkFileOpReply turns the firmware's free-text reply into an error.
//
// The firmware is silent on success, so any content is suspicious. Lines are
// still returned for the caller to surface, because some replies are merely
// informational and being able to see them matters more than guessing.
func checkFileOpReply(op string, lines []string) error {
	for _, l := range lines {
		lower := strings.ToLower(strings.TrimSpace(l))
		if lower == "" {
			continue
		}
		for _, ind := range errorIndicators {
			if strings.Contains(lower, ind) {
				return errors.Errorf("%s failed: %s", op, strings.TrimSpace(l))
			}
		}
	}
	return nil
}

// RemoveFile deletes a file on the machine.
//
// DESTRUCTIVE. There is no undo and no trash.
func (c *Client) RemoveFile(ctx context.Context, path string) ([]string, error) {
	c.logger.Warn().Str("path", path).Msg("removing file from the machine")
	cmd := EscapeLine("rm " + EscapePath(path) + " -e")
	lines, err := c.commandTextUnchecked(ctx, cmd)
	if err != nil {
		return lines, errors.Wrapf(err, "remove %s", path)
	}
	return lines, checkFileOpReply("remove", lines)
}

// MoveFile renames or moves a file on the machine.
//
// DESTRUCTIVE if the destination exists: the firmware is not consulted about
// overwriting, so callers that care should check first.
func (c *Client) MoveFile(ctx context.Context, from, to string) ([]string, error) {
	c.logger.Warn().Str("from", from).Str("to", to).Msg("moving file on the machine")
	cmd := EscapeLine("mv " + EscapePath(from) + " " + EscapePath(to) + " -e")
	lines, err := c.commandTextUnchecked(ctx, cmd)
	if err != nil {
		return lines, errors.Wrapf(err, "move %s to %s", from, to)
	}
	return lines, checkFileOpReply("move", lines)
}

// MakeDir creates a directory on the machine.
//
// Note: `mkdir` is NOT listed by the firmware's own `help` on Z1 firmware
// 1.0.15.0.1.11, but `help` is known to be a lower bound on the command surface
// — `model`, `ftype`, `time` and `echo` are all unlisted and all work.
func (c *Client) MakeDir(ctx context.Context, path string) ([]string, error) {
	c.logger.Info().Str("path", path).Msg("creating directory on the machine")
	cmd := EscapeLine("mkdir " + EscapePath(path) + " -e")
	lines, err := c.commandTextUnchecked(ctx, cmd)
	if err != nil {
		return lines, errors.Wrapf(err, "mkdir %s", path)
	}
	return lines, checkFileOpReply("mkdir", lines)
}

// ListDir lists a directory. Read-only, but lives here so filesystem callers
// have one place to look.
func (c *Client) ListDir(ctx context.Context, path string) ([]DirEntry, error) {
	cmd := EscapeLine("ls -e -s " + EscapePath(path))
	lines, err := c.CommandText(ctx, cmd)
	if err != nil {
		return nil, errors.Wrapf(err, "list %s", path)
	}
	return ParseListing(lines), nil
}

// RemoteMD5 asks the machine for a file's digest.
//
// Returns ok=false when the machine advertised nothing usable — which includes
// the 32-character non-hex placeholder some Z1 firmware returns, so a length
// check alone would be wrong.
func (c *Client) RemoteMD5(ctx context.Context, path string) (digest string, ok bool, err error) {
	cmd := EscapeLine("md5sum " + EscapePath(path) + " -e")
	lines, err := c.CommandText(ctx, cmd)
	if err != nil {
		return "", false, errors.Wrapf(err, "md5sum %s", path)
	}
	for _, l := range lines {
		if d, _, good := ParseMD5(l); good {
			return d, true, nil
		}
	}
	return "", false, nil
}

// commandTextUnchecked runs a command past the motion guard and flattens the
// reply. Only the authorised methods in this file and safety.go may use it.
func (c *Client) commandTextUnchecked(ctx context.Context, cmd string) ([]string, error) {
	msgs, err := c.commandUnchecked(ctx, cmd)
	if err != nil {
		return nil, err
	}
	return Lines(msgs), nil
}
