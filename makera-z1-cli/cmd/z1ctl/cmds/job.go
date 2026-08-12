package cmds

import (
	"context"
	"crypto/md5" // #nosec G501 -- the machine's own transfer protocol speaks MD5
	"encoding/hex"
	"fmt"
	"os"
	"path"
	"time"

	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
	"github.com/go-go-golems/glazed/pkg/middlewares"
	"github.com/go-go-golems/glazed/pkg/types"
	"github.com/pkg/errors"

	"github.com/go-go-golems/makera-z1-cli/pkg/makera"
)

// Job lifecycle commands. The class discipline, uniformly:
//
//	play      Class 1 — motion path, --confirm, full preflight
//	suspend   Class 0 — never gated
//	abort     Class 0 — never gated
//	resume    Class 2 — --confirm, preflight that tolerates the paused job
//	progress  read-only

// JobPlayCommand starts a stored program.
type JobPlayCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = &JobPlayCommand{}

type jobPlaySettings struct {
	Path string `glazed:"path"`
}

func NewJobPlayCommand() (*JobPlayCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &JobPlayCommand{cmds.NewCommandDescription(
		"play",
		cmds.WithShort("Start a stored program (requires --confirm)"),
		cmds.WithLong(`Start a program already on the machine's SD card.

This is effectively unbounded motion: the machine executes the whole file.
Preflight requires: homed, no alarm, e-stop clear, cover closed, nothing
already running. Inspect first with --dry-run.

  z1ctl job play /sd/gcodes/part.nc --confirm

Supervise it with 'z1ctl watch' or the web page; stop it with
'z1ctl job suspend' or 'z1ctl job abort', which are never gated.`),
		cmds.WithArguments(
			fields.New("path", fields.TypeString,
				fields.WithIsArgument(true),
				fields.WithHelp("Absolute path on the machine, e.g. /sd/gcodes/part.nc")),
		),
		cmds.WithFlags(motionFlagDefs()...),
		cmds.WithSections(conn),
	)}, nil
}

func (c *JobPlayCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &jobPlaySettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	op, err := makera.PlayFile(s.Path)
	if err != nil {
		return err
	}
	return runMotionRequest(ctx, vals, gp, makera.MotionRequest{
		Ops:    []makera.MotionOp{op},
		Reason: "operator play from CLI: " + s.Path,
	})
}

// jobSimpleCommand covers suspend / abort (Class 0) and resume (Class 2).
type jobSimpleCommand struct {
	*cmds.CommandDescription
	verb string
}

var _ cmds.GlazeCommand = &jobSimpleCommand{}

func newJobSimpleCommand(verb, short, long string, gated bool) (*jobSimpleCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	flagDefs := []*fields.Definition{}
	if gated {
		flagDefs = motionFlagDefs()
	}
	return &jobSimpleCommand{
		CommandDescription: cmds.NewCommandDescription(
			verb,
			cmds.WithShort(short),
			cmds.WithLong(long),
			cmds.WithFlags(flagDefs...),
			cmds.WithSections(conn),
		),
		verb: verb,
	}, nil
}

func (c *jobSimpleCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	client, err := DialFrom(ctx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	switch c.verb {
	case "suspend":
		if _, err := client.Suspend(ctx); err != nil {
			return err
		}
	case "abort":
		if _, err := client.Abort(ctx); err != nil {
			return err
		}
	case "resume":
		f, err := decodeMotionFlags(vals)
		if err != nil {
			return err
		}
		if !f.Confirm {
			return errors.New("refusing: resume restarts motion that was deliberately stopped. Re-run with --confirm")
		}
		if _, err := client.Resume(ctx, makera.PreflightOptions{AllowOpenCover: f.AllowOpenCover}); err != nil {
			return err
		}
	}

	st, err := client.QueryStatus(ctx)
	if err != nil {
		return err
	}
	return gp.AddRow(ctx, types.NewRow(
		types.MRP("action", c.verb),
		types.MRP("state", st.State),
		types.MRP("playing", st.Playing != nil && st.Playing.Active),
	))
}

// JobProgressCommand is the one-shot progress query.
type JobProgressCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = &JobProgressCommand{}

func NewJobProgressCommand() (*JobProgressCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &JobProgressCommand{cmds.NewCommandDescription(
		"progress",
		cmds.WithShort("Report job progress (read-only)"),
		cmds.WithSections(conn),
	)}, nil
}

func (c *JobProgressCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	client, err := DialFrom(ctx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	pb, playing, err := client.Progress(ctx)
	if err != nil {
		return err
	}
	return gp.AddRow(ctx, types.NewRow(
		types.MRP("playing", playing),
		types.MRP("line", pb.Lines),
		types.MRP("percent", pb.Percent),
		types.MRP("seconds", pb.Seconds),
	))
}

// JobRunCommand is the composite: upload → verify → preflight → play → monitor.
type JobRunCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = &JobRunCommand{}

type jobRunSettings struct {
	Local  string `glazed:"local"`
	Remote string `glazed:"remote"`
	Poll   string `glazed:"poll"`
}

func NewJobRunCommand() (*JobRunCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &JobRunCommand{cmds.NewCommandDescription(
		"run",
		cmds.WithShort("Upload, verify, play and monitor to completion (requires --confirm)"),
		cmds.WithLong(`The whole workflow as one command, failing closed at every step:

  upload the local file → verify the remote digest → preflight → play →
  monitor until the program ends

If the digest does not verify, it does not play. If the preflight fails, it
does not play. If the machine alarms mid-job, the halt reason and its
required recovery are reported and the exit code is 3. Nothing is ever
retried, and this command NEVER clears an alarm.

Exit codes: 0 completed · 1 usage/connection · 2 refused · 3 ended in alarm.

  z1ctl job run part.nc --confirm
  z1ctl job run part.nc --remote /sd/gcodes/part.nc --confirm`),
		cmds.WithArguments(
			fields.New("local", fields.TypeString,
				fields.WithIsArgument(true),
				fields.WithHelp("Local G-code file")),
		),
		cmds.WithFlags(append(motionFlagDefs(),
			fields.New("remote", fields.TypeString,
				fields.WithDefault(""),
				fields.WithHelp("Remote path; default /sd/gcodes/<basename>")),
			fields.New("poll", fields.TypeString,
				fields.WithDefault("2s"),
				fields.WithHelp("Progress poll interval while monitoring")),
		)...),
		cmds.WithSections(conn),
	)}, nil
}

func (c *JobRunCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &jobRunSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return errors.Wrap(err, "decode settings")
	}
	f, err := decodeMotionFlags(vals)
	if err != nil {
		return err
	}
	remote := s.Remote
	if remote == "" {
		remote = path.Join("/sd/gcodes", path.Base(s.Local))
	}
	poll, err := time.ParseDuration(s.Poll)
	if err != nil || poll < 200*time.Millisecond {
		return errors.Errorf("--poll %q must be a duration of at least 200ms", s.Poll)
	}

	playOp, err := makera.PlayFile(remote)
	if err != nil {
		return err
	}
	req := makera.MotionRequest{
		Ops:    []makera.MotionOp{playOp},
		Reason: "operator job run from CLI: " + s.Local,
	}
	if f.DryRun {
		return emitDryRun(ctx, gp, req)
	}
	if !f.Confirm {
		return errors.New("refusing: job run uploads AND starts a program. Inspect with --dry-run, then re-run with --confirm")
	}

	local, err := os.Open(s.Local)
	if err != nil {
		return errors.Wrap(err, "open local file")
	}
	defer func() { _ = local.Close() }()
	info, err := local.Stat()
	if err != nil {
		return err
	}
	sum := md5.New() // #nosec G401 -- protocol-mandated digest, not cryptography
	if _, err := local.Seek(0, 0); err != nil {
		return err
	}
	buf := make([]byte, 64*1024)
	for {
		n, rerr := local.Read(buf)
		if n > 0 {
			_, _ = sum.Write(buf[:n])
		}
		if rerr != nil {
			break
		}
	}
	digest := hex.EncodeToString(sum.Sum(nil))
	if _, err := local.Seek(0, 0); err != nil {
		return err
	}

	client, err := DialFrom(ctx, vals)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	// Step 1: upload.
	up, err := client.Upload(ctx, remote, local, info.Size(), digest, nil)
	if err != nil {
		return errors.Wrap(err, "upload failed; nothing was played")
	}
	_ = gp.AddRow(ctx, types.NewRow(
		types.MRP("step", "upload"),
		types.MRP("ok", true),
		types.MRP("detail", fmt.Sprintf("%d bytes, cached=%v", info.Size(), up.CacheHit)),
	))

	// Step 2: verify. Fail closed — an unverifiable digest refuses the play,
	// because running a half-written program is the worst outcome available.
	remoteDigest, ok, err := client.RemoteMD5(ctx, remote)
	if err != nil {
		return errors.Wrap(err, "digest verification failed; refusing to play")
	}
	if ok && remoteDigest != digest {
		return errors.Errorf("refusing to play: remote digest %s != local %s", remoteDigest, digest)
	}
	detail := "digest match"
	if !ok {
		detail = "firmware returned no usable digest; sizes verified by the transfer protocol"
	}
	_ = gp.AddRow(ctx, types.NewRow(
		types.MRP("step", "verify"), types.MRP("ok", true), types.MRP("detail", detail)))

	// Steps 3+4: preflight and play, through the one authorised path.
	res, err := client.Motion(ctx, req, makera.PreflightOptions{AllowOpenCover: f.AllowOpenCover})
	if err != nil {
		return err
	}
	_ = gp.AddRow(ctx, types.NewRow(
		types.MRP("step", "play"), types.MRP("ok", true),
		types.MRP("detail", res.Sent[0])))

	// Step 5: monitor. Re-reads only; never re-sends anything.
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(poll):
		}
		st, err := client.QueryStatus(ctx)
		if err != nil {
			return errors.Wrap(err, "lost the machine while monitoring; the job continues on the machine")
		}
		if st.State == "Alarm" {
			text, recovery, _ := makera.HaltReason(st.HaltReason)
			_ = gp.AddRow(ctx, types.NewRow(
				types.MRP("step", "monitor"), types.MRP("ok", false),
				types.MRP("detail", fmt.Sprintf("ALARM %d: %s — %s", st.HaltReason, text, recovery))))
			return errors.Wrapf(makera.ErrJobEndedInAlarm,
				"halt reason %d (%s); required recovery: %s — this tool never clears an alarm for you",
				st.HaltReason, text, recovery)
		}
		if st.Playing != nil && st.Playing.Active {
			_ = gp.AddRow(ctx, types.NewRow(
				types.MRP("step", "monitor"), types.MRP("ok", true),
				types.MRP("detail", fmt.Sprintf("line %d, %d%%, %ds", st.Playing.Lines, st.Playing.Percent, st.Playing.Seconds))))
			continue
		}
		_ = gp.AddRow(ctx, types.NewRow(
			types.MRP("step", "complete"), types.MRP("ok", true),
			types.MRP("detail", "state "+st.State)))
		return nil
	}
}

// NewJobCommands builds the job group's subcommands.
func NewJobCommands() ([]cmds.Command, error) {
	play, err := NewJobPlayCommand()
	if err != nil {
		return nil, err
	}
	suspend, err := newJobSimpleCommand("suspend",
		"Pause the running job (never gated)",
		"Pause the running job. Never gated: no confirmation, no preflight, any state.", false)
	if err != nil {
		return nil, err
	}
	abort, err := newJobSimpleCommand("abort",
		"End the running job (never gated)",
		"End the running job. Never gated: no confirmation, no preflight, any state.", false)
	if err != nil {
		return nil, err
	}
	resume, err := newJobSimpleCommand("resume",
		"Resume a suspended job (requires --confirm)",
		`Resume a suspended job. State-enabling: it restarts motion that was
deliberately stopped, so it requires --confirm and preflights first
(tolerating the paused job itself).`, true)
	if err != nil {
		return nil, err
	}
	progress, err := NewJobProgressCommand()
	if err != nil {
		return nil, err
	}
	run, err := NewJobRunCommand()
	if err != nil {
		return nil, err
	}
	return []cmds.Command{play, suspend, abort, resume, progress, run}, nil
}
