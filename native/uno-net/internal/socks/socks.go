// Package socks is uno-net's way in: a SOCKS5 server on loopback (RFC 1928)
// with CONNECT and UDP ASSOCIATE, open only with the token (RFC 1929
// username/password; the password is the token, the username is a free label
// such as the app or process the flow came from). Every destination is
// reached through the Dialer; there is no direct path out of this package.
package socks

import (
	"context"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Dialer is the tunnel as SOCKS sees it. When the tunnel is not up its
// methods fail (ErrDown) — the server never falls back to a direct
// connection.
type Dialer interface {
	DialContext(ctx context.Context, network, address string) (net.Conn, error)
	ListenUDP(ctx context.Context, v6 bool) (net.PacketConn, error)
	LookupHost(ctx context.Context, host string) ([]string, error)
}

// ErrDown: the tunnel is not up; nothing goes out.
var ErrDown = errors.New("network is down")

// ErrBlocked: the destination may not be reached through the tunnel.
var ErrBlocked = errors.New("destination not allowed")

const (
	ver5 = 0x05

	methodNone     = 0x00
	methodUserPass = 0x02
	methodNoAccept = 0xff

	cmdConnect   = 0x01
	cmdBind      = 0x02
	cmdAssociate = 0x03

	atypIPv4   = 0x01
	atypDomain = 0x03
	atypIPv6   = 0x04

	repOK              = 0x00
	repFailure         = 0x01
	repNotAllowed      = 0x02
	repNetUnreachable  = 0x03
	repHostUnreachable = 0x04
	repRefused         = 0x05
	repTTLExpired      = 0x06
	repCmdUnsupported  = 0x07
)

// Server accepts SOCKS5 clients.
type Server struct {
	Dialer Dialer
	Token  string
	Log    *slog.Logger
	// DialTimeout bounds one CONNECT (default 20s).
	DialTimeout time.Duration
	// MaxConns caps concurrent clients (default 4096).
	MaxConns int

	active   atomic.Int64
	total    atomic.Uint64
	rejected atomic.Uint64

	mu  sync.Mutex
	lns []net.Listener
}

// Counters for status.
type Counters struct {
	Active   int64  `json:"active"`
	Total    uint64 `json:"total"`
	Rejected uint64 `json:"rejected"`
}

func (s *Server) Counters() Counters {
	return Counters{Active: s.active.Load(), Total: s.total.Load(), Rejected: s.rejected.Load()}
}

// Serve accepts until the listener closes.
func (s *Server) Serve(ln net.Listener) error {
	if s.Token == "" {
		return errors.New("socks: empty token")
	}
	s.mu.Lock()
	s.lns = append(s.lns, ln)
	s.mu.Unlock()
	max := s.MaxConns
	if max <= 0 {
		max = 4096
	}
	sem := make(chan struct{}, max)
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			return err
		}
		select {
		case sem <- struct{}{}:
		default:
			s.rejected.Add(1)
			c.Close()
			continue
		}
		go func() {
			defer func() { <-sem }()
			s.handle(c)
		}()
	}
}

// Close stops all listeners.
func (s *Server) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, ln := range s.lns {
		ln.Close()
	}
	s.lns = nil
}

func (s *Server) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.New(slog.DiscardHandler)
}

func (s *Server) handle(c net.Conn) {
	s.active.Add(1)
	s.total.Add(1)
	defer s.active.Add(-1)
	defer c.Close()

	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	label, err := s.negotiate(c)
	if err != nil {
		s.rejected.Add(1)
		s.log().Debug("socks: refused", "err", err)
		return
	}
	cmd, dst, err := readRequest(c)
	if err != nil {
		if errors.Is(err, errAddrType) {
			writeReply(c, repCmdUnsupported+1, nil) // 0x08 address type not supported
		}
		return
	}
	_ = c.SetDeadline(time.Time{})

	switch cmd {
	case cmdConnect:
		s.connect(c, dst, label)
	case cmdAssociate:
		s.associate(c, dst, label)
	default:
		writeReply(c, repCmdUnsupported, nil)
	}
}

// negotiate checks the method and the token; returns the client's label.
func (s *Server) negotiate(c net.Conn) (string, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(c, hdr[:]); err != nil {
		return "", err
	}
	if hdr[0] != ver5 {
		return "", fmt.Errorf("version %d", hdr[0])
	}
	methods := make([]byte, hdr[1])
	if _, err := io.ReadFull(c, methods); err != nil {
		return "", err
	}
	ok := false
	for _, m := range methods {
		if m == methodUserPass {
			ok = true
		}
	}
	if !ok {
		c.Write([]byte{ver5, methodNoAccept})
		return "", errors.New("no username/password method")
	}
	if _, err := c.Write([]byte{ver5, methodUserPass}); err != nil {
		return "", err
	}
	// RFC 1929
	var v [2]byte
	if _, err := io.ReadFull(c, v[:]); err != nil {
		return "", err
	}
	if v[0] != 0x01 {
		return "", errors.New("bad auth version")
	}
	user := make([]byte, v[1])
	if _, err := io.ReadFull(c, user); err != nil {
		return "", err
	}
	var pl [1]byte
	if _, err := io.ReadFull(c, pl[:]); err != nil {
		return "", err
	}
	pass := make([]byte, pl[0])
	if _, err := io.ReadFull(c, pass); err != nil {
		return "", err
	}
	if subtle.ConstantTimeCompare(pass, []byte(s.Token)) != 1 {
		c.Write([]byte{0x01, 0x01})
		return "", errors.New("bad token")
	}
	if _, err := c.Write([]byte{0x01, 0x00}); err != nil {
		return "", err
	}
	return string(user), nil
}

// Addr is a SOCKS destination: an IP or a name, and a port.
type Addr struct {
	IP   netip.Addr
	Name string
	Port uint16
}

func (a Addr) String() string {
	if a.Name != "" {
		return net.JoinHostPort(a.Name, strconv.Itoa(int(a.Port)))
	}
	return netip.AddrPortFrom(a.IP, a.Port).String()
}

var errAddrType = errors.New("address type not supported")

func readRequest(r io.Reader) (byte, Addr, error) {
	var hdr [3]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, Addr{}, err
	}
	if hdr[0] != ver5 {
		return 0, Addr{}, errors.New("bad request version")
	}
	a, err := readAddr(r)
	return hdr[1], a, err
}

func readAddr(r io.Reader) (Addr, error) {
	var t [1]byte
	if _, err := io.ReadFull(r, t[:]); err != nil {
		return Addr{}, err
	}
	var a Addr
	switch t[0] {
	case atypIPv4:
		var b [4]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return a, err
		}
		a.IP = netip.AddrFrom4(b)
	case atypIPv6:
		var b [16]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return a, err
		}
		a.IP = netip.AddrFrom16(b)
	case atypDomain:
		var l [1]byte
		if _, err := io.ReadFull(r, l[:]); err != nil {
			return a, err
		}
		b := make([]byte, l[0])
		if _, err := io.ReadFull(r, b); err != nil {
			return a, err
		}
		a.Name = string(b)
		if ip, err := netip.ParseAddr(a.Name); err == nil {
			a.IP, a.Name = ip, ""
		}
	default:
		return a, errAddrType
	}
	var p [2]byte
	if _, err := io.ReadFull(r, p[:]); err != nil {
		return a, err
	}
	a.Port = binary.BigEndian.Uint16(p[:])
	return a, nil
}

func appendAddr(b []byte, ap netip.AddrPort) []byte {
	ip := ap.Addr().Unmap()
	if ip.Is4() {
		b = append(b, atypIPv4)
		v := ip.As4()
		b = append(b, v[:]...)
	} else {
		b = append(b, atypIPv6)
		v := ip.As16()
		b = append(b, v[:]...)
	}
	return binary.BigEndian.AppendUint16(b, ap.Port())
}

func writeReply(w io.Writer, rep byte, bnd *netip.AddrPort) {
	b := []byte{ver5, rep, 0x00}
	if bnd == nil {
		b = appendAddr(b, netip.AddrPortFrom(netip.IPv4Unspecified(), 0))
	} else {
		b = appendAddr(b, *bnd)
	}
	w.Write(b)
}

// Blocked: addresses that are never reached through an exit — loopback,
// unspecified, link-local (cloud metadata lives at 169.254.169.254),
// multicast. They would either loop or reach something on the exit's own
// machine that is not the internet.
func Blocked(ip netip.Addr) bool {
	ip = ip.Unmap()
	return !ip.IsValid() || ip.IsLoopback() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsInterfaceLocalMulticast()
}

// resolve turns a destination into an IP, names through the tunnel's DNS.
func (s *Server) resolve(ctx context.Context, a Addr) (netip.Addr, error) {
	if a.Name == "" {
		if Blocked(a.IP) {
			return netip.Addr{}, ErrBlocked
		}
		return a.IP.Unmap(), nil
	}
	addrs, err := s.Dialer.LookupHost(ctx, a.Name)
	if err != nil {
		return netip.Addr{}, err
	}
	var v6 netip.Addr
	for _, h := range addrs {
		ip, err := netip.ParseAddr(h)
		if err != nil || Blocked(ip) {
			continue
		}
		if ip.Unmap().Is4() {
			return ip.Unmap(), nil
		}
		if !v6.IsValid() {
			v6 = ip
		}
	}
	if v6.IsValid() {
		return v6, nil
	}
	if len(addrs) > 0 {
		return netip.Addr{}, ErrBlocked
	}
	return netip.Addr{}, fmt.Errorf("%s: no address", a.Name)
}

func replyFor(err error) byte {
	switch {
	case errors.Is(err, ErrDown):
		return repNetUnreachable
	case errors.Is(err, ErrBlocked):
		return repNotAllowed
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, os.ErrDeadlineExceeded):
		return repTTLExpired
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return repTTLExpired
	}
	msg := err.Error()
	if containsAny(msg, "connection refused", "connection was refused") {
		return repRefused
	}
	if containsAny(msg, "no address", "no such host", "unreachable") {
		return repHostUnreachable
	}
	return repFailure
}

func (s *Server) connect(c net.Conn, dst Addr, label string) {
	timeout := s.DialTimeout
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	ip, err := s.resolve(ctx, dst)
	if err != nil {
		writeReply(c, replyFor(err), nil)
		s.log().Debug("socks: resolve failed", "dst", dst.String(), "who", label, "err", err)
		return
	}
	up, err := s.Dialer.DialContext(ctx, "tcp", netip.AddrPortFrom(ip, dst.Port).String())
	if err != nil {
		writeReply(c, replyFor(err), nil)
		s.log().Debug("socks: connect failed", "dst", dst.String(), "who", label, "err", err)
		return
	}
	defer up.Close()
	bnd := addrPortOf(up.LocalAddr())
	writeReply(c, repOK, &bnd)
	splice(c, up)
}

func addrPortOf(a net.Addr) netip.AddrPort {
	switch v := a.(type) {
	case *net.TCPAddr:
		return v.AddrPort()
	case *net.UDPAddr:
		return v.AddrPort()
	}
	if ap, err := netip.ParseAddrPort(a.String()); err == nil {
		return ap
	}
	return netip.AddrPortFrom(netip.IPv4Unspecified(), 0)
}

type closeWriter interface{ CloseWrite() error }

func splice(a, b net.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)
	pipe := func(dst, src net.Conn) {
		defer wg.Done()
		io.Copy(dst, src)
		if cw, ok := dst.(closeWriter); ok {
			cw.CloseWrite()
		} else {
			dst.Close()
		}
	}
	go pipe(a, b)
	go pipe(b, a)
	wg.Wait()
}

// associate runs one UDP association for as long as its TCP connection lives.
func (s *Server) associate(c net.Conn, req Addr, label string) {
	clientIP := addrPortOf(c.RemoteAddr()).Addr().Unmap()
	localIP := addrPortOf(c.LocalAddr()).Addr().Unmap()
	relay, err := net.ListenUDP("udp", net.UDPAddrFromAddrPort(netip.AddrPortFrom(localIP, 0)))
	if err != nil {
		writeReply(c, repFailure, nil)
		return
	}
	defer relay.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	a := &association{s: s, relay: relay, clientIP: clientIP, ctx: ctx, label: label}
	// RFC 1928: a nonzero address in the request names where the client
	// sends from.
	if req.Port != 0 && req.IP.IsValid() && !req.IP.IsUnspecified() {
		a.client = netip.AddrPortFrom(req.IP.Unmap(), req.Port)
	}
	defer a.close()

	bnd := relay.LocalAddr().(*net.UDPAddr).AddrPort()
	writeReply(c, repOK, &bnd)

	go a.fromClient()
	// The association ends when the client closes its TCP connection.
	io.Copy(io.Discard, c)
}

type association struct {
	s        *Server
	relay    *net.UDPConn
	clientIP netip.Addr
	ctx      context.Context
	label    string

	mu     sync.Mutex
	client netip.AddrPort
	pc4    net.PacketConn
	pc6    net.PacketConn
	names  map[string]netip.Addr
}

func (a *association) close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.pc4 != nil {
		a.pc4.Close()
	}
	if a.pc6 != nil {
		a.pc6.Close()
	}
}

func (a *association) packetConn(v6 bool) (net.PacketConn, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	slot := &a.pc4
	if v6 {
		slot = &a.pc6
	}
	if *slot != nil {
		return *slot, nil
	}
	pc, err := a.s.Dialer.ListenUDP(a.ctx, v6)
	if err != nil {
		return nil, err
	}
	*slot = pc
	go a.fromTunnel(pc)
	return pc, nil
}

func (a *association) fromClient() {
	buf := make([]byte, 64*1024)
	for {
		n, from, err := a.relay.ReadFromUDPAddrPort(buf)
		if err != nil {
			return
		}
		from = netip.AddrPortFrom(from.Addr().Unmap(), from.Port())
		// Only the client that opened the association may use it.
		if from.Addr() != a.clientIP {
			continue
		}
		a.mu.Lock()
		if !a.client.IsValid() {
			a.client = from
		}
		pinned := a.client
		a.mu.Unlock()
		if from != pinned {
			continue
		}
		dst, payload, ok := parseUDP(buf[:n])
		if !ok {
			continue
		}
		ip, err := a.resolveCached(dst)
		if err != nil {
			continue
		}
		pc, err := a.packetConn(ip.Is6())
		if err != nil {
			continue // tunnel down: the datagram is dropped, never sent around it
		}
		pc.WriteTo(payload, net.UDPAddrFromAddrPort(netip.AddrPortFrom(ip, dst.Port)))
	}
}

func (a *association) resolveCached(dst Addr) (netip.Addr, error) {
	if dst.Name == "" {
		return a.s.resolve(a.ctx, dst)
	}
	a.mu.Lock()
	if ip, ok := a.names[dst.Name]; ok {
		a.mu.Unlock()
		return ip, nil
	}
	a.mu.Unlock()
	ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
	defer cancel()
	ip, err := a.s.resolve(ctx, dst)
	if err != nil {
		return ip, err
	}
	a.mu.Lock()
	if a.names == nil {
		a.names = map[string]netip.Addr{}
	}
	if len(a.names) < 1024 {
		a.names[dst.Name] = ip
	}
	a.mu.Unlock()
	return ip, nil
}

func (a *association) fromTunnel(pc net.PacketConn) {
	buf := make([]byte, 64*1024)
	for {
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		a.mu.Lock()
		client := a.client
		a.mu.Unlock()
		if !client.IsValid() {
			continue
		}
		pkt := appendAddr([]byte{0, 0, 0}, addrPortOf(from))
		pkt = append(pkt, buf[:n]...)
		a.relay.WriteToUDPAddrPort(pkt, client)
	}
}

// parseUDP reads the SOCKS5 UDP header. Fragments are not supported and
// dropped, as RFC 1928 allows.
func parseUDP(b []byte) (Addr, []byte, bool) {
	if len(b) < 4 || b[0] != 0 || b[1] != 0 || b[2] != 0 {
		return Addr{}, nil, false
	}
	r := &sliceReader{b: b[3:]}
	a, err := readAddr(r)
	if err != nil {
		return Addr{}, nil, false
	}
	return a, r.b, true
}

type sliceReader struct{ b []byte }

func (r *sliceReader) Read(p []byte) (int, error) {
	if len(r.b) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.b)
	r.b = r.b[n:]
	return n, nil
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}
