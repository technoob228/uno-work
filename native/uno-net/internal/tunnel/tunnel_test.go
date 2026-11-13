package tunnel

import (
	"net/netip"
	"strings"
	"testing"

	"github.com/technoob228/uno-work/native/uno-net/internal/config"
)

func TestUAPI(t *testing.T) {
	tr := config.Transport{
		Protocol:    config.AmneziaWG,
		PrivateKey:  "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=",
		Addresses:   []string{"10.66.0.2/32"},
		Obfuscation: map[string]string{"h1": "5", "jc": "3"},
		Peer:        config.Peer{PublicKey: "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=", Endpoint: "1.2.3.4:51820"},
	}
	got, err := UAPI(tr, netip.MustParseAddrPort("1.2.3.4:51820"))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"private_key=c809f3e5317e9575c9b5ed78b638b7ce530dabe85ddab6142202418" + "01ddf0669",
		"jc=3", "h1=5",
		"public_key=",
		"endpoint=1.2.3.4:51820",
		"persistent_keepalive_interval=25",
		"allowed_ip=0.0.0.0/0", "allowed_ip=::/0",
	}
	last := -1
	for _, w := range want {
		i := strings.Index(got, w)
		if i < 0 || i < last {
			t.Fatalf("missing or out of order %q in\n%s", w, got)
		}
		last = i
	}
}

func TestEchoChecksum(t *testing.T) {
	msg := echoRequest(false, 1, 1)
	if checksum(msg) != 0 {
		t.Fatal("ICMPv4 echo checksum does not verify")
	}
}
