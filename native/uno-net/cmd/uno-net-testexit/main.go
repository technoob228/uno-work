// uno-net-testexit runs internal/exittest's exit as a program, for the Work
// daemon's tests (apps/server/src/network): a WireGuard exit on loopback UDP
// with an echo service on 10.66.0.1:7 and a DNS answering echo.test.
// Not shipped (build.sh doesn't build it).
//
//	uno-net-testexit    prints {"conf":"<wg-quick text for the client>"} and
//	                    runs until stdin closes
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/technoob228/uno-work/native/uno-net/internal/exittest"
)

type fatalT struct{ cleanups []func() }

func (t *fatalT) Helper()                   {}
func (t *fatalT) Fatal(args ...any)         { fmt.Fprintln(os.Stderr, args...); os.Exit(1) }
func (t *fatalT) Fatalf(f string, a ...any) { fmt.Fprintf(os.Stderr, f+"\n", a...); os.Exit(1) }
func (t *fatalT) Cleanup(f func())          { t.cleanups = append(t.cleanups, f) }

func main() {
	t := &fatalT{}
	client := exittest.NewKey(t)
	exit := exittest.Start(t, client.Public, exittest.Options{})
	conf := fmt.Sprintf("[Interface]\nPrivateKey = %s\nAddress = %s/32\nDNS = %s\n\n[Peer]\nPublicKey = %s\nEndpoint = %s\nAllowedIPs = 0.0.0.0/0\n",
		client.Private, exittest.ClientIP, exittest.ExitIP, exit.Key.Public, exit.Endpoint())
	out, _ := json.Marshal(map[string]string{"conf": conf})
	fmt.Println(string(out))
	io.Copy(io.Discard, os.Stdin)
	for _, f := range t.cleanups {
		f()
	}
}
