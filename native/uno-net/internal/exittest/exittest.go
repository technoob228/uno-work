// Package exittest runs a WireGuard / AmneziaWG exit inside the test process
// (amneziawg-go + netstack on loopback UDP) with an echo service on TCP and
// UDP port 7 and a DNS server answering "echo.test", all at ExitIP.
package exittest

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/amnezia-vpn/amneziawg-go/v3/conn"
	"github.com/amnezia-vpn/amneziawg-go/v3/device"
	"github.com/amnezia-vpn/amneziawg-go/v3/tun/netstack"
	"golang.org/x/net/dns/dnsmessage"
)

var (
	ExitIP   = netip.MustParseAddr("10.66.0.1")
	ClientIP = netip.MustParseAddr("10.66.0.2")
	// EchoName resolves to ExitIP through the exit's DNS.
	EchoName = "echo.test"
	// BlockedName resolves to loopback: uno-net must refuse it.
	BlockedName = "loop.test"
)

// Key is a base64 key pair.
type Key struct{ Private, Public string }

func NewKey(t testing.TB) Key {
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return Key{
		Private: base64.StdEncoding.EncodeToString(k.Bytes()),
		Public:  base64.StdEncoding.EncodeToString(k.PublicKey().Bytes()),
	}
}

// Exit is a running exit.
type Exit struct {
	Key  Key
	Port int

	dev  *device.Device
	once sync.Once
	TCP  *Counter
}

// Counter counts accepted TCP connections.
type Counter struct {
	mu sync.Mutex
	n  int
}

func (c *Counter) Inc() { c.mu.Lock(); c.n++; c.mu.Unlock() }
func (c *Counter) N() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

// Endpoint is where clients send UDP.
func (e *Exit) Endpoint() string { return "127.0.0.1:" + strconv.Itoa(e.Port) }

// Close stops the exit: the tunnel goes silent.
func (e *Exit) Close() { e.once.Do(func() { e.dev.Close() }) }

// Options of an exit.
type Options struct {
	Key         *Key // nil: a fresh key
	Port        int  // 0: any free port
	Obfuscation map[string]string
}

// Start runs an exit that accepts clientPub at ClientIP.
func Start(t testing.TB, clientPub string, opt Options) *Exit {
	t.Helper()
	key := NewKey(t)
	if opt.Key != nil {
		key = *opt.Key
	}
	tunDev, tnet, err := netstack.CreateNetTUN([]netip.Addr{ExitIP}, nil, 1280)
	if err != nil {
		t.Fatal(err)
	}
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, ""))
	var b strings.Builder
	fmt.Fprintf(&b, "private_key=%s\n", hexKey(t, key.Private))
	fmt.Fprintf(&b, "listen_port=%d\n", opt.Port)
	for _, k := range []string{"jc", "jmin", "jmax", "s1", "s2", "s3", "s4", "h1", "h2", "h3", "h4", "i1", "i2", "i3", "i4", "i5"} {
		if v, ok := opt.Obfuscation[k]; ok {
			fmt.Fprintf(&b, "%s=%s\n", k, v)
		}
	}
	fmt.Fprintf(&b, "public_key=%s\nallowed_ip=%s/32\n", hexKey(t, clientPub), ClientIP)
	if err := dev.IpcSet(b.String()); err != nil {
		t.Fatal(err)
	}
	if err := dev.Up(); err != nil {
		t.Fatal(err)
	}
	port := opt.Port
	if port == 0 {
		raw, _ := dev.IpcGet()
		for _, line := range strings.Split(raw, "\n") {
			if v, ok := strings.CutPrefix(line, "listen_port="); ok {
				port, _ = strconv.Atoi(v)
			}
		}
	}
	e := &Exit{Key: key, Port: port, dev: dev, TCP: &Counter{}}
	t.Cleanup(e.Close)

	tl, err := tnet.ListenTCPAddrPort(netip.AddrPortFrom(ExitIP, 7))
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			c, err := tl.Accept()
			if err != nil {
				return
			}
			e.TCP.Inc()
			go func() { io.Copy(c, c); c.Close() }()
		}
	}()
	ul, err := tnet.ListenUDPAddrPort(netip.AddrPortFrom(ExitIP, 7))
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		buf := make([]byte, 65536)
		for {
			n, from, err := ul.ReadFrom(buf)
			if err != nil {
				return
			}
			ul.WriteTo(buf[:n], from)
		}
	}()
	dl, err := tnet.ListenUDPAddrPort(netip.AddrPortFrom(ExitIP, 53))
	if err != nil {
		t.Fatal(err)
	}
	go serveDNS(dl)
	return e
}

func hexKey(t testing.TB, b64 string) string {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(raw) != 32 {
		t.Fatalf("bad key %q", b64)
	}
	return hex.EncodeToString(raw)
}

func serveDNS(pc net.PacketConn) {
	buf := make([]byte, 1500)
	for {
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		if resp, err := answer(buf[:n]); err == nil {
			pc.WriteTo(resp, from)
		}
	}
}

func answer(q []byte) ([]byte, error) {
	var p dnsmessage.Parser
	h, err := p.Start(q)
	if err != nil {
		return nil, err
	}
	qs, err := p.AllQuestions()
	if err != nil || len(qs) != 1 {
		return nil, errors.New("one question")
	}
	question := qs[0]
	name := strings.TrimSuffix(question.Name.String(), ".")
	bld := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: h.ID, Response: true, Authoritative: true})
	bld.EnableCompression()
	bld.StartQuestions()
	bld.Question(question)
	bld.StartAnswers()
	hdr := dnsmessage.ResourceHeader{Name: question.Name, Class: dnsmessage.ClassINET, TTL: 60}
	if question.Type == dnsmessage.TypeA {
		switch name {
		case EchoName:
			bld.AResource(hdr, dnsmessage.AResource{A: ExitIP.As4()})
		case BlockedName:
			bld.AResource(hdr, dnsmessage.AResource{A: [4]byte{127, 0, 0, 1}})
		}
	}
	return bld.Finish()
}
