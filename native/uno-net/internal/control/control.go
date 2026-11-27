// Package control is the HTTP API the Work daemon drives uno-net with, on
// loopback with a bearer token:
//
//	GET    /v1/status  engine state + SOCKS address and counters
//	GET    /v1/health  200 when on, 503 otherwise (same body)
//	GET    /v1/events  server-sent events: the status at every change
//	PUT    /v1/config  replace the config (JSON, see package config); tunnel restarts
//	DELETE /v1/config  stop: status off, nothing goes out
package control

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/technoob228/uno-work/native/uno-net/internal/config"
	"github.com/technoob228/uno-work/native/uno-net/internal/engine"
	"github.com/technoob228/uno-work/native/uno-net/internal/socks"
)

type Status struct {
	engine.Snapshot
	Version string         `json:"version"`
	Socks   string         `json:"socks"`
	Flows   socks.Counters `json:"flows"`
}

type API struct {
	Engine    *engine.Engine
	Socks     *socks.Server
	SocksAddr string
	Token     string
	Version   string
	Log       *slog.Logger
}

const maxConfigBytes = 1 << 20

func (a *API) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, a.status())
	})
	mux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, r *http.Request) {
		st := a.status()
		code := http.StatusOK
		if st.Status != engine.On {
			code = http.StatusServiceUnavailable
		}
		writeJSON(w, code, st)
	})
	mux.HandleFunc("GET /v1/events", a.events)
	mux.HandleFunc("PUT /v1/config", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, maxConfigBytes+1))
		if err != nil || len(body) > maxConfigBytes {
			writeError(w, http.StatusBadRequest, "config too large or unreadable")
			return
		}
		cfg, err := config.Parse(body)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		a.Engine.Apply(cfg)
		writeJSON(w, http.StatusOK, a.status())
	})
	mux.HandleFunc("DELETE /v1/config", func(w http.ResponseWriter, r *http.Request) {
		a.Engine.Stop()
		writeJSON(w, http.StatusOK, a.status())
	})
	return a.auth(mux)
}

func (a *API) status() Status {
	return Status{Snapshot: a.Engine.Snapshot(), Version: a.Version, Socks: a.SocksAddr, Flows: a.Socks.Counters()}
}

func (a *API) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Loopback only, and no browser may drive it: a page cannot set
		// Authorization on a cross-origin request without a preflight we
		// never answer, and Host must be the loopback address itself.
		if !isLoopbackHost(r.Host) {
			writeError(w, http.StatusForbidden, "forbidden")
			return
		}
		got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || subtle.ConstantTimeCompare([]byte(got), []byte(a.Token)) != 1 {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isLoopbackHost(host string) bool {
	h := host
	if i := strings.LastIndex(h, ":"); i >= 0 && !strings.HasSuffix(h, "]") {
		h = h[:i]
	}
	h = strings.Trim(h, "[]")
	return h == "127.0.0.1" || h == "::1" || h == "localhost"
}

func (a *API) events(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "no streaming")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()
	for {
		ch := a.Engine.Changed()
		b, _ := json.Marshal(a.status())
		if _, err := fmt.Fprintf(w, "event: status\ndata: %s\n\n", b); err != nil {
			return
		}
		fl.Flush()
	wait:
		select {
		case <-r.Context().Done():
			return
		case <-ch:
		case <-keepalive.C:
			if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
				return
			}
			fl.Flush()
			goto wait
		}
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
