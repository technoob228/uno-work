// Package gateway is the exit side of Network: one WireGuard / AmneziaWG
// interface per protocol, a peer per device, and the firewall that lets
// those peers out to the internet and nowhere else — not to each other, not
// to the gateway's own services, not to private networks or cloud metadata.
// The pure parts (config, device lines, nft ruleset) live here and are
// tested; cmd/uno-gw applies them on Linux.
package gateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"sort"
	"strings"

	"github.com/technoob228/uno-work/native/uno-net/internal/config"
)

// Interface is one listening tunnel interface.
type Interface struct {
	Name       string          `json:"name"`
	Protocol   config.Protocol `json:"protocol"`
	ListenPort int             `json:"listenPort"`
	PrivateKey string          `json:"privateKey"`
	// Address of the gateway inside the tunnel, with the peers' prefix
	// ("10.66.0.1/24").
	Address     string            `json:"address"`
	MTU         int               `json:"mtu,omitempty"`
	Obfuscation map[string]string `json:"obfuscation,omitempty"`
}

// Peer is one device allowed in.
type Peer struct {
	Interface    string `json:"interface"`
	PublicKey    string `json:"publicKey"`
	PresharedKey string `json:"presharedKey,omitempty"`
	// Address inside the tunnel (a single /32 or /128).
	Address string `json:"address"`
	// Label for logs ("account 85 · Misha's Mac").
	Label string `json:"label,omitempty"`
}

// Config is the gateway's whole state.
type Config struct {
	Interfaces []Interface `json:"interfaces"`
	Peers      []Peer      `json:"peers"`
	// Egress is the interface traffic leaves by ("eth0"); empty: any.
	Egress string `json:"egress,omitempty"`
	// Block are destinations peers may never reach; empty: DefaultBlock.
	Block []string `json:"block,omitempty"`
}

// DefaultBlock: private and special ranges. A peer reaches the internet,
// not the network the gateway sits in.
var DefaultBlock = []string{
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
	"172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3",
	"::1/128", "fc00::/7", "fe80::/10", "ff00::/8",
}

var ifName = regexp.MustCompile(`^[a-z][a-z0-9]{1,14}$`)

func Parse(data []byte) (*Config, error) {
	var c Config
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("gateway config: %w", err)
	}
	return &c, c.Validate()
}

func (c *Config) BlockList() []string {
	if len(c.Block) > 0 {
		return c.Block
	}
	return DefaultBlock
}

func (c *Config) Validate() error {
	if len(c.Interfaces) == 0 {
		return errors.New("gateway config: no interfaces")
	}
	names := map[string]netip.Prefix{}
	ports := map[int]bool{}
	for i, in := range c.Interfaces {
		if !ifName.MatchString(in.Name) {
			return fmt.Errorf("interface %d: bad name %q", i, in.Name)
		}
		if _, dup := names[in.Name]; dup {
			return fmt.Errorf("interface %q twice", in.Name)
		}
		if in.ListenPort < 1 || in.ListenPort > 65535 || ports[in.ListenPort] {
			return fmt.Errorf("interface %q: bad or repeated port %d", in.Name, in.ListenPort)
		}
		ports[in.ListenPort] = true
		p, err := netip.ParsePrefix(in.Address)
		if err != nil || p.Bits() >= p.Addr().BitLen() {
			return fmt.Errorf("interface %q: address %q must be gateway/prefix", in.Name, in.Address)
		}
		names[in.Name] = p
		// Reuse the client transport's checks for keys and obfuscation.
		probe := config.Transport{
			Protocol: in.Protocol, PrivateKey: in.PrivateKey, Addresses: []string{in.Address},
			MTU: in.MTU, Obfuscation: in.Obfuscation,
			Peer: config.Peer{PublicKey: in.PrivateKey, Endpoint: "127.0.0.1:1"},
		}
		if err := probe.Validate(); err != nil {
			return fmt.Errorf("interface %q: %w", in.Name, err)
		}
	}
	keys := map[string]bool{}
	addrs := map[netip.Addr]bool{}
	for i, p := range c.Peers {
		pref, ok := names[p.Interface]
		if !ok {
			return fmt.Errorf("peer %d: unknown interface %q", i, p.Interface)
		}
		if _, err := config.KeyHex(p.PublicKey); err != nil {
			return fmt.Errorf("peer %d: publicKey: %w", i, err)
		}
		if p.PresharedKey != "" {
			if _, err := config.KeyHex(p.PresharedKey); err != nil {
				return fmt.Errorf("peer %d: presharedKey: %w", i, err)
			}
		}
		k := p.Interface + "/" + p.PublicKey
		if keys[k] {
			return fmt.Errorf("peer %d: key twice on %s", i, p.Interface)
		}
		keys[k] = true
		a, err := netip.ParseAddr(p.Address)
		if err != nil || !pref.Contains(a) || a == pref.Addr() || addrs[a] {
			return fmt.Errorf("peer %d: address %q must be a free address in %s", i, p.Address, pref)
		}
		addrs[a] = true
		if strings.ContainsAny(p.Label, "\n\r\"") {
			return fmt.Errorf("peer %d: bad label", i)
		}
	}
	if c.Egress != "" && !ifName.MatchString(c.Egress) && !regexp.MustCompile(`^[a-z][a-z0-9.\-]{1,14}$`).MatchString(c.Egress) {
		return fmt.Errorf("bad egress %q", c.Egress)
	}
	for _, b := range c.Block {
		if _, err := netip.ParsePrefix(b); err != nil {
			return fmt.Errorf("block %q: %w", b, err)
		}
	}
	return nil
}

// DeviceConfig renders the device lines for one interface with its peers.
// replace_peers makes a reload drop peers that are gone.
func (c *Config) DeviceConfig(name string) (string, error) {
	var in *Interface
	for i := range c.Interfaces {
		if c.Interfaces[i].Name == name {
			in = &c.Interfaces[i]
		}
	}
	if in == nil {
		return "", fmt.Errorf("no interface %q", name)
	}
	priv, err := config.KeyHex(in.PrivateKey)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "private_key=%s\nlisten_port=%d\n", priv, in.ListenPort)
	if in.Protocol == config.AmneziaWG {
		for _, k := range []string{"jc", "jmin", "jmax", "s1", "s2", "s3", "s4", "h1", "h2", "h3", "h4", "i1", "i2", "i3", "i4", "i5"} {
			if v, ok := in.Obfuscation[k]; ok {
				fmt.Fprintf(&b, "%s=%s\n", k, v)
			}
		}
	}
	b.WriteString("replace_peers=true\n")
	for _, p := range c.Peers {
		if p.Interface != name {
			continue
		}
		pub, _ := config.KeyHex(p.PublicKey)
		fmt.Fprintf(&b, "public_key=%s\n", pub)
		if p.PresharedKey != "" {
			psk, _ := config.KeyHex(p.PresharedKey)
			fmt.Fprintf(&b, "preshared_key=%s\n", psk)
		}
		a := netip.MustParseAddr(p.Address)
		fmt.Fprintf(&b, "allowed_ip=%s\n", netip.PrefixFrom(a, a.BitLen()))
	}
	return b.String(), nil
}

// Table is the nft table uno-gw owns; it is replaced whole on every apply.
const Table = "uno_gw"

// Ruleset renders the nft script: forward only tunnel → internet, NAT out,
// nothing from the tunnel to the gateway itself except ping.
func (c *Config) Ruleset() string {
	ifs := make([]string, 0, len(c.Interfaces))
	for _, in := range c.Interfaces {
		ifs = append(ifs, fmt.Sprintf("%q", in.Name))
	}
	sort.Strings(ifs)
	set := "{ " + strings.Join(ifs, ", ") + " }"
	var v4, v6 []string
	for _, b := range c.BlockList() {
		p := netip.MustParsePrefix(b)
		if p.Addr().Is4() {
			v4 = append(v4, p.String())
		} else {
			v6 = append(v6, p.String())
		}
	}
	egress := ""
	if c.Egress != "" {
		egress = fmt.Sprintf(" oifname %q", c.Egress)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "table inet %s\ndelete table inet %s\ntable inet %s {\n", Table, Table, Table)
	if len(v4) > 0 {
		fmt.Fprintf(&b, "  set block4 { type ipv4_addr; flags interval; elements = { %s } }\n", strings.Join(v4, ", "))
	}
	if len(v6) > 0 {
		fmt.Fprintf(&b, "  set block6 { type ipv6_addr; flags interval; elements = { %s } }\n", strings.Join(v6, ", "))
	}
	b.WriteString("  chain input {\n    type filter hook input priority -10; policy accept;\n")
	fmt.Fprintf(&b, "    iifname %s ct state established,related accept\n", set)
	fmt.Fprintf(&b, "    iifname %s icmp type echo-request accept\n", set)
	fmt.Fprintf(&b, "    iifname %s icmpv6 type echo-request accept\n", set)
	fmt.Fprintf(&b, "    iifname %s drop\n  }\n", set)
	b.WriteString("  chain forward {\n    type filter hook forward priority -10; policy accept;\n")
	fmt.Fprintf(&b, "    oifname %s ct state established,related accept\n", set)
	fmt.Fprintf(&b, "    iifname %s oifname %s drop\n", set, set)
	if len(v4) > 0 {
		fmt.Fprintf(&b, "    iifname %s ip daddr @block4 drop\n", set)
	}
	if len(v6) > 0 {
		fmt.Fprintf(&b, "    iifname %s ip6 daddr @block6 drop\n", set)
	}
	fmt.Fprintf(&b, "    iifname %s tcp flags syn tcp option maxseg size set rt mtu\n", set)
	fmt.Fprintf(&b, "    iifname %s%s accept\n", set, egress)
	fmt.Fprintf(&b, "    iifname %s drop\n", set)
	fmt.Fprintf(&b, "    oifname %s drop\n  }\n", set)
	b.WriteString("  chain postrouting {\n    type nat hook postrouting priority srcnat; policy accept;\n")
	for _, in := range c.Interfaces {
		p := netip.MustParsePrefix(in.Address).Masked()
		fam := "ip"
		if p.Addr().Is6() {
			fam = "ip6"
		}
		fmt.Fprintf(&b, "    %s saddr %s%s masquerade\n", fam, p, egress)
	}
	b.WriteString("  }\n}\n")
	return b.String()
}
