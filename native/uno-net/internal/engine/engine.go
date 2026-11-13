// Package engine keeps one tunnel up out of the configured transports and
// tells everyone how it is. It is the SOCKS server's Dialer: while the tunnel
// is not up every dial fails — uno-net never sends anything around it.
//
//	off         no config, or stopped
//	connecting  trying transports; dials wait a little for the tunnel
//	on          a transport completed its handshake and answers probes
//	down        it was on, or every transport failed; dials fail at once
package engine

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/netip"
	"sync"
	"time"

	"github.com/technoob228/uno-work/native/uno-net/internal/config"
	"github.com/technoob228/uno-work/native/uno-net/internal/socks"
	"github.com/technoob228/uno-work/native/uno-net/internal/tunnel"
)

type Status string

const (
	Off        Status = "off"
	Connecting Status = "connecting"
	On         Status = "on"
	Down       Status = "down"
)

// staleHandshake: WireGuard rejects a session after 180s without a new
// handshake; past that nothing can pass.
const staleHandshake = 190 * time.Second

// Snapshot is the engine's state for the control API.
type Snapshot struct {
	Status         Status          `json:"status"`
	Configured     bool            `json:"configured"`
	ActiveProtocol config.Protocol `json:"activeProtocol,omitempty"`
	// Transport is the index of the transport in use; -1 when none.
	Transport     int        `json:"transport"`
	Endpoint      string     `json:"endpoint,omitempty"`
	Since         *time.Time `json:"since,omitempty"`
	LastHandshake *time.Time `json:"lastHandshake,omitempty"`
	RxBytes       uint64     `json:"rxBytes"`
	TxBytes       uint64     `json:"txBytes"`
	LatencyMs     *int64     `json:"latencyMs,omitempty"`
	Error         string     `json:"error,omitempty"`
}

// Engine runs the tunnel.
type Engine struct {
	log *slog.Logger
	// ConnectWait is how long a dial made while connecting waits for the
	// tunnel (default 10s).
	ConnectWait time.Duration

	mu        sync.Mutex
	cfg       *config.Config
	tun       *tunnel.Tunnel
	status    Status
	transport int
	since     time.Time
	latency   time.Duration
	hasRTT    bool
	lastErr   string
	preferred int
	changed   chan struct{}
	cancel    context.CancelFunc
	done      chan struct{}
	// kick asks the monitor for a probe now: a dial through the tunnel
	// just failed, maybe the exit is gone.
	kick chan struct{}
}

func New(log *slog.Logger) *Engine {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Engine{log: log, status: Off, transport: -1, changed: make(chan struct{}), kick: make(chan struct{}, 1)}
}

// Apply replaces the config and brings the tunnel up with it. Connections
// through the old tunnel end.
func (e *Engine) Apply(cfg *config.Config) {
	e.Stop()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	e.mu.Lock()
	e.cfg = cfg
	e.cancel = cancel
	e.done = done
	e.preferred = 0
	e.lastErr = ""
	e.setLocked(Connecting, nil, -1)
	e.mu.Unlock()
	go func() {
		defer close(done)
		e.run(ctx, cfg)
	}()
}

// Stop closes the tunnel; status becomes off.
func (e *Engine) Stop() {
	e.mu.Lock()
	cancel, done := e.cancel, e.done
	e.cancel, e.done = nil, nil
	e.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
	e.mu.Lock()
	e.cfg = nil
	e.lastErr = ""
	e.setLocked(Off, nil, -1)
	e.mu.Unlock()
}

// Snapshot reports the current state.
func (e *Engine) Snapshot() Snapshot {
	e.mu.Lock()
	s := Snapshot{
		Status:     e.status,
		Configured: e.cfg != nil,
		Transport:  e.transport,
		Error:      e.lastErr,
	}
	tun := e.tun
	if e.status == On {
		since := e.since
		s.Since = &since
		if e.hasRTT {
			ms := e.latency.Milliseconds()
			s.LatencyMs = &ms
		}
	}
	e.mu.Unlock()
	if tun != nil {
		s.ActiveProtocol = tun.Protocol
		s.Endpoint = tun.Endpoint.String()
		st := tun.Stats()
		s.RxBytes, s.TxBytes = st.RxBytes, st.TxBytes
		if !st.LastHandshake.IsZero() {
			h := st.LastHandshake
			s.LastHandshake = &h
		}
	}
	return s
}

// Changed returns a channel closed at the next status change.
func (e *Engine) Changed() <-chan struct{} {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.changed
}

// WaitStatus blocks until the status is one of want or ctx ends.
func (e *Engine) WaitStatus(ctx context.Context, want ...Status) (Status, error) {
	for {
		e.mu.Lock()
		st, ch := e.status, e.changed
		e.mu.Unlock()
		for _, w := range want {
			if st == w {
				return st, nil
			}
		}
		select {
		case <-ch:
		case <-ctx.Done():
			return st, ctx.Err()
		}
	}
}

// setLocked changes the state; tun is the tunnel dials may use (only when
// on). Caller holds e.mu.
func (e *Engine) setLocked(st Status, tun *tunnel.Tunnel, idx int) {
	if st == e.status && tun == e.tun && idx == e.transport {
		return
	}
	if st == On && e.status != On {
		e.since = time.Now()
	}
	if st != On {
		e.hasRTT = false
	}
	prev := e.status
	e.status, e.tun, e.transport = st, tun, idx
	close(e.changed)
	e.changed = make(chan struct{})
	if prev != st {
		e.log.Info("network status", "status", string(st), "transport", idx)
	}
}

func (e *Engine) set(st Status, tun *tunnel.Tunnel, idx int, errMsg string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if errMsg != "" {
		e.lastErr = errMsg
	} else if st == On {
		e.lastErr = ""
	}
	e.setLocked(st, tun, idx)
}

func (e *Engine) run(ctx context.Context, cfg *config.Config) {
	backoff := time.Second
	for ctx.Err() == nil {
		e.mu.Lock()
		start := e.preferred
		e.mu.Unlock()
		n := len(cfg.Transports)
		roundUp := false
		for k := 0; k < n && ctx.Err() == nil; k++ {
			idx := (start + k) % n
			if e.attempt(ctx, cfg, idx) {
				roundUp = true
				backoff = time.Second
				e.mu.Lock()
				e.preferred = idx
				e.mu.Unlock()
				break // after a drop, start again with what worked
			}
		}
		if ctx.Err() != nil {
			return
		}
		if !roundUp {
			// Every transport failed: down, not connecting, so dials stop
			// waiting. Keep trying.
			e.set(Down, nil, -1, "")
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			if backoff < 15*time.Second {
				backoff *= 2
			}
		}
	}
}

// attempt brings up one transport, waits for its handshake and keeps it
// while healthy. Returns whether it ever came up.
func (e *Engine) attempt(ctx context.Context, cfg *config.Config, idx int) bool {
	t := cfg.Transports[idx]
	tun, err := tunnel.Up(ctx, t, e.log.With("transport", idx, "protocol", string(t.Protocol)))
	if err != nil {
		e.mu.Lock()
		e.lastErr = err.Error()
		e.mu.Unlock()
		e.log.Warn("transport failed to start", "transport", idx, "err", err)
		return false
	}
	defer tun.Close()

	if !e.awaitHandshake(ctx, tun, cfg.HandshakeTimeout()) {
		e.mu.Lock()
		e.lastErr = "no handshake with " + tun.Endpoint.String() + " over " + string(t.Protocol)
		e.mu.Unlock()
		return false
	}
	probe := probeTarget(cfg, tun)
	// One probe before saying "on": the handshake proves the exit has our
	// key, the probe proves traffic gets through it.
	if rtt, ok := e.probe(ctx, tun, probe, cfg.ProbeInterval()); ok {
		e.mu.Lock()
		e.latency, e.hasRTT = rtt, true
		e.mu.Unlock()
	} else if ctx.Err() == nil {
		e.mu.Lock()
		e.lastErr = "handshake done but nothing gets through " + tun.Endpoint.String()
		e.mu.Unlock()
		return false
	}
	e.set(On, tun, idx, "")
	e.monitor(ctx, cfg, tun, probe)
	if ctx.Err() == nil {
		// Fail closed right away: dials stop before the next attempt.
		e.set(Down, nil, -1, "")
	}
	return true
}

func (e *Engine) awaitHandshake(ctx context.Context, tun *tunnel.Tunnel, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for time.Now().Before(deadline) {
		if !tun.Stats().LastHandshake.IsZero() {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-tick.C:
		}
	}
	return false
}

func probeTarget(cfg *config.Config, tun *tunnel.Tunnel) netip.Addr {
	if cfg.Probe != "" {
		return netip.MustParseAddr(cfg.Probe)
	}
	return tun.DNS()[0]
}

// probe: an ICMP echo through the tunnel; where the exit drops ICMP, a DNS
// lookup through it counts too.
func (e *Engine) probe(ctx context.Context, tun *tunnel.Tunnel, target netip.Addr, interval time.Duration) (time.Duration, bool) {
	// Short: an exit that does not answer a ping in 2 s is not one to keep
	// waiting on, and a failed probe is retried within a second anyway.
	timeout := interval / 2
	if timeout > 2*time.Second {
		timeout = 2 * time.Second
	}
	pctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// Ping and a DNS lookup at once; the first that answers wins.
	type result struct {
		rtt time.Duration
		ok  bool
	}
	res := make(chan result, 2)
	start := time.Now()
	go func() {
		rtt, err := tun.Ping(pctx, target)
		res <- result{rtt, err == nil}
	}()
	go func() {
		_, err := tun.LookupHost(pctx, "uno.place")
		res <- result{time.Since(start), err == nil}
	}()
	for k := 0; k < 2; k++ {
		if r := <-res; r.ok {
			return r.rtt, true
		}
	}
	return 0, false
}

func (e *Engine) monitor(ctx context.Context, cfg *config.Config, tun *tunnel.Tunnel, probe netip.Addr) {
	interval := cfg.ProbeInterval()
	limit := cfg.ProbeFailureLimit()
	tick := time.NewTicker(interval)
	defer tick.Stop()
	failures := 0
	var lastKick time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		case <-e.kick:
			// At most one extra probe a second, however many dials fail.
			if time.Since(lastKick) < time.Second {
				continue
			}
			lastKick = time.Now()
		}
		if hs := tun.Stats().LastHandshake; !hs.IsZero() && time.Since(hs) > staleHandshake {
			e.mu.Lock()
			e.lastErr = "the exit stopped answering (no handshake for 3 minutes)"
			e.mu.Unlock()
			return
		}
		rtt, ok := e.probe(ctx, tun, probe, interval)
		if ctx.Err() != nil {
			return
		}
		if ok {
			failures = 0
			e.mu.Lock()
			e.latency, e.hasRTT = rtt, true
			e.mu.Unlock()
			continue
		}
		failures++
		e.log.Debug("probe failed", "failures", failures)
		if failures >= limit {
			e.mu.Lock()
			e.lastErr = "the exit stopped answering"
			e.mu.Unlock()
			return
		}
		// After a miss, ask again soon instead of a whole interval later.
		e.Kick()
		lastKick = time.Time{}
		select {
		case <-ctx.Done():
			return
		case <-time.After(retryAfterMiss(interval)):
		}
	}
}

func retryAfterMiss(interval time.Duration) time.Duration {
	if d := interval / 5; d < time.Second {
		return d
	}
	return time.Second
}

// current returns the tunnel if it is up; while connecting it waits up to
// ConnectWait (or ctx) for it.
func (e *Engine) current(ctx context.Context) (*tunnel.Tunnel, error) {
	wait := e.ConnectWait
	if wait <= 0 {
		wait = 10 * time.Second
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		e.mu.Lock()
		st, tun, ch := e.status, e.tun, e.changed
		e.mu.Unlock()
		switch st {
		case On:
			return tun, nil
		case Connecting:
		default:
			return nil, socks.ErrDown
		}
		select {
		case <-ch:
		case <-timer.C:
			return nil, socks.ErrDown
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// DialContext implements socks.Dialer.
func (e *Engine) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	tun, err := e.current(ctx)
	if err != nil {
		return nil, err
	}
	c, err := tun.DialContext(ctx, network, address)
	if err != nil {
		if e.Snapshot().Status != On {
			return nil, errors.Join(socks.ErrDown, err)
		}
		e.Kick()
	}
	return c, err
}

// Kick asks for a health probe now (rate-limited).
func (e *Engine) Kick() {
	select {
	case e.kick <- struct{}{}:
	default:
	}
}

// ListenUDP implements socks.Dialer.
func (e *Engine) ListenUDP(ctx context.Context, v6 bool) (net.PacketConn, error) {
	tun, err := e.current(ctx)
	if err != nil {
		return nil, err
	}
	return tun.ListenUDP(v6)
}

// LookupHost implements socks.Dialer.
func (e *Engine) LookupHost(ctx context.Context, host string) ([]string, error) {
	tun, err := e.current(ctx)
	if err != nil {
		return nil, err
	}
	return tun.LookupHost(ctx, host)
}
