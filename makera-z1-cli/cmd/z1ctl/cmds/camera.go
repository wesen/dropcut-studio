package cmds

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/go-go-golems/glazed/pkg/cli"
	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
	"github.com/go-go-golems/glazed/pkg/middlewares"
	"github.com/go-go-golems/glazed/pkg/types"
	"github.com/pkg/errors"
	"github.com/spf13/cobra"

	"github.com/go-go-golems/makera-z1-cli/pkg/makera"
)

// Camera commands. The camera is a separate service on the machine's WiFi
// module (WebSocket on port 82, HTTP control on port 80) — it never touches
// the single control connection on port 2222, and nothing here can move
// anything.

// cameraHostFrom resolves the machine address and strips the control port.
func cameraHostFrom(ctx context.Context, vals *values.Values) (string, error) {
	conn, err := DecodeConnection(vals)
	if err != nil {
		return "", err
	}
	opts, err := conn.Resolve(ctx)
	if err != nil {
		return "", err
	}
	return makera.CameraHost(opts.Address), nil
}

// CameraProbeCommand answers whether a camera is present.
type CameraProbeCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = &CameraProbeCommand{}

func NewCameraProbeCommand() (*CameraProbeCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &CameraProbeCommand{cmds.NewCommandDescription(
		"probe",
		cmds.WithShort("Check whether the machine has a camera"),
		cmds.WithSections(conn),
	)}, nil
}

func (c *CameraProbeCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	host, err := cameraHostFrom(ctx, vals)
	if err != nil {
		return err
	}
	return gp.AddRow(ctx, types.NewRow(
		types.MRP("host", host),
		types.MRP("camera", makera.HasCamera(ctx, host)),
	))
}

// CameraSnapCommand grabs one frame to a file.
type CameraSnapCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = &CameraSnapCommand{}

type cameraSnapSettings struct {
	Out    string `glazed:"out"`
	Warmup int    `glazed:"warmup"`
}

func NewCameraSnapCommand() (*CameraSnapCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	return &CameraSnapCommand{cmds.NewCommandDescription(
		"snap",
		cmds.WithShort("Grab one JPEG frame from the camera"),
		cmds.WithLong(`Connect to the camera stream, let the sensor settle, save one
frame and disconnect. Read-only; the camera is a separate service and the
machine's control connection is not used.

The sensor's auto white balance runs on-camera and converges only while
streaming — the first frames of a cold stream carry a strong green cast
(measured: frame 1 green, frame 60 neutral). --warmup discards that many
frames first; ~30 is a second and a half of stream.

  z1ctl camera snap --out bed.jpg`),
		cmds.WithFlags(
			fields.New("out", fields.TypeString,
				fields.WithDefault("camera.jpg"),
				fields.WithHelp("Output file")),
			fields.New("warmup", fields.TypeInteger,
				fields.WithDefault(30),
				fields.WithHelp("Frames to discard while the sensor's white balance converges; 0 keeps the first (green-tinted) frame")),
		),
		cmds.WithSections(conn),
	)}, nil
}

func (c *CameraSnapCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &cameraSnapSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return err
	}
	host, err := cameraHostFrom(ctx, vals)
	if err != nil {
		return err
	}
	cam, err := makera.DialCamera(ctx, host)
	if err != nil {
		return err
	}
	defer func() { _ = cam.Close() }()

	for i := 0; i < s.Warmup; i++ {
		if _, err := cam.NextFrame(10 * time.Second); err != nil {
			return errors.Wrapf(err, "warmup frame %d", i+1)
		}
	}
	frame, err := cam.NextFrame(10 * time.Second)
	if err != nil {
		return errors.Wrap(err, "waiting for a frame")
	}
	if err := os.WriteFile(s.Out, frame, 0o644); err != nil {
		return err
	}
	return gp.AddRow(ctx, types.NewRow(
		types.MRP("file", s.Out),
		types.MRP("bytes", len(frame)),
		types.MRP("warmup_frames", s.Warmup),
	))
}

// CameraResolutionCommand switches the stream size.
type CameraResolutionCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = &CameraResolutionCommand{}

type cameraResSettings struct {
	Size string `glazed:"size"`
}

func NewCameraResolutionCommand() (*CameraResolutionCommand, error) {
	conn, err := NewConnectionSection()
	if err != nil {
		return nil, err
	}
	choices := make([]string, 0, len(makera.CameraResolutions))
	for _, r := range makera.CameraResolutions {
		choices = append(choices, fmt.Sprintf("%dx%d", r.Width, r.Height))
	}
	return &CameraResolutionCommand{cmds.NewCommandDescription(
		"resolution",
		cmds.WithShort("Switch the camera resolution"),
		cmds.WithLong(`Set the stream size. Only the sizes the firmware is known to
honour are offered — it answers 200 to anything and silently ignores
out-of-range values. Frame rate falls as sizes climb (~20fps at 640x480,
~10 at 1600x1200). A running stream adopts the new size within a frame
or two.

  z1ctl camera resolution 800x600`),
		cmds.WithArguments(
			fields.New("size", fields.TypeChoice,
				fields.WithChoices(choices...),
				fields.WithIsArgument(true),
				fields.WithHelp("Stream size, WxH")),
		),
		cmds.WithSections(conn),
	)}, nil
}

func (c *CameraResolutionCommand) RunIntoGlazeProcessor(
	ctx context.Context, vals *values.Values, gp middlewares.Processor,
) error {
	s := &cameraResSettings{}
	if err := vals.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return err
	}
	value := -1
	for _, r := range makera.CameraResolutions {
		if strings.EqualFold(s.Size, fmt.Sprintf("%dx%d", r.Width, r.Height)) {
			value = r.Value
			break
		}
	}
	if value < 0 {
		return errors.Errorf("unknown size %q", s.Size)
	}
	host, err := cameraHostFrom(ctx, vals)
	if err != nil {
		return err
	}
	if err := makera.SetCameraResolution(ctx, host, value); err != nil {
		return err
	}
	return gp.AddRow(ctx, types.NewRow(
		types.MRP("resolution", s.Size),
		types.MRP("value", value),
		types.MRP("ok", true),
	))
}

// NewCameraGroup mounts the camera commands under one parent.
func NewCameraGroup() (*cobra.Command, error) {
	group := &cobra.Command{
		Use:   "camera",
		Short: "The machine's camera (separate service; cannot move anything)",
	}
	probe, err := NewCameraProbeCommand()
	if err != nil {
		return nil, err
	}
	snap, err := NewCameraSnapCommand()
	if err != nil {
		return nil, err
	}
	res, err := NewCameraResolutionCommand()
	if err != nil {
		return nil, err
	}
	if err := cli.AddCommandsToRootCommand(group,
		[]cmds.Command{probe, snap, res}, nil, parserOptions()...); err != nil {
		return nil, errors.Wrap(err, "register camera commands")
	}
	return group, nil
}
