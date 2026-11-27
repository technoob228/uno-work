package gateway

// Setup of a gateway on a computer the person owns (27.11: "your own cloud
// computer as exit", installed by Uno). The console never holds the
// gateway's private keys: `uno-gw init` makes them on the computer and
// prints only the public ones. Devices come and go through a separate
// peers file the console rewrites in full; SIGHUP re-reads it.

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/technoob228/uno-work/native/uno-net/internal/config"
)

const (
	ConfigFile = "config.json"
	PeersFile  = "peers.json"

	WGInterface  = "unowg0"
	AWGInterface = "unoawg0"
	WGPort       = 51820
	AWGPort      = 51821
	WGAddress    = "10.66.0.1/24"
	AWGAddress   = "10.67.0.1/24"
)

// Public is what `uno-gw init` prints: per protocol, the key and port the
// console hands to devices.
type Public struct {
	WireGuard PublicSide `json:"wireguard"`
	AmneziaWG PublicSide `json:"amneziawg"`
	// Created is true when this call made the keys (first setup).
	Created bool `json:"created"`
}

type PublicSide struct {
	Interface  string `json:"interface"`
	PublicKey  string `json:"publicKey"`
	ListenPort int    `json:"listenPort"`
	Address    string `json:"address"`
}

// NewKey is a fresh X25519 private key, base64.
func NewKey() (string, error) {
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(k.Bytes()), nil
}

// PublicOf derives the public key of a base64 private key.
func PublicOf(private string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(private)
	if err != nil {
		return "", err
	}
	k, err := ecdh.X25519().NewPrivateKey(raw)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(k.PublicKey().Bytes()), nil
}

// NewConfig is the standard two-interface gateway (WireGuard + AmneziaWG).
func NewConfig(egress string, obfuscation map[string]string) (*Config, error) {
	wg, err := NewKey()
	if err != nil {
		return nil, err
	}
	awg, err := NewKey()
	if err != nil {
		return nil, err
	}
	c := &Config{
		Egress: egress,
		Interfaces: []Interface{
			{Name: WGInterface, Protocol: config.WireGuard, ListenPort: WGPort, PrivateKey: wg, Address: WGAddress},
			{Name: AWGInterface, Protocol: config.AmneziaWG, ListenPort: AWGPort, PrivateKey: awg, Address: AWGAddress, Obfuscation: obfuscation},
		},
	}
	return c, c.Validate()
}

// PublicView of a config: no private keys.
func (c *Config) PublicView() (Public, error) {
	var p Public
	for _, in := range c.Interfaces {
		pub, err := PublicOf(in.PrivateKey)
		if err != nil {
			return p, fmt.Errorf("%s: %w", in.Name, err)
		}
		side := PublicSide{Interface: in.Name, PublicKey: pub, ListenPort: in.ListenPort, Address: in.Address}
		switch in.Protocol {
		case config.WireGuard:
			p.WireGuard = side
		case config.AmneziaWG:
			p.AmneziaWG = side
		}
	}
	return p, nil
}

// ParsePeers reads a peers file: a JSON array of Peer.
func ParsePeers(data []byte) ([]Peer, error) {
	if len(strings.TrimSpace(string(data))) == 0 {
		return nil, nil
	}
	var peers []Peer
	if err := json.Unmarshal(data, &peers); err != nil {
		return nil, fmt.Errorf("peers: %w", err)
	}
	return peers, nil
}

// Load reads <config> and, next to it, peers.json (when present); the
// peers of both are joined and the whole is validated.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := strictDecode(data, &c); err != nil {
		return nil, err
	}
	extra, err := os.ReadFile(filepath.Join(filepath.Dir(path), PeersFile))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err == nil {
		peers, err := ParsePeers(extra)
		if err != nil {
			return nil, err
		}
		c.Peers = append(c.Peers, peers...)
	}
	return &c, c.Validate()
}

// Init makes <dir>/config.json when it is missing (keys made here) and an
// empty peers.json; an existing config is kept as it is. Returns the
// public side.
func Init(dir, egress string, obfuscation map[string]string) (Public, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return Public{}, err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return Public{}, err
	}
	path := filepath.Join(dir, ConfigFile)
	created := false
	c, err := Load(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		c, err = NewConfig(egress, obfuscation)
		if err != nil {
			return Public{}, err
		}
		data, _ := json.MarshalIndent(c, "", "  ")
		if err := writeFile(path, data); err != nil {
			return Public{}, err
		}
		created = true
	case err != nil:
		return Public{}, err
	}
	peers := filepath.Join(dir, PeersFile)
	if _, err := os.Stat(peers); errors.Is(err, os.ErrNotExist) {
		if err := writeFile(peers, []byte("[]\n")); err != nil {
			return Public{}, err
		}
	}
	p, err := c.PublicView()
	p.Created = created
	return p, err
}

// writeFile: 0600, atomically (rename), so a reload never reads half a file.
func writeFile(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Unit is the systemd unit `uno-gw install-service` writes.
func Unit(bin, configPath string) string {
	return fmt.Sprintf(`[Unit]
Description=Uno Network exit (uno-gw)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%s run --config %s
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`, bin, configPath)
}
