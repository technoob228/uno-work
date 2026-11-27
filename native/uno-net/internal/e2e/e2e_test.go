// End to end: SOCKS5 client → uno-net (socks + engine + tunnel) → a real
// WireGuard / AmneziaWG exit in the same process → echo / DNS behind it.
package e2e

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/technoob228/uno-work/native/uno-net/internal/config"
	"github.com/technoob228/uno-work/native/uno-net/internal/engine"
	"github.com/technoob228/uno-work/native/uno-net/internal/exittest"
	"github.com/technoob228/uno-work/native/uno-net/internal/socks"
)

const token = "test-socks-token-0123456789abcdef0123"

// awg is an AmneziaWG 1.5-style obfuscation: junk packets, padded
// handshakes, custom message types.
var awg = map[string]string{
	"jc": "4", "jmin": "40", "jmax": "70",
	"s1": "15", "s2": "18",
	"h1": "1234567", "h2": "2345678", "h3": "3456789", "h4": "4567890",
}

func transport(client exittest.Key, exit *exittest.Exit, proto config.Protocol, obf map[string]string) config.Transport {
	return config.Transport{
		Protocol:    proto,
		PrivateKey:  client.Private,
		Addresses:   []string{exittest.ClientIP.String() + "/32"},
		DNS:         []string{exittest.ExitIP.String()},
		Obfuscation: obf,
		Peer: config.Peer{
			PublicKey: exit.Key.Public,
			Endpoint:  exit.Endpoint(),
		},
	}
}

type rig struct {
	eng  *engine.Engine
	addr string
}

func start(t *testing.T, cfg *config.Config) *rig {
	t.Helper()
	if cfg.ProbeIntervalMs == 0 {
		cfg.ProbeIntervalMs = 300
	}
	if cfg.ProbeFailures == 0 {
		cfg.ProbeFailures = 2
	}
	if cfg.Probe == "" {
		cfg.Probe = exittest.ExitIP.String()
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	eng := engine.New(nil)
	eng.ConnectWait = 2 * time.Second
	eng.Apply(cfg)
	t.Cleanup(eng.Stop)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &socks.Server{Dialer: eng, Token: token, DialTimeout: 5 * time.Second}
	go srv.Serve(ln)
	t.Cleanup(srv.Close)
	return &rig{eng: eng, addr: ln.Addr().String()}
}

func waitStatus(t *testing.T, eng *engine.Engine, d time.Duration, want ...engine.Status) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	if st, err := eng.WaitStatus(ctx, want...); err != nil {
		t.Fatalf("status %s, want %v (%+v)", st, want, eng.Snapshot())
	}
}

// --- a small SOCKS5 client ---

func socksAuth(t *testing.T, c net.Conn, pass string) error {
	t.Helper()
	c.Write([]byte{5, 1, 2})
	var m [2]byte
	if _, err := io.ReadFull(c, m[:]); err != nil {
		return err
	}
	if m[1] != 2 {
		return errors.New("method refused")
	}
	b := []byte{1, 4, 't', 'e', 's', 't', byte(len(pass))}
	c.Write(append(b, pass...))
	var r [2]byte
	if _, err := io.ReadFull(c, r[:]); err != nil {
		return err
	}
	if r[1] != 0 {
		return errors.New("auth refused")
	}
	return nil
}

func socksAddr(host string, port int) []byte {
	var b []byte
	if ip, err := netip.ParseAddr(host); err == nil && ip.Is4() {
		v := ip.As4()
		b = append([]byte{1}, v[:]...)
	} else {
		b = append([]byte{3, byte(len(host))}, host...)
	}
	return binary.BigEndian.AppendUint16(b, uint16(port))
}

// request sends a command and returns the reply code and bound address.
func request(t *testing.T, c net.Conn, cmd byte, host string, port int) (byte, netip.AddrPort) {
	t.Helper()
	c.Write(append([]byte{5, cmd, 0}, socksAddr(host, port)...))
	var h [4]byte
	if _, err := io.ReadFull(c, h[:]); err != nil {
		t.Fatalf("reply: %v", err)
	}
	var ap netip.AddrPort
	switch h[3] {
	case 1:
		var b [6]byte
		io.ReadFull(c, b[:])
		ap = netip.AddrPortFrom(netip.AddrFrom4([4]byte(b[:4])), binary.BigEndian.Uint16(b[4:]))
	case 4:
		var b [18]byte
		io.ReadFull(c, b[:])
		ap = netip.AddrPortFrom(netip.AddrFrom16([16]byte(b[:16])), binary.BigEndian.Uint16(b[16:]))
	default:
		t.Fatalf("reply atyp %d", h[3])
	}
	return h[1], ap
}

func connect(t *testing.T, r *rig, host string, port int) (net.Conn, byte) {
	t.Helper()
	c, err := net.Dial("tcp", r.addr)
	if err != nil {
		t.Fatal(err)
	}
	c.SetDeadline(time.Now().Add(10 * time.Second))
	if err := socksAuth(t, c, token); err != nil {
		t.Fatal(err)
	}
	rep, _ := request(t, c, 1, host, port)
	if rep != 0 {
		c.Close()
		return nil, rep
	}
	return c, rep
}

func echo(t *testing.T, c net.Conn, msg string) {
	t.Helper()
	if _, err := c.Write([]byte(msg)); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(msg))
	if _, err := io.ReadFull(c, got); err != nil {
		t.Fatal(err)
	}
	if string(got) != msg {
		t.Fatalf("echo %q, want %q", got, msg)
	}
}

// --- tests ---

func TestWireGuardTCPByIPAndName(t *testing.T) {
	client := exittest.NewKey(t)
	exit := exittest.Start(t, client.Public, exittest.Options{})
	r := start(t, &config.Config{Transports: []config.Transport{transport(client, exit, config.WireGuard, nil)}})
	waitStatus(t, r.eng, 10*time.Second, engine.On)

	snap := r.eng.Snapshot()
	if snap.ActiveProtocol != config.WireGuard || snap.Since == nil || snap.LastHandshake == nil {
		t.Fatalf("snapshot %+v", snap)
	}

	c, rep := connect(t, r, exittest.ExitIP.String(), 7)
	if rep != 0 {
		t.Fatalf("connect by IP: reply %d", rep)
	}
	echo(t, c, "hello through the tunnel")
	c.Close()

	c, rep = connect(t, r, exittest.EchoName, 7)
	if rep != 0 {
		t.Fatalf("connect by name: reply %d", rep)
	}
	big := bytes.Repeat([]byte("0123456789abcdef"), 64*1024) // 1 MiB
	go c.Write(big)
	got := make([]byte, len(big))
	if _, err := io.ReadFull(c, got); err != nil || !bytes.Equal(got, big) {
		t.Fatalf("1 MiB echo: %v", err)
	}
	c.Close()
}

func TestAmneziaWG(t *testing.T) {
	client := exittest.NewKey(t)
	exit := exittest.Start(t, client.Public, exittest.Options{Obfuscation: awg})
	r := start(t, &config.Config{Transports: []config.Transport{transport(client, exit, config.AmneziaWG, awg)}})
	waitStatus(t, r.eng, 10*time.Second, engine.On)
	c, rep := connect(t, r, exittest.EchoName, 7)
	if rep != 0 {
		t.Fatalf("reply %d", rep)
	}
	echo(t, c, "noise")
	c.Close()
}

// AmneziaWG with no obfuscation is WireGuard on the wire: an AmneziaWG
// client reaches a plain WireGuard exit.
func TestAmneziaWGPlainReachesWireGuardExit(t *testing.T) {
	client := exittest.NewKey(t)
	exit := exittest.Start(t, client.Public, exittest.Options{})
	r := start(t, &config.Config{Transports: []config.Transport{transport(client, exit, config.AmneziaWG, nil)}})
	waitStatus(t, r.eng, 10*time.Second, engine.On)
}

// Auto: WireGuard first; where it does not get through, AmneziaWG.
func TestAutoFallsBackToAmneziaWG(t *testing.T) {
	client := exittest.NewKey(t)
	exit := exittest.Start(t, client.Public, exittest.Options{Obfuscation: awg})
	r := start(t, &config.Config{
		HandshakeTimeoutMs: 1500,
		Transports: []config.Transport{
			transport(client, exit, config.WireGuard, nil),
			transport(client, exit, config.AmneziaWG, awg),
		},
	})
	waitStatus(t, r.eng, 15*time.Second, engine.On)
	if s := r.eng.Snapshot(); s.ActiveProtocol != config.AmneziaWG || s.Transport != 1 {
		t.Fatalf("auto picked %s (#%d), want amneziawg (#1)", s.ActiveProtocol, s.Transport)
	}
}

// A tunnel that never comes up: down, and nothing goes anywhere.
func TestNeverUpFailsClosed(t *testing.T) {
	client := exittest.NewKey(t)
	exit := exittest.Start(t, client.Public, exittest.Options{Obfuscation: awg})
	// Plain WireGuard against an obfuscating exit: no handshake.
	r := start(t, &config.Config{HandshakeTimeoutMs: 800, Transports: []config.Transport{transport(client, exit, config.WireGuard, nil)}})
	waitStatus(t, r.eng, 10*time.Second, engine.Down)
	if _, rep := connect(t, r, exittest.EchoName, 7); rep != 3 {
		t.Fatalf("reply %d, want 3 (network unreachable)", rep)
	}
	if exit.TCP.N() != 0 {
		t.Fatal("exit saw a connection")
	}
}

// The exit dies while on: down within a few probes, dials fail at once, and
// when it is back the tunnel comes back by itself.
func TestExitDiesThenReturns(t *testing.T) {
	client := exittest.NewKey(t)
	exit := exittest.Start(t, client.Public, exittest.Options{})
	r := start(t, &config.Config{HandshakeTimeoutMs: 1500, Transports: []config.Transport{transport(client, exit, config.WireGuard, nil)}})
	waitStatus(t, r.eng, 10*time.Second, engine.On)

	exit.Close()
	waitStatus(t, r.eng, 10*time.Second, engine.Down)
	t0 := time.Now()
	if _, rep := connect(t, r, exittest.ExitIP.String(), 7); rep != 3 {
		t.Fatalf("reply %d, want 3 (network unreachable)", rep)
	}
	if d := time.Since(t0); d > time.Second {
		t.Fatalf("a dial while down took %s; it must fail at once", d)
	}

	key := exit.Key
	exittest.Start(t, client.Public, exittest.Options{Key: &key, Port: exit.Port})
	waitStatus(t, r.eng, 20*time.Second, engine.On)
	c, rep := connect(t, r, exittest.ExitIP.String(), 7)
	if rep != 0 {
		t.Fatalf("after return: reply %d", rep)
	}
	echo(t, c, "back")
	c.Close()
}

// Loopback and link-local never go through the exit — neither by address
// nor by a name that resolves to one — and never reach this machine either.
func TestBlockedDestinations(t *testing.T) {
	client := exittest.NewKey(t)
	exit := exittest.Start(t, client.Public, exittest.Options{})
	r := start(t, &config.Config{Transports: []config.Transport{transport(client, exit, config.WireGuard, nil)}})
	waitStatus(t, r.eng, 10*time.Second, engine.On)

	local, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	reached := make(chan struct{}, 1)
	go func() {
		if c, err := local.Accept(); err == nil {
			c.Close()
			reached <- struct{}{}
		}
	}()
	port := local.Addr().(*net.TCPAddr).Port
	for _, host := range []string{"127.0.0.1", exittest.BlockedName, "169.254.169.254", "0.0.0.0"} {
		if _, rep := connect(t, r, host, port); rep != 2 {
			t.Fatalf("%s: reply %d, want 2 (not allowed)", host, rep)
		}
	}
	select {
	case <-reached:
		t.Fatal("a SOCKS request reached this machine's loopback")
	case <-time.After(200 * time.Millisecond):
	}
}

func TestWrongTokenRefused(t *testing.T) {
	client := exittest.NewKey(t)
	exit := exittest.Start(t, client.Public, exittest.Options{})
	r := start(t, &config.Config{Transports: []config.Transport{transport(client, exit, config.WireGuard, nil)}})
	c, err := net.Dial("tcp", r.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	if err := socksAuth(t, c, "not-the-token"); err == nil {
		t.Fatal("wrong token accepted")
	}

	// No-auth method is refused outright.
	c2, _ := net.Dial("tcp", r.addr)
	defer c2.Close()
	c2.SetDeadline(time.Now().Add(5 * time.Second))
	c2.Write([]byte{5, 1, 0})
	var m [2]byte
	io.ReadFull(c2, m[:])
	if m[1] != 0xff {
		t.Fatalf("no-auth got method %d", m[1])
	}
}

func TestUDPAssociate(t *testing.T) {
	client := exittest.NewKey(t)
	exit := exittest.Start(t, client.Public, exittest.Options{})
	r := start(t, &config.Config{Transports: []config.Transport{transport(client, exit, config.WireGuard, nil)}})
	waitStatus(t, r.eng, 10*time.Second, engine.On)

	ctl, err := net.Dial("tcp", r.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer ctl.Close()
	ctl.SetDeadline(time.Now().Add(10 * time.Second))
	if err := socksAuth(t, ctl, token); err != nil {
		t.Fatal(err)
	}
	rep, relay := request(t, ctl, 3, "0.0.0.0", 0)
	if rep != 0 {
		t.Fatalf("associate reply %d", rep)
	}
	uc, err := net.DialUDP("udp", nil, net.UDPAddrFromAddrPort(relay))
	if err != nil {
		t.Fatal(err)
	}
	defer uc.Close()
	uc.SetDeadline(time.Now().Add(10 * time.Second))

	for _, host := range []string{exittest.ExitIP.String(), exittest.EchoName} {
		payload := []byte("udp via " + host)
		pkt := append([]byte{0, 0, 0}, socksAddr(host, 7)...)
		if _, err := uc.Write(append(pkt, payload...)); err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, 2048)
		n, err := uc.Read(buf)
		if err != nil {
			t.Fatalf("%s: %v", host, err)
		}
		// Reply header: RSV RSV FRAG ATYP(1) IPv4 PORT
		if n < 10 || buf[3] != 1 {
			t.Fatalf("%s: short reply %x", host, buf[:n])
		}
		from := netip.AddrPortFrom(netip.AddrFrom4([4]byte(buf[4:8])), binary.BigEndian.Uint16(buf[8:10]))
		if from != netip.AddrPortFrom(exittest.ExitIP, 7) {
			t.Fatalf("%s: reply from %s", host, from)
		}
		if !bytes.Equal(buf[10:n], payload) {
			t.Fatalf("%s: got %q", host, buf[10:n])
		}
	}
}

// DNS through SOCKS UDP: a resolver run by the client (as Docker or a
// browser would) talks to the exit's DNS through the tunnel.
func TestDNSOverUDPAssociate(t *testing.T) {
	client := exittest.NewKey(t)
	exit := exittest.Start(t, client.Public, exittest.Options{})
	r := start(t, &config.Config{Transports: []config.Transport{transport(client, exit, config.WireGuard, nil)}})
	waitStatus(t, r.eng, 10*time.Second, engine.On)
	ctl, _ := net.Dial("tcp", r.addr)
	defer ctl.Close()
	ctl.SetDeadline(time.Now().Add(10 * time.Second))
	if err := socksAuth(t, ctl, token); err != nil {
		t.Fatal(err)
	}
	_, relay := request(t, ctl, 3, "0.0.0.0", 0)
	uc, _ := net.DialUDP("udp", nil, net.UDPAddrFromAddrPort(relay))
	defer uc.Close()
	uc.SetDeadline(time.Now().Add(10 * time.Second))
	q := []byte{0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0}
	for _, label := range []string{"echo", "test"} {
		q = append(q, byte(len(label)))
		q = append(q, label...)
	}
	q = append(q, 0, 0, 1, 0, 1)
	pkt := append([]byte{0, 0, 0}, socksAddr(exittest.ExitIP.String(), 53)...)
	uc.Write(append(pkt, q...))
	buf := make([]byte, 2048)
	n, err := uc.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	resp := buf[10:n]
	if len(resp) < 4 || resp[0] != 0x12 || resp[1] != 0x34 {
		t.Fatalf("dns reply %x", resp)
	}
	ip := exittest.ExitIP.As4()
	if !bytes.Contains(resp, ip[:]) {
		t.Fatalf("answer lacks %s: %x", exittest.ExitIP, resp)
	}
}

func TestStopMeansOff(t *testing.T) {
	client := exittest.NewKey(t)
	exit := exittest.Start(t, client.Public, exittest.Options{})
	r := start(t, &config.Config{Transports: []config.Transport{transport(client, exit, config.WireGuard, nil)}})
	waitStatus(t, r.eng, 10*time.Second, engine.On)
	r.eng.Stop()
	if s := r.eng.Snapshot(); s.Status != engine.Off || s.Configured {
		t.Fatalf("after stop: %+v", s)
	}
	if _, rep := connect(t, r, exittest.ExitIP.String(), 7); rep != 3 {
		t.Fatalf("reply %d while off, want 3", rep)
	}
}
