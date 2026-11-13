// Package config describes what uno-net connects to: an ordered list of
// transports (one for a fixed protocol, several for Auto) and how health is
// checked. Keys are base64, the way WireGuard configs carry them.
package config

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

// Protocol is what carries the tunnel. AmneziaWG with no obfuscation is plain
// WireGuard on the wire, so one engine serves both.
type Protocol string

const (
	WireGuard Protocol = "wireguard"
	AmneziaWG Protocol = "amneziawg"
)

// Peer is the exit's side of the tunnel.
type Peer struct {
	PublicKey    string   `json:"publicKey"`
	PresharedKey string   `json:"presharedKey,omitempty"`
	Endpoint     string   `json:"endpoint"`
	AllowedIPs   []string `json:"allowedIPs,omitempty"`
	// PersistentKeepalive in seconds; 0 means the default (25).
	PersistentKeepalive int `json:"persistentKeepalive,omitempty"`
}

// Transport is one way to reach the exit.
type Transport struct {
	Protocol   Protocol `json:"protocol"`
	PrivateKey string   `json:"privateKey"`
	// Addresses this device has inside the tunnel ("10.66.0.2/32").
	Addresses []string `json:"addresses"`
	// DNS servers reached through the tunnel; names never resolve outside it.
	DNS []string `json:"dns,omitempty"`
	MTU int      `json:"mtu,omitempty"`
	// Obfuscation is AmneziaWG's jc, jmin, jmax, s1..s4, h1..h4, i1..i5.
	// Empty for WireGuard.
	Obfuscation map[string]string `json:"obfuscation,omitempty"`
	Peer        Peer              `json:"peer"`
	// Conf is an imported wg-quick / AmneziaWG config; when set it is the
	// whole transport and the fields above stay empty.
	Conf string `json:"conf,omitempty"`
}

// Config is the whole input of the engine.
type Config struct {
	// Transports are tried in order until one completes a handshake (Auto
	// lists WireGuard, then AmneziaWG). A fixed protocol lists one.
	Transports []Transport `json:"transports"`
	// HandshakeTimeoutMs bounds how long one transport may take to come up.
	HandshakeTimeoutMs int `json:"handshakeTimeoutMs,omitempty"`
	// Probe is an address inside or beyond the tunnel answered by ping (the
	// exit's tunnel address, or a DNS server). Empty: the first DNS server.
	Probe string `json:"probe,omitempty"`
	// ProbeIntervalMs between health probes; ProbeFailures in a row mean down.
	ProbeIntervalMs int `json:"probeIntervalMs,omitempty"`
	ProbeFailures   int `json:"probeFailures,omitempty"`
}

const (
	DefaultMTU              = 1280
	DefaultKeepalive        = 25
	DefaultHandshakeTimeout = 12 * time.Second
	DefaultProbeInterval    = 10 * time.Second
	DefaultProbeFailures    = 3
)

// obfuscationKeys are the AmneziaWG device keys uno-net passes through.
var obfuscationKeys = map[string]bool{
	"jc": true, "jmin": true, "jmax": true,
	"s1": true, "s2": true, "s3": true, "s4": true,
	"h1": true, "h2": true, "h3": true, "h4": true,
	"i1": true, "i2": true, "i3": true, "i4": true, "i5": true,
}

// Parse reads and checks a JSON config.
func Parse(data []byte) (*Config, error) {
	var c Config
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	for i := range c.Transports {
		if c.Transports[i].Conf == "" {
			continue
		}
		t, err := ParseWGQuick(c.Transports[i].Conf)
		if err != nil {
			return nil, fmt.Errorf("config: transport %d: %w", i, err)
		}
		c.Transports[i] = t
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) HandshakeTimeout() time.Duration {
	if c.HandshakeTimeoutMs > 0 {
		return time.Duration(c.HandshakeTimeoutMs) * time.Millisecond
	}
	return DefaultHandshakeTimeout
}

func (c *Config) ProbeInterval() time.Duration {
	if c.ProbeIntervalMs > 0 {
		return time.Duration(c.ProbeIntervalMs) * time.Millisecond
	}
	return DefaultProbeInterval
}

func (c *Config) ProbeFailureLimit() int {
	if c.ProbeFailures > 0 {
		return c.ProbeFailures
	}
	return DefaultProbeFailures
}

// Validate rejects anything that would not come up or could smuggle extra
// lines into the device configuration.
func (c *Config) Validate() error {
	if len(c.Transports) == 0 {
		return errors.New("config: no transports")
	}
	for i := range c.Transports {
		if err := c.Transports[i].Validate(); err != nil {
			return fmt.Errorf("config: transport %d: %w", i, err)
		}
	}
	if c.Probe != "" {
		if _, err := netip.ParseAddr(c.Probe); err != nil {
			return fmt.Errorf("config: probe: %w", err)
		}
	}
	return nil
}

func (t *Transport) Validate() error {
	switch t.Protocol {
	case WireGuard:
		if len(t.Obfuscation) > 0 {
			return errors.New("wireguard carries no obfuscation")
		}
	case AmneziaWG:
	default:
		return fmt.Errorf("unknown protocol %q", t.Protocol)
	}
	if _, err := KeyHex(t.PrivateKey); err != nil {
		return fmt.Errorf("privateKey: %w", err)
	}
	if _, err := KeyHex(t.Peer.PublicKey); err != nil {
		return fmt.Errorf("peer.publicKey: %w", err)
	}
	if t.Peer.PresharedKey != "" {
		if _, err := KeyHex(t.Peer.PresharedKey); err != nil {
			return fmt.Errorf("peer.presharedKey: %w", err)
		}
	}
	if len(t.Addresses) == 0 {
		return errors.New("no addresses")
	}
	for _, list := range [][]string{t.Addresses, t.DNS, t.Peer.AllowedIPs} {
		for _, v := range list {
			if strings.ContainsAny(v, "\n\r") {
				return fmt.Errorf("bad characters in %q", v)
			}
		}
	}
	if _, err := t.LocalAddrs(); err != nil {
		return err
	}
	if _, err := t.DNSAddrs(); err != nil {
		return err
	}
	if _, err := t.AllowedPrefixes(); err != nil {
		return err
	}
	if err := checkEndpoint(t.Peer.Endpoint); err != nil {
		return fmt.Errorf("peer.endpoint: %w", err)
	}
	if t.MTU != 0 && (t.MTU < 576 || t.MTU > 9000) {
		return fmt.Errorf("mtu %d out of range", t.MTU)
	}
	if t.Peer.PersistentKeepalive < 0 || t.Peer.PersistentKeepalive > 65535 {
		return errors.New("persistentKeepalive out of range")
	}
	for k, v := range t.Obfuscation {
		if !obfuscationKeys[k] {
			return fmt.Errorf("obfuscation: unknown key %q", k)
		}
		if strings.ContainsAny(v, "\n\r=") || strings.TrimSpace(v) == "" {
			return fmt.Errorf("obfuscation: bad value for %q", k)
		}
	}
	return nil
}

// KeyHex turns a base64 WireGuard key into the hex the device wants.
func KeyHex(b64 string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil {
		return "", errors.New("not base64")
	}
	if len(raw) != 32 {
		return "", errors.New("not 32 bytes")
	}
	return hex.EncodeToString(raw), nil
}

func (t *Transport) LocalAddrs() ([]netip.Addr, error) {
	out := make([]netip.Addr, 0, len(t.Addresses))
	for _, a := range t.Addresses {
		a = strings.TrimSpace(a)
		if p, err := netip.ParsePrefix(a); err == nil {
			out = append(out, p.Addr())
			continue
		}
		addr, err := netip.ParseAddr(a)
		if err != nil {
			return nil, fmt.Errorf("address %q: %w", a, err)
		}
		out = append(out, addr)
	}
	return out, nil
}

func (t *Transport) DNSAddrs() ([]netip.Addr, error) {
	out := make([]netip.Addr, 0, len(t.DNS))
	for _, d := range t.DNS {
		addr, err := netip.ParseAddr(strings.TrimSpace(d))
		if err != nil {
			return nil, fmt.Errorf("dns %q: %w", d, err)
		}
		out = append(out, addr)
	}
	return out, nil
}

// AllowedPrefixes defaults to everything: all the work goes inside the tunnel.
func (t *Transport) AllowedPrefixes() ([]netip.Prefix, error) {
	if len(t.Peer.AllowedIPs) == 0 {
		return []netip.Prefix{netip.MustParsePrefix("0.0.0.0/0"), netip.MustParsePrefix("::/0")}, nil
	}
	out := make([]netip.Prefix, 0, len(t.Peer.AllowedIPs))
	for _, a := range t.Peer.AllowedIPs {
		p, err := netip.ParsePrefix(strings.TrimSpace(a))
		if err != nil {
			return nil, fmt.Errorf("allowedIP %q: %w", a, err)
		}
		out = append(out, p)
	}
	return out, nil
}

func (t *Transport) EffectiveMTU() int {
	if t.MTU > 0 {
		return t.MTU
	}
	return DefaultMTU
}

func (t *Transport) Keepalive() int {
	if t.Peer.PersistentKeepalive > 0 {
		return t.Peer.PersistentKeepalive
	}
	return DefaultKeepalive
}

func checkEndpoint(ep string) error {
	host, port, ok := strings.Cut(strings.TrimSpace(ep), ":")
	if strings.HasPrefix(ep, "[") {
		i := strings.LastIndex(ep, "]:")
		if i < 0 {
			return errors.New("want host:port")
		}
		host, port, ok = ep[1:i], ep[i+2:], true
	} else if strings.Count(ep, ":") > 1 {
		return errors.New("IPv6 endpoint must be in brackets")
	}
	if !ok || host == "" || port == "" {
		return errors.New("want host:port")
	}
	if strings.ContainsAny(ep, "\n\r= ") {
		return errors.New("bad characters")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return errors.New("bad port")
	}
	return nil
}
