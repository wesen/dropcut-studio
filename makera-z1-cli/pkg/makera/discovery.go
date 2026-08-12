package makera

import (
	"context"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/errors"
)

// DiscoveryPort is the UDP port machines broadcast on.
const DiscoveryPort = 3333

// discoveryBufSize matches what published clients read per datagram.
const discoveryBufSize = 128

// Machine is one discovered machine.
type Machine struct {
	Name string
	IP   string
	Port int
	Busy bool
	// State is the machine's run state ("Idle", "Run", ...). Real firmware
	// appends it as a fifth field, which published clients discard. It is
	// genuinely useful: because the machine accepts only one client, this is
	// the only way to see what a machine is doing without taking its
	// connection slot away from whoever is using it. Empty if not sent.
	State string
	// Extra holds any further fields, so a firmware update that appends more
	// does not silently lose information.
	Extra []string
}

// Addr returns the dialable address.
func (m Machine) Addr() string { return net.JoinHostPort(m.IP, strconv.Itoa(m.Port)) }

// ParseAnnouncement decodes one discovery datagram.
//
// Format: name,ip,port,busy[,state][,...]. More than three fields are required;
// extra fields are preserved rather than dropped, which is what makes the
// record format forward-compatible.
func ParseAnnouncement(data []byte) (Machine, error) {
	fields := strings.Split(strings.TrimSpace(string(data)), ",")
	if len(fields) <= 3 {
		return Machine{}, errors.Errorf("short discovery record: %q", string(data))
	}
	port, err := strconv.Atoi(strings.TrimSpace(fields[2]))
	if err != nil {
		return Machine{}, errors.Wrapf(err, "bad port in discovery record %q", string(data))
	}
	m := Machine{
		Name: fields[0],
		IP:   fields[1],
		Port: port,
		Busy: strings.TrimSpace(fields[3]) == "1",
	}
	if len(fields) > 4 {
		m.State = strings.TrimSpace(fields[4])
	}
	if len(fields) > 5 {
		m.Extra = fields[5:]
	}
	return m, nil
}

// Discover listens for machine announcements for the given duration.
//
// Discovery is passive: the host never sends a probe, it binds and listens.
// Machines broadcast roughly every 1.5 s, so a 3 s window catches two.
//
// Binding the port fails if Makera's own controller is already running.
func Discover(ctx context.Context, timeout time.Duration) ([]Machine, error) {
	lc := net.ListenConfig{Control: reusePort}
	pc, err := lc.ListenPacket(ctx, "udp4", net.JoinHostPort("0.0.0.0", strconv.Itoa(DiscoveryPort)))
	if err != nil {
		return nil, errors.Wrapf(err, "bind udp :%d (is another controller running?)", DiscoveryPort)
	}
	defer func() { _ = pc.Close() }()

	deadline := time.Now().Add(timeout)
	seen := map[string]Machine{}
	var order []string
	buf := make([]byte, discoveryBufSize)

	for time.Now().Before(deadline) {
		if err := pc.SetReadDeadline(deadline); err != nil {
			break
		}
		n, _, err := pc.ReadFrom(buf)
		if err != nil {
			if IsTimeout(err) {
				break
			}
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			continue
		}
		m, err := ParseAnnouncement(buf[:n])
		if err != nil {
			continue
		}
		if _, dup := seen[m.Name]; !dup {
			order = append(order, m.Name)
		}
		seen[m.Name] = m // refresh: later records carry newer state
	}

	out := make([]Machine, 0, len(order))
	for _, name := range order {
		out = append(out, seen[name])
	}
	return out, nil
}

// DiscoverOne waits for the first machine, or returns an error if none appears.
func DiscoverOne(ctx context.Context, timeout time.Duration) (Machine, error) {
	machines, err := Discover(ctx, timeout)
	if err != nil {
		return Machine{}, err
	}
	switch len(machines) {
	case 0:
		return Machine{}, errors.Errorf("no machine found after %s", timeout)
	case 1:
		return machines[0], nil
	default:
		names := make([]string, 0, len(machines))
		for _, m := range machines {
			names = append(names, m.Name+" ("+m.Addr()+")")
		}
		return Machine{}, errors.Errorf(
			"multiple machines found, use --device to choose: %s", strings.Join(names, ", "))
	}
}
