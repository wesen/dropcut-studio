package cmds

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
	"github.com/go-go-golems/glazed/pkg/middlewares"
	"github.com/go-go-golems/glazed/pkg/types"
	"github.com/pkg/errors"

	"github.com/go-go-golems/makera-z1-cli/pkg/makera"
)

// GetCommand downloads a file from the machine.
type GetCommand struct{ *cmds.CommandDescription }

type getSettings struct {
	Remote    string `glazed:"remote"`
	Out       string `glazed:"out"`
	Overwrite bool   `glazed:"overwrite"`
	Progress  bool   `glazed:"progress"`
}

var _ cmds.GlazeCommand = &GetCommand{}

func NewGetCommand() (*GetCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &GetCommand{cmds.NewCommandDescription(
		"get",
		cmds.WithShort("Download a file from the machine"),
		cmds.WithLong(`Download a file from the machine's SD card.

Read-only with respect to the machine: this reads from the SD card and cannot
cause motion. It is also the only way to read a remote file — the firmware's
'cat' command returns "File not found" for every file, including ones it has
just listed.

If a local copy already exists, its MD5 is offered to the machine first. When
they match, the machine cancels the transfer and nothing is sent — reported as
cached=true. That is the fast path, not a failure.

Integrity: the advertised digest is validated as 32 hexadecimal characters
before it is trusted, because some Z1 firmware answers with a fixed
32-character placeholder that is not a digest. When no usable digest is
advertised, the download still succeeds but verified=false and verify_skipped
says why. A QuickLZ-compressed payload also reports verified=false, because the
advertised digest describes the decompressed bytes and this tool does not
decompress.

Examples:
  z1ctl fs get /sd/gcodes/part.nc
  z1ctl fs get /sd/gcodes/part.nc --out ./part.nc --overwrite
  z1ctl fs get /sd/config.txt --out - > config.txt`),
		cmds.WithArguments(
			fields.New("remote", fields.TypeString,
				fields.WithIsArgument(true),
				fields.WithHelp("Absolute path on the machine")),
		),
		cmds.WithFlags(
			fields.New("out", fields.TypeString,
				fields.WithDefault(""),
				fields.WithHelp("Local path. Defaults to the basename; '-' writes to stdout")),
			fields.New("overwrite", fields.TypeBool,
				fields.WithDefault(false),
				fields.WithHelp("Overwrite an existing local file instead of refusing")),
			fields.New("progress", fields.TypeBool,
				fields.WithDefault(true),
				fields.WithHelp("Show transfer progress on stderr")),
		),
		cmds.WithSections(conn),
	)}, nil
}

func (c *GetCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &getSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	if s.Remote == "" {
		return errors.New("no remote path given")
	}

	local := s.Out
	if local == "" {
		local = filepath.Base(s.Remote)
	}
	toStdout := local == "-"

	// Offer the local digest so the machine can short-circuit an identical file.
	localDigest := ""
	if !toStdout {
		if sum, err := fileMD5(local); err == nil {
			localDigest = sum
		} else if !os.IsNotExist(errors.Cause(err)) && !s.Overwrite {
			return errors.Wrapf(err, "inspect existing %s", local)
		}
	}

	client, err := DialFrom(ctx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	var (
		w      io.Writer
		tmp    *os.File
		outErr error
	)
	if toStdout {
		w = os.Stdout
	} else {
		tmp, outErr = os.CreateTemp(filepath.Dir(local), ".z1ctl-*")
		if outErr != nil {
			return errors.Wrap(outErr, "create temporary file")
		}
		defer func() { _ = os.Remove(tmp.Name()) }()
		w = tmp
	}

	onProgress := func(makera.TransferProgress) {}
	if s.Progress {
		onProgress = func(p makera.TransferProgress) {
			if p.TotalBlocks > 0 {
				fmt.Fprintf(os.Stderr, "\rdownloading %s  block %d/%d  %d bytes",
					s.Remote, p.Block, p.TotalBlocks, p.Bytes)
			}
		}
	}

	res, err := client.Download(ctx, s.Remote, w, localDigest, onProgress)
	if s.Progress {
		fmt.Fprintln(os.Stderr)
	}
	if err != nil {
		return err
	}

	if tmp != nil {
		if err := tmp.Close(); err != nil {
			return errors.Wrap(err, "close temporary file")
		}
		if !res.CacheHit {
			if _, err := os.Stat(local); err == nil && !s.Overwrite {
				return errors.Errorf("%s exists and differs from the machine's copy; pass --overwrite", local)
			}
			// Rename last, so a failed transfer never leaves a truncated file
			// in place of a good one.
			if err := os.Rename(tmp.Name(), local); err != nil {
				return errors.Wrap(err, "move downloaded file into place")
			}
		}
	}

	row := types.NewRow(
		types.MRP("remote", s.Remote),
		types.MRP("bytes", res.Bytes),
		types.MRP("blocks", res.Blocks),
		types.MRP("cached", res.CacheHit),
		types.MRP("verified", res.Verified),
		types.MRP("md5", res.ActualMD5),
		types.MRP("advertised_md5", res.AdvertisedMD5),
	)
	if !toStdout {
		row.Set("local", local)
	}
	if res.VerifySkipped != "" {
		row.Set("verify_skipped", res.VerifySkipped)
	}
	if res.Compressed {
		row.Set("compressed", true)
	}
	return gp.AddRow(ctx, row)
}

func fileMD5(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := md5.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
