//go:build linux

// uno-gw is the exit side of Network on Linux: an AmneziaWG / WireGuard
// interface per protocol (amneziawg-go on a TUN device), a peer per device,
// NAT out and a firewall that lets peers reach the internet only.
//
//	uno-gw run --config /etc/uno-gw/config.json    (root; SIGHUP reloads peers)
//	uno-gw ruleset --config …                       print the nft script
//	uno-gw keygen
package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"github.com/amnezia-vpn/amneziawg-go/v3/conn"
	"github.com/amnezia-vpn/amneziawg-go/v3/device"
	"github.com/amnezia-vpn/amneziawg-go/v3/tun"

	"github.com/technoob228/uno-work/native/uno-net/internal/gateway"
)

var version = "dev"

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "run":
		err = run(os.Args[2:])
	case "ruleset":
		err = ruleset(os.Args[2:])
	case "keygen":
		k, kerr := ecdh.X25519().GenerateKey(rand.Reader)
		if kerr != nil {
			err = kerr
			break
		}
		err = json.NewEncoder(os.Stdout).Encode(map[string]string{
			"privateKey": base64.StdEncoding.EncodeToString(k.Bytes()),
			"publicKey":  base64.StdEncoding.EncodeToString(k.PublicKey().Bytes()),
		})
	case "version":
		fmt.Println(version)
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "uno-gw:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: uno-gw run|ruleset|keygen|version --config file")
	os.Exit(2)
}

func load(path string) (*gateway.Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return gateway.Parse(data)
}

func ruleset(args []string) error {
	fs := flag.NewFlagSet("ruleset", flag.ExitOnError)
	path := fs.String("config", "/etc/uno-gw/config.json", "config")
	fs.Parse(args)
	c, err := load(*path)
	if err != nil {
		return err
	}
	fmt.Print(c.Ruleset())
	return nil
}

type iface struct {
	name string
	dev  *device.Device
}

func run(args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	path := fs.String("config", "/etc/uno-gw/config.json", "config")
	fs.Parse(args)
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	c, err := load(*path)
	if err != nil {
		return err
	}
	if err := os.WriteFile("/proc/sys/net/ipv4/ip_forward", []byte("1"), 0o644); err != nil {
		return fmt.Errorf("ip_forward: %w", err)
	}
	var ifs []iface
	defer func() {
		for _, i := range ifs {
			i.dev.Close()
		}
		exec.Command("nft", "delete", "table", "inet", gateway.Table).Run()
	}()
	for _, in := range c.Interfaces {
		mtu := in.MTU
		if mtu == 0 {
			mtu = 1420
		}
		td, err := tun.CreateTUN(in.Name, mtu)
		if err != nil {
			return fmt.Errorf("%s: tun: %w", in.Name, err)
		}
		lg := log.With("if", in.Name, "protocol", string(in.Protocol))
		dev := device.NewDevice(td, conn.NewDefaultBind(), &device.Logger{
			Verbosef: func(string, ...any) {},
			Errorf:   func(f string, a ...any) { lg.Warn(fmt.Sprintf(f, a...)) },
		})
		ifs = append(ifs, iface{in.Name, dev})
		dc, err := c.DeviceConfig(in.Name)
		if err != nil {
			return err
		}
		if err := dev.IpcSet(dc); err != nil {
			return fmt.Errorf("%s: device: %w", in.Name, err)
		}
		if err := dev.Up(); err != nil {
			return err
		}
		if err := sh("ip", "addr", "replace", in.Address, "dev", in.Name); err != nil {
			return err
		}
		if err := sh("ip", "link", "set", in.Name, "mtu", strconv.Itoa(mtu), "up"); err != nil {
			return err
		}
		log.Info("interface up", "if", in.Name, "protocol", string(in.Protocol), "port", in.ListenPort, "address", in.Address)
	}
	if err := applyRules(c); err != nil {
		return err
	}
	undo := allowThroughIptables(c, log)
	defer undo()
	log.Info("gateway ready", "peers", len(c.Peers), "version", version)

	sig := make(chan os.Signal, 2)
	signal.Notify(sig, syscall.SIGHUP, syscall.SIGINT, syscall.SIGTERM)
	for s := range sig {
		if s != syscall.SIGHUP {
			return nil
		}
		nc, err := load(*path)
		if err != nil {
			log.Warn("reload refused", "err", err)
			continue
		}
		if !sameInterfaces(c, nc) {
			log.Warn("reload refused: interfaces changed, restart uno-gw")
			continue
		}
		for _, i := range ifs {
			dc, _ := nc.DeviceConfig(i.name)
			if err := i.dev.IpcSet(dc); err != nil {
				log.Warn("reload failed", "if", i.name, "err", err)
			}
		}
		if err := applyRules(nc); err != nil {
			log.Warn("rules", "err", err)
		}
		c = nc
		log.Info("reloaded", "peers", len(c.Peers))
	}
	return nil
}

func sameInterfaces(a, b *gateway.Config) bool {
	ja, _ := json.Marshal(a.Interfaces)
	jb, _ := json.Marshal(b.Interfaces)
	return string(ja) == string(jb)
}

func applyRules(c *gateway.Config) error {
	cmd := exec.Command("nft", "-f", "-")
	cmd.Stdin = strings.NewReader(c.Ruleset())
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("nft: %v: %s", err, out)
	}
	return nil
}

// allowThroughIptables: where Docker (or anything else) set the iptables
// FORWARD policy to DROP, that chain would drop what uno-gw's own table
// accepted. Let the tunnel interfaces through it — only them; uno-gw's
// table, which runs first, already dropped the blocked destinations.
// Returns the undo.
func allowThroughIptables(c *gateway.Config, log *slog.Logger) func() {
	var added [][]string
	for _, bin := range []string{"iptables", "ip6tables"} {
		out, err := exec.Command(bin, "-S", "FORWARD").Output()
		if err != nil || !strings.Contains(string(out), "-P FORWARD DROP") {
			continue
		}
		chain := "FORWARD"
		if exec.Command(bin, "-S", "DOCKER-USER").Run() == nil {
			chain = "DOCKER-USER"
		}
		for _, in := range c.Interfaces {
			for _, rule := range [][]string{
				{"-i", in.Name, "-j", "ACCEPT"},
				{"-o", in.Name, "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"},
			} {
				if exec.Command(bin, append([]string{"-C", chain}, rule...)...).Run() == nil {
					continue
				}
				if err := sh(bin, append([]string{"-I", chain}, rule...)...); err != nil {
					log.Warn("iptables", "err", err)
					continue
				}
				added = append(added, append([]string{bin, "-D", chain}, rule...))
			}
		}
		log.Info("FORWARD policy is DROP: let the tunnel interfaces through", "tool", bin, "chain", chain)
	}
	return func() {
		for _, a := range added {
			exec.Command(a[0], a[1:]...).Run()
		}
	}
}

func sh(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, out)
	}
	return nil
}
