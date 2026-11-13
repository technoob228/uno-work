// Package tunnel brings up one WireGuard / AmneziaWG transport entirely in
// user space: amneziawg-go encrypts, gVisor's netstack is the network stack
// behind it. No TUN device, no routes, no root. Everything dialed through a
// Tunnel leaves only as encrypted UDP to the exit's endpoint.
package tunnel

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/amnezia-vpn/amneziawg-go/v3/conn"
	"github.com/amnezia-vpn/amneziawg-go/v3/device"
	"github.com/amnezia-vpn/amneziawg-go/v3/tun/netstack"

	"github.com/technoob228/uno-work/native/uno-net/internal/config"
)

// DefaultDNS is used inside the tunnel when the transport names none.
var DefaultDNS = []netip.Addr{netip.MustParseAddr("1.1.1.1"), netip.MustParseAddr("8.8.8.8")}

// Tunnel is one live transport.
type Tunnel struct {
	Protocol config.Protocol
	Endpoint netip.AddrPort

	dev   *device.Device
	net   *netstack.Net
	local []netip.Addr
	dns   []netip.Addr

	closeOnce sync.Once
}

// Stats is what the device reports about its peer.
type Stats struct {
	LastHandshake time.Time
	RxBytes       uint64
	TxBytes       uint64
}

// Resolver resolves the exit's endpoint name. It is the only lookup made
// outside the tunnel; tests swap it.
var Resolver = net.DefaultResolver

// Up builds the device and starts it. The handshake happens asynchronously:
// watch Stats().LastHandshake.
func Up(ctx context.Context, t config.Transport, log *slog.Logger) (*Tunnel, error) {
	endpoint, err := resolveEndpoint(ctx, t.Peer.Endpoint)
	if err != nil {
		return nil, fmt.Errorf("endpoint: %w", err)
	}
	local, err := t.LocalAddrs()
	if err != nil {
		return nil, err
	}
	dns, err := t.DNSAddrs()
	if err != nil {
		return nil, err
	}
	if len(dns) == 0 {
		dns = DefaultDNS
	}
	tunDev, tnet, err := netstack.CreateNetTUN(local, dns, t.EffectiveMTU())
	if err != nil {
		return nil, fmt.Errorf("netstack: %w", err)
	}
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), deviceLogger(log))
	uapi, err := UAPI(t, endpoint)
	if err != nil {
		dev.Close()
		return nil, err
	}
	if err := dev.IpcSet(uapi); err != nil {
		dev.Close()
		return nil, fmt.Errorf("device config: %w", err)
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, fmt.Errorf("device up: %w", err)
	}
	return &Tunnel{Protocol: t.Protocol, Endpoint: endpoint, dev: dev, net: tnet, local: local, dns: dns}, nil
}

// UAPI renders the device configuration. Values were validated by config, so
// nothing here can add a line of its own.
func UAPI(t config.Transport, endpoint netip.AddrPort) (string, error) {
	var b strings.Builder
	priv, err := config.KeyHex(t.PrivateKey)
	if err != nil {
		return "", err
	}
	pub, err := config.KeyHex(t.Peer.PublicKey)
	if err != nil {
		return "", err
	}
	fmt.Fprintf(&b, "private_key=%s\n", priv)
	if t.Protocol == config.AmneziaWG {
		// Fixed order keeps the output stable for tests and logs.
		for _, k := range []string{"jc", "jmin", "jmax", "s1", "s2", "s3", "s4", "h1", "h2", "h3", "h4", "i1", "i2", "i3", "i4", "i5"} {
			if v, ok := t.Obfuscation[k]; ok {
				fmt.Fprintf(&b, "%s=%s\n", k, v)
			}
		}
	}
	fmt.Fprintf(&b, "public_key=%s\n", pub)
	if t.Peer.PresharedKey != "" {
		psk, err := config.KeyHex(t.Peer.PresharedKey)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(&b, "preshared_key=%s\n", psk)
	}
	fmt.Fprintf(&b, "endpoint=%s\n", endpoint.String())
	fmt.Fprintf(&b, "persistent_keepalive_interval=%d\n", t.Keepalive())
	prefixes, err := t.AllowedPrefixes()
	if err != nil {
		return "", err
	}
	for _, p := range prefixes {
		fmt.Fprintf(&b, "allowed_ip=%s\n", p.String())
	}
	return b.String(), nil
}

// Close tears the device down; every connection through it ends.
func (tu *Tunnel) Close() {
	tu.closeOnce.Do(func() { tu.dev.Close() })
}

// Stats reads the peer's counters from the device.
func (tu *Tunnel) Stats() Stats {
	var s Stats
	raw, err := tu.dev.IpcGet()
	if err != nil {
		return s
	}
	var sec, nsec int64
	for _, line := range strings.Split(raw, "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch k {
		case "last_handshake_time_sec":
			sec, _ = strconv.ParseInt(v, 10, 64)
		case "last_handshake_time_nsec":
			nsec, _ = strconv.ParseInt(v, 10, 64)
		case "rx_bytes":
			s.RxBytes, _ = strconv.ParseUint(v, 10, 64)
		case "tx_bytes":
			s.TxBytes, _ = strconv.ParseUint(v, 10, 64)
		}
	}
	if sec > 0 || nsec > 0 {
		s.LastHandshake = time.Unix(sec, nsec)
	}
	return s
}

// DialContext dials TCP or UDP through the tunnel; names resolve through the
// tunnel's DNS.
func (tu *Tunnel) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	return tu.net.DialContext(ctx, network, address)
}

// LookupHost resolves through the tunnel's DNS.
func (tu *Tunnel) LookupHost(ctx context.Context, host string) ([]string, error) {
	return tu.net.LookupContextHost(ctx, host)
}

// ListenUDP opens an unconnected UDP socket inside the tunnel, for SOCKS5
// UDP ASSOCIATE (one socket, many destinations).
func (tu *Tunnel) ListenUDP(v6 bool) (net.PacketConn, error) {
	for _, a := range tu.local {
		if a.Is6() == v6 {
			return tu.net.ListenUDPAddrPort(netip.AddrPortFrom(a, 0))
		}
	}
	return nil, errors.New("tunnel has no address of that family")
}

// Ping sends one ICMP echo through the tunnel and waits for the reply.
func (tu *Tunnel) Ping(ctx context.Context, target netip.Addr) (time.Duration, error) {
	var laddr netip.Addr
	for _, a := range tu.local {
		if a.Is4() == target.Is4() {
			laddr = a
			break
		}
	}
	if !laddr.IsValid() {
		return 0, errors.New("tunnel has no address of that family")
	}
	pc, err := tu.net.DialPingAddr(laddr, target)
	if err != nil {
		return 0, err
	}
	defer pc.Close()
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(5 * time.Second)
	}
	_ = pc.SetDeadline(deadline)

	id := uint16(time.Now().UnixNano())
	seq := uint16(1)
	msg := echoRequest(target.Is6(), id, seq)
	start := time.Now()
	if _, err := pc.Write(msg); err != nil {
		return 0, err
	}
	buf := make([]byte, 1500)
	for {
		n, err := pc.Read(buf)
		if err != nil {
			return 0, err
		}
		if isEchoReply(buf[:n], target.Is6(), seq) {
			return time.Since(start), nil
		}
	}
}

// DNS reports the servers used inside the tunnel.
func (tu *Tunnel) DNS() []netip.Addr { return tu.dns }

func echoRequest(v6 bool, id, seq uint16) []byte {
	msg := make([]byte, 8+16)
	msg[0] = 8 // echo request
	if v6 {
		msg[0] = 128
	}
	binary.BigEndian.PutUint16(msg[4:], id)
	binary.BigEndian.PutUint16(msg[6:], seq)
	copy(msg[8:], "uno-net-probe...")
	if !v6 { // the stack fills the ICMPv6 checksum itself
		binary.BigEndian.PutUint16(msg[2:], checksum(msg))
	}
	return msg
}

func isEchoReply(b []byte, v6 bool, seq uint16) bool {
	if len(b) < 8 {
		return false
	}
	want := byte(0)
	if v6 {
		want = 129
	}
	// gVisor rewrites the identifier to the endpoint's port; match on type
	// and sequence.
	return b[0] == want && binary.BigEndian.Uint16(b[6:]) == seq
}

func checksum(b []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(b); i += 2 {
		sum += uint32(b[i])<<8 | uint32(b[i+1])
	}
	if len(b)%2 == 1 {
		sum += uint32(b[len(b)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = sum&0xffff + sum>>16
	}
	return ^uint16(sum)
}

func resolveEndpoint(ctx context.Context, ep string) (netip.AddrPort, error) {
	if ap, err := netip.ParseAddrPort(ep); err == nil {
		return ap, nil
	}
	host, port, err := net.SplitHostPort(ep)
	if err != nil {
		return netip.AddrPort{}, err
	}
	p, err := strconv.ParseUint(port, 10, 16)
	if err != nil {
		return netip.AddrPort{}, err
	}
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	addrs, err := Resolver.LookupNetIP(rctx, "ip", host)
	if err != nil {
		return netip.AddrPort{}, err
	}
	if len(addrs) == 0 {
		return netip.AddrPort{}, fmt.Errorf("%s: no address", host)
	}
	// Prefer IPv4: home and office networks still drop IPv6 UDP more often.
	best := addrs[0]
	for _, a := range addrs {
		if a.Unmap().Is4() {
			best = a.Unmap()
			break
		}
	}
	return netip.AddrPortFrom(best, uint16(p)), nil
}

func deviceLogger(log *slog.Logger) *device.Logger {
	if log == nil {
		return device.NewLogger(device.LogLevelSilent, "")
	}
	return &device.Logger{
		Verbosef: func(format string, args ...any) { log.Debug(fmt.Sprintf(format, args...)) },
		Errorf:   func(format string, args ...any) { log.Warn(fmt.Sprintf(format, args...)) },
	}
}
