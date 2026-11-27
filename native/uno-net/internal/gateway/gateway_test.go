package gateway

import (
	"strings"
	"testing"
)

const (
	gwKey  = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk="
	devKey = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg="
)

func sample() *Config {
	return &Config{
		Egress: "eth0",
		Interfaces: []Interface{
			{Name: "unowg0", Protocol: "wireguard", ListenPort: 51820, PrivateKey: gwKey, Address: "10.66.0.1/24"},
			{Name: "unoawg0", Protocol: "amneziawg", ListenPort: 51821, PrivateKey: gwKey, Address: "10.67.0.1/24",
				Obfuscation: map[string]string{"jc": "4", "h1": "1234567"}},
		},
		Peers: []Peer{
			{Interface: "unowg0", PublicKey: devKey, Address: "10.66.0.2", Label: "mac"},
			{Interface: "unoawg0", PublicKey: devKey, Address: "10.67.0.2"},
		},
	}
}

func TestValidate(t *testing.T) {
	if err := sample().Validate(); err != nil {
		t.Fatal(err)
	}
	bad := map[string]func(*Config){
		"peer outside prefix":   func(c *Config) { c.Peers[0].Address = "10.99.0.2" },
		"peer takes gateway ip": func(c *Config) { c.Peers[0].Address = "10.66.0.1" },
		"same address twice": func(c *Config) {
			c.Peers = append(c.Peers, Peer{Interface: "unowg0", PublicKey: gwKey, Address: "10.66.0.2"})
		},
		"same key twice": func(c *Config) {
			c.Peers = append(c.Peers, Peer{Interface: "unowg0", PublicKey: devKey, Address: "10.66.0.3"})
		},
		"unknown interface":     func(c *Config) { c.Peers[0].Interface = "wg9" },
		"bad name":              func(c *Config) { c.Interfaces[0].Name = "wg0; rm -rf /" },
		"same port":             func(c *Config) { c.Interfaces[1].ListenPort = 51820 },
		"no prefix":             func(c *Config) { c.Interfaces[0].Address = "10.66.0.1/32" },
		"label quote":           func(c *Config) { c.Peers[0].Label = "a\" drop" },
		"obfuscation injection": func(c *Config) { c.Interfaces[1].Obfuscation["jc"] = "1\nlisten_port=1" },
		"bad block":             func(c *Config) { c.Block = []string{"nope"} },
	}
	for name, mut := range bad {
		c := sample()
		mut(c)
		if err := c.Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestDeviceConfig(t *testing.T) {
	c := sample()
	dc, err := c.DeviceConfig("unoawg0")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"listen_port=51821\n", "jc=4\n", "h1=1234567\n", "replace_peers=true\n", "allowed_ip=10.67.0.2/32\n"} {
		if !strings.Contains(dc, want) {
			t.Fatalf("missing %q in\n%s", want, dc)
		}
	}
	if strings.Contains(dc, "10.66.0.2") {
		t.Fatal("a peer of another interface leaked in")
	}
	wg, _ := c.DeviceConfig("unowg0")
	if strings.Contains(wg, "jc=") {
		t.Fatal("wireguard interface got obfuscation")
	}
}

func TestRuleset(t *testing.T) {
	r := sample().Ruleset()
	for _, want := range []string{
		`set block4 { type ipv4_addr; flags interval; elements = { 0.0.0.0/8, 10.0.0.0/8,`,
		`169.254.0.0/16`,
		`iifname { "unoawg0", "unowg0" } oifname { "unoawg0", "unowg0" } drop`, // peers never see each other
		`iifname { "unoawg0", "unowg0" } ip daddr @block4 drop`,
		`iifname { "unoawg0", "unowg0" } drop`, // nothing to the gateway's own services
		`iifname { "unoawg0", "unowg0" } oifname "eth0" accept`,
		`ip saddr 10.66.0.0/24 oifname "eth0" masquerade`,
		`ip saddr 10.67.0.0/24 oifname "eth0" masquerade`,
	} {
		if !strings.Contains(r, want) {
			t.Fatalf("missing %q in\n%s", want, r)
		}
	}
	// The block rules must come before the accept.
	if strings.Index(r, "@block4 drop") > strings.Index(r, `oifname "eth0" accept`) {
		t.Fatal("block after accept")
	}
}
