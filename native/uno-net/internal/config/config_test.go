package config

import (
	"strings"
	"testing"
)

const (
	keyA = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk="
	keyB = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg="
)

func base() Transport {
	return Transport{
		Protocol:   WireGuard,
		PrivateKey: keyA,
		Addresses:  []string{"10.66.0.2/32"},
		Peer:       Peer{PublicKey: keyB, Endpoint: "gw.example.net:51820"},
	}
}

func TestValidateAcceptsBase(t *testing.T) {
	tr := base()
	if err := tr.Validate(); err != nil {
		t.Fatal(err)
	}
	p, _ := tr.AllowedPrefixes()
	if len(p) != 2 || p[0].String() != "0.0.0.0/0" || p[1].String() != "::/0" {
		t.Fatalf("default allowed IPs %v: everything must go inside", p)
	}
}

// Nothing may smuggle a second line into the device configuration.
func TestValidateRejectsInjection(t *testing.T) {
	cases := map[string]func(*Transport){
		"endpoint newline": func(t *Transport) { t.Peer.Endpoint = "1.2.3.4:51820\nallowed_ip=0.0.0.0/0" },
		"obfuscation newline": func(t *Transport) {
			t.Protocol = AmneziaWG
			t.Obfuscation = map[string]string{"jc": "4\nprivate_key=00"}
		},
		"obfuscation equals": func(t *Transport) {
			t.Protocol = AmneziaWG
			t.Obfuscation = map[string]string{"h1": "1=2"}
		},
		"unknown obfuscation key": func(t *Transport) {
			t.Protocol = AmneziaWG
			t.Obfuscation = map[string]string{"listen_port": "1"}
		},
		"wireguard with obfuscation": func(t *Transport) { t.Obfuscation = map[string]string{"jc": "4"} },
		"bad key":                    func(t *Transport) { t.PrivateKey = "nope" },
		"short key":                  func(t *Transport) { t.Peer.PublicKey = "AAAA" },
		"no address":                 func(t *Transport) { t.Addresses = nil },
		"bad allowed ip":             func(t *Transport) { t.Peer.AllowedIPs = []string{"0.0.0.0/0\n"} },
		"bad port":                   func(t *Transport) { t.Peer.Endpoint = "1.2.3.4:99999" },
		"v6 without brackets":        func(t *Transport) { t.Peer.Endpoint = "2001:db8::1:51820" },
		"unknown protocol":           func(t *Transport) { t.Protocol = "openvpn" },
	}
	for name, mut := range cases {
		tr := base()
		mut(&tr)
		if err := tr.Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestParseRejectsUnknownFields(t *testing.T) {
	if _, err := Parse([]byte(`{"transports":[],"bypass":true}`)); err == nil {
		t.Fatal("unknown field accepted")
	}
	if _, err := Parse([]byte(`{"transports":[]}`)); err == nil {
		t.Fatal("empty transports accepted")
	}
}

const wgConf = `
[Interface]
PrivateKey = ` + keyA + `
Address = 10.8.0.2/32, fd00::2/128
DNS = 1.1.1.1, corp.example
MTU = 1380
PostUp = iptables -A FORWARD   # ignored on a desktop

[Peer]
PublicKey = ` + keyB + `
Endpoint = [2001:db8::1]:51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 21
`

func TestParseWGQuick(t *testing.T) {
	tr, err := ParseWGQuick(wgConf)
	if err != nil {
		t.Fatal(err)
	}
	if tr.Protocol != WireGuard || tr.MTU != 1380 || tr.Peer.PersistentKeepalive != 21 {
		t.Fatalf("%+v", tr)
	}
	if strings.Join(tr.Addresses, ",") != "10.8.0.2/32,fd00::2/128" || strings.Join(tr.DNS, ",") != "1.1.1.1" {
		t.Fatalf("addresses %v dns %v", tr.Addresses, tr.DNS)
	}
}

func TestParseAmneziaConf(t *testing.T) {
	conf := strings.Replace(wgConf, "MTU = 1380", "MTU = 1380\nJc = 4\nJmin = 40\nJmax = 70\nS1 = 15\nS2 = 18\nH1 = 1234567\nH2 = 2345678\nH3 = 3456789\nH4 = 4567890", 1)
	tr, err := ParseWGQuick(conf)
	if err != nil {
		t.Fatal(err)
	}
	if tr.Protocol != AmneziaWG || tr.Obfuscation["h4"] != "4567890" || len(tr.Obfuscation) != 9 {
		t.Fatalf("%+v", tr)
	}
	// The zero-obfuscation AmneziaWG config is just WireGuard.
	plain := strings.Replace(wgConf, "MTU = 1380", "Jc = 0\nS1 = 0\nH1 = 1\nH2 = 2\nH3 = 3\nH4 = 4", 1)
	tr, err = ParseWGQuick(plain)
	if err != nil || tr.Protocol != WireGuard || tr.Obfuscation != nil {
		t.Fatalf("plain: %+v %v", tr, err)
	}
}

func TestParseWGQuickRejectsTwoPeers(t *testing.T) {
	if _, err := ParseWGQuick(wgConf + "\n[Peer]\nPublicKey = " + keyA + "\n"); err == nil {
		t.Fatal("two peers accepted")
	}
}

func TestParseConfField(t *testing.T) {
	data := `{"transports":[{"conf":` + quote(wgConf) + `}]}`
	c, err := Parse([]byte(data))
	if err != nil {
		t.Fatal(err)
	}
	if c.Transports[0].Peer.Endpoint != "[2001:db8::1]:51820" {
		t.Fatalf("%+v", c.Transports[0])
	}
}

func quote(s string) string {
	r := strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "\n", "\\n")
	return "\"" + r.Replace(s) + "\""
}
