package control

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/technoob228/uno-work/native/uno-net/internal/engine"
	"github.com/technoob228/uno-work/native/uno-net/internal/socks"
)

const tok = "control-token-0123456789abcdef0123456"

func newAPI() http.Handler {
	eng := engine.New(nil)
	return (&API{Engine: eng, Socks: &socks.Server{Dialer: eng, Token: "x"}, SocksAddr: "127.0.0.1:1", Token: tok, Version: "t"}).Handler()
}

func do(h http.Handler, method, path, host, auth, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Host = host
	if auth != "" {
		r.Header.Set("Authorization", "Bearer "+auth)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestAuth(t *testing.T) {
	h := newAPI()
	if c := do(h, "GET", "/v1/status", "127.0.0.1:5", "", "").Code; c != 401 {
		t.Fatalf("no token: %d", c)
	}
	if c := do(h, "GET", "/v1/status", "127.0.0.1:5", "wrong", "").Code; c != 401 {
		t.Fatalf("wrong token: %d", c)
	}
	// DNS rebinding: a page that points its own name at 127.0.0.1.
	if c := do(h, "GET", "/v1/status", "evil.example:5", tok, "").Code; c != 403 {
		t.Fatalf("foreign Host: %d", c)
	}
	w := do(h, "GET", "/v1/status", "127.0.0.1:5", tok, "")
	var st Status
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &st) != nil || st.Status != engine.Off || st.Socks != "127.0.0.1:1" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}

func TestHealthAndConfig(t *testing.T) {
	h := newAPI()
	if c := do(h, "GET", "/v1/health", "[::1]:5", tok, "").Code; c != 503 {
		t.Fatalf("health while off: %d", c)
	}
	if c := do(h, "PUT", "/v1/config", "localhost:5", tok, `{"transports":[{"protocol":"openvpn"}]}`).Code; c != 400 {
		t.Fatalf("bad config: %d", c)
	}
	cfg := `{"handshakeTimeoutMs":300,"transports":[{"protocol":"wireguard","privateKey":"yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=","addresses":["10.66.0.2/32"],"peer":{"publicKey":"xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=","endpoint":"127.0.0.1:9"}}]}`
	w := do(h, "PUT", "/v1/config", "127.0.0.1:5", tok, cfg)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"configured":true`) {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if w := do(h, "DELETE", "/v1/config", "127.0.0.1:5", tok, ""); !strings.Contains(w.Body.String(), `"status":"off"`) {
		t.Fatalf("after delete: %s", w.Body)
	}
}

func TestEvents(t *testing.T) {
	eng := engine.New(nil)
	api := &API{Engine: eng, Socks: &socks.Server{Dialer: eng, Token: "x"}, Token: tok}
	srv := httptest.NewServer(api.Handler())
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/v1/events", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), "data: ") && strings.Contains(sc.Text(), `"status":"off"`) {
			return
		}
	}
	t.Fatal("no status event")
}
