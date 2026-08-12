package cmds

import (
	"context"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
	"github.com/go-go-golems/glazed/pkg/middlewares"
	"github.com/go-go-golems/glazed/pkg/types"
	"github.com/pkg/errors"

	"github.com/go-go-golems/makera-z1-cli/pkg/makera"
)

// PutCommand uploads a local file to the machine.
type PutCommand struct{ *cmds.CommandDescription }

type putSettings struct {
	Local    string `glazed:"local"`
	Remote   string `glazed:"remote"`
	Progress bool   `glazed:"progress"`
	NoVerify bool   `glazed:"no-verify"`
	Force    bool   `glazed:"force"`
}

var _ cmds.GlazeCommand = &PutCommand{}

func NewPutCommand() (*PutCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &PutCommand{cmds.NewCommandDescription(
		"put",
		cmds.WithShort("Upload a local file to the machine"),
		cmds.WithLong(`Upload a file to the machine's SD card.

WRITES TO THE MACHINE. It cannot cause motion, but it can overwrite a file.

Uploading does not run anything. On this machine a job is started separately
with 'play', so putting a file on the SD card is safe in the sense that matters:
nothing moves until something explicitly says so.

The local file's MD5 is offered to the machine before any data is sent. If the
machine already holds a file with that digest it cancels the transfer, which is
reported as cached=true — that is the fast path, not a failure.

After the transfer the remote digest is read back and compared, unless
--no-verify. On firmware that returns a real digest this is a genuine
end-to-end check; on firmware that returns the known 32-character placeholder
it degrades to verified=false with a reason rather than a false pass.

Refuses while a job is running, unless --force.

Examples:
  z1ctl fs put part.nc
  z1ctl fs put part.nc --remote /sd/gcodes/projects/
  z1ctl fs put part.nc --remote /sd/gcodes/renamed.nc`),
		cmds.WithArguments(
			fields.New("local", fields.TypeString,
				fields.WithIsArgument(true),
				fields.WithHelp("Local file to upload")),
		),
		cmds.WithFlags(
			fields.New("remote", fields.TypeString,
				fields.WithDefault("/sd/gcodes/"),
				fields.WithHelp("Remote directory (trailing slash) or full remote path")),
			fields.New("progress", fields.TypeBool,
				fields.WithDefault(true),
				fields.WithHelp("Show transfer progress on stderr")),
			fields.New("no-verify", fields.TypeBool,
				fields.WithDefault(false),
				fields.WithHelp("Skip reading the remote digest back after upload")),
			fields.New("force", fields.TypeBool,
				fields.WithDefault(false),
				fields.WithHelp("Upload even while the machine is running a job")),
		),
		cmds.WithSections(conn),
	)}, nil
}

func (c *PutCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &putSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	if s.Local == "" {
		return errors.New("no local file given")
	}

	f, err := os.Open(s.Local)
	if err != nil {
		return errors.Wrap(err, "open local file")
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		return errors.Wrap(err, "stat local file")
	}
	if info.IsDir() {
		return errors.Errorf("%s is a directory", s.Local)
	}

	digest, err := fileMD5(s.Local)
	if err != nil {
		return errors.Wrap(err, "hash local file")
	}

	remote := s.Remote
	if strings.HasSuffix(remote, "/") || remote == "" {
		remote = path.Join(remote, filepath.Base(s.Local))
	}

	client, err := DialFrom(ctx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	// A transfer while the machine is mid-job competes for the same connection
	// and the same tiny amount of RAM. Refuse unless told otherwise.
	if !s.Force {
		st, err := client.QueryStatus(ctx)
		if err != nil {
			return errors.Wrap(err, "read status before uploading")
		}
		if st.State == "Run" || (st.Playing != nil && st.Playing.Active) {
			return errors.Errorf("refusing: machine is %q and appears to be running a job; pass --force to upload anyway", st.State)
		}
	}

	onProgress := func(makera.TransferProgress) {}
	if s.Progress {
		onProgress = func(p makera.TransferProgress) {
			fmt.Fprintf(os.Stderr, "\ruploading %s  block %d/%d  %d bytes",
				remote, p.Block, p.TotalBlocks, p.Bytes)
		}
	}

	res, err := client.Upload(ctx, remote, f, info.Size(), digest, onProgress)
	if s.Progress {
		fmt.Fprintln(os.Stderr)
	}
	if err != nil {
		return err
	}

	row := types.NewRow(
		types.MRP("local", s.Local),
		types.MRP("remote", remote),
		types.MRP("bytes", info.Size()),
		types.MRP("blocks", res.Blocks),
		types.MRP("cached", res.CacheHit),
		types.MRP("local_md5", digest),
	)

	if !s.NoVerify {
		remoteDigest, ok, err := client.RemoteMD5(ctx, remote)
		if err != nil {
			return errors.Wrap(err, "read back remote digest")
		}
		switch {
		case !ok:
			row.Set("verified", false)
			row.Set("verify_skipped", "machine advertised no usable digest")
		default:
			row.Set("remote_md5", remoteDigest)
			row.Set("verified", remoteDigest == digest)
			if remoteDigest != digest {
				return errors.Errorf(
					"upload verification FAILED: local %s, remote %s — the file on the machine is not what was sent",
					digest, remoteDigest)
			}
		}
	}
	return gp.AddRow(ctx, row)
}
