// uno-net is Uno Work's tunnel engine for Network: WireGuard / AmneziaWG in
// user space (no root, no TUN), entered through a SOCKS5 server on loopback.
//
//	uno-net run [--socks 127.0.0.1:0] [--control 127.0.0.1:0] [--config file.json] [--lifeline]
//	    env UNO_NET_SOCKS_TOKEN, UNO_NET_CONTROL_TOKEN (each at least 32 chars)
//	    prints one JSON line {"ready":true,"socks":"…","control":"…"} on stdout
//	uno-net keygen          {"privateKey":"…","publicKey":"…"} (base64)
//	uno-net parse-conf      wg-quick / AmneziaWG config on stdin → transport JSON
//	uno-net version
//
// Tokens come from the environment, never the command line: anyone on the
// machine can read another process's arguments.
package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/technoob228/uno-work/native/uno-net/internal/config"
	"github.com/technoob228/uno-work/native/uno-net/internal/control"
	"github.com/technoob228/uno-work/native/uno-net/internal/engine"
	"github.com/technoob228/uno-work/native/uno-net/internal/socks"
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
	case "keygen":
		err = keygen(os.Stdout)
	case "parse-conf":
		err = parseConf(os.Stdin, os.Stdout)
	case "version":
		fmt.Println(version)
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "uno-net:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: uno-net run|keygen|parse-conf|version")
	os.Exit(2)
}

func run(args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	socksAddr := fs.String("socks", "127.0.0.1:0", "SOCKS5 listen address (loopback)")
	controlAddr := fs.String("control", "127.0.0.1:0", "control API listen address (loopback)")
	configPath := fs.String("config", "", "config to start with (JSON)")
	lifeline := fs.Bool("lifeline", false, "exit when stdin closes (the parent died)")
	logLevel := fs.String("log-level", "info", "debug|info|warn|error")
	fs.Parse(args)

	var lvl slog.Level
	if err := lvl.UnmarshalText([]byte(*logLevel)); err != nil {
		return err
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: lvl}))

	socksToken := os.Getenv("UNO_NET_SOCKS_TOKEN")
	controlToken := os.Getenv("UNO_NET_CONTROL_TOKEN")
	if len(socksToken) < 32 || len(controlToken) < 32 {
		return errors.New("UNO_NET_SOCKS_TOKEN and UNO_NET_CONTROL_TOKEN must be set (32+ chars)")
	}
	if socksToken == controlToken {
		return errors.New("the SOCKS and control tokens must differ")
	}
	for _, a := range []string{*socksAddr, *controlAddr} {
		if err := mustLoopback(a); err != nil {
			return err
		}
	}

	eng := engine.New(log)
	if *configPath != "" {
		data, err := os.ReadFile(*configPath)
		if err != nil {
			return err
		}
		cfg, err := config.Parse(data)
		if err != nil {
			return err
		}
		eng.Apply(cfg)
	}

	sln, err := net.Listen("tcp", *socksAddr)
	if err != nil {
		return err
	}
	cln, err := net.Listen("tcp", *controlAddr)
	if err != nil {
		return err
	}
	srv := &socks.Server{Dialer: eng, Token: socksToken, Log: log}
	api := &control.API{Engine: eng, Socks: srv, SocksAddr: sln.Addr().String(), Token: controlToken, Version: version, Log: log}
	hs := &http.Server{Handler: api.Handler(), ReadHeaderTimeout: 5 * time.Second}

	errc := make(chan error, 2)
	go func() { errc <- srv.Serve(sln) }()
	go func() { errc <- hs.Serve(cln) }()

	ready, _ := json.Marshal(map[string]any{"ready": true, "socks": sln.Addr().String(), "control": cln.Addr().String(), "version": version})
	fmt.Println(string(ready))

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	gone := make(chan struct{})
	if *lifeline {
		go func() {
			io.Copy(io.Discard, os.Stdin)
			close(gone)
		}()
	}
	select {
	case <-sig:
	case <-gone:
		log.Info("parent gone, exiting")
	case err = <-errc:
	}
	srv.Close()
	hs.Close()
	eng.Stop()
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	return err
}

func mustLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	ip, err := netip.ParseAddr(host)
	if err != nil || !ip.IsLoopback() {
		return fmt.Errorf("%s: uno-net listens on loopback only", addr)
	}
	return nil
}

func keygen(w io.Writer) error {
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	return json.NewEncoder(w).Encode(map[string]string{
		"privateKey": base64.StdEncoding.EncodeToString(k.Bytes()),
		"publicKey":  base64.StdEncoding.EncodeToString(k.PublicKey().Bytes()),
	})
}

func parseConf(r io.Reader, w io.Writer) error {
	data, err := io.ReadAll(io.LimitReader(r, 1<<20))
	if err != nil {
		return err
	}
	t, err := config.ParseWGQuick(string(data))
	if err != nil {
		return err
	}
	// The private key stays in the output: the caller stores the transport.
	return json.NewEncoder(w).Encode(t)
}
