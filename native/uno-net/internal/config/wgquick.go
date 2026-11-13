package config

import (
	"bufio"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// ParseWGQuick reads a WireGuard or AmneziaWG config the way wg-quick and
// the AmneziaVPN apps write it ([Interface] + one [Peer]). Any AmneziaWG key
// (Jc, S1, H1, I1...) makes it an AmneziaWG transport. Keys a desktop engine
// cannot use (PostUp, Table, SaveConfig...) are ignored.
func ParseWGQuick(text string) (Transport, error) {
	var t Transport
	section := ""
	peers := 0
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		line := sc.Text()
		if i := strings.IndexAny(line, "#;"); i >= 0 {
			line = line[:i]
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.ToLower(strings.TrimSpace(line[1 : len(line)-1]))
			if section == "peer" {
				peers++
				if peers > 1 {
					return t, errors.New("wg config: more than one [Peer]")
				}
			}
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return t, fmt.Errorf("wg config: bad line %q", line)
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		switch section {
		case "interface":
			switch key {
			case "privatekey":
				t.PrivateKey = value
			case "address":
				t.Addresses = append(t.Addresses, splitList(value)...)
			case "dns":
				t.DNS = append(t.DNS, splitList(value)...)
			case "mtu":
				n, err := strconv.Atoi(value)
				if err != nil {
					return t, fmt.Errorf("wg config: MTU: %w", err)
				}
				t.MTU = n
			default:
				if obfuscationKeys[key] {
					if t.Obfuscation == nil {
						t.Obfuscation = map[string]string{}
					}
					t.Obfuscation[key] = value
				}
			}
		case "peer":
			switch key {
			case "publickey":
				t.Peer.PublicKey = value
			case "presharedkey":
				t.Peer.PresharedKey = value
			case "endpoint":
				t.Peer.Endpoint = value
			case "allowedips":
				t.Peer.AllowedIPs = append(t.Peer.AllowedIPs, splitList(value)...)
			case "persistentkeepalive":
				if value == "off" {
					continue
				}
				n, err := strconv.Atoi(value)
				if err != nil {
					return t, fmt.Errorf("wg config: PersistentKeepalive: %w", err)
				}
				t.Peer.PersistentKeepalive = n
			}
		default:
			return t, fmt.Errorf("wg config: %q outside a section", key)
		}
	}
	if err := sc.Err(); err != nil {
		return t, err
	}
	if peers == 0 {
		return t, errors.New("wg config: no [Peer]")
	}
	t.Protocol = WireGuard
	if hasRealObfuscation(t.Obfuscation) {
		t.Protocol = AmneziaWG
	} else {
		t.Obfuscation = nil
	}
	// DNS may carry search domains; keep only addresses.
	t.DNS = onlyAddrs(t.DNS)
	return t, t.Validate()
}

// hasRealObfuscation: AmneziaWG configs with Jc=0, S1=0, H1..H4=1..4 are
// plain WireGuard on the wire.
func hasRealObfuscation(o map[string]string) bool {
	plain := map[string]string{"jc": "0", "jmin": "0", "jmax": "0", "s1": "0", "s2": "0", "s3": "0", "s4": "0", "h1": "1", "h2": "2", "h3": "3", "h4": "4"}
	for k, v := range o {
		if want, ok := plain[k]; ok && v == want {
			continue
		}
		return true
	}
	return false
}

func splitList(v string) []string {
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func onlyAddrs(in []string) []string {
	var out []string
	for _, d := range in {
		t := Transport{DNS: []string{d}}
		if _, err := t.DNSAddrs(); err == nil {
			out = append(out, d)
		}
	}
	return out
}
