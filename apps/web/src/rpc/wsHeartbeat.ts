/**
 * Liveness tuning for every WebSocket RPC connection, in one place.
 *
 * Tuned for slow-but-alive links (RTT 250-550 ms, jitter, multi-second
 * stalls): a pong can queue behind a large frame (a full snapshot) for
 * seconds, so any inbound frame counts as proof of life and the socket is
 * only declared dead after a long stretch of total silence.
 */

export interface WsHeartbeatConfig {
  /** A ping is written this often. */
  readonly intervalMs: number;
  /** Dead after this many consecutive intervals without any inbound data. */
  readonly maxSilentIntervals: number;
}

export const WS_HEARTBEAT_INTERVAL_MS = 10_000;
export const WS_HEARTBEAT_MAX_SILENT_INTERVALS = 3;

/** 10 s pings, dead after 30-40 s of zero inbound data. */
export const DEFAULT_WS_HEARTBEAT: WsHeartbeatConfig = Object.freeze({
  intervalMs: WS_HEARTBEAT_INTERVAL_MS,
  maxSilentIntervals: WS_HEARTBEAT_MAX_SILENT_INTERVALS,
});

/** Opening a socket over a slow link (TCP + TLS + upgrade) can take seconds. */
export const WS_OPEN_TIMEOUT_MS = 20_000;

/**
 * Inbound traffic newer than this proves the socket alive: focus, visibility
 * and pageshow leave such a socket alone instead of tearing it down.
 */
export const WS_RECENT_INBOUND_MS = 15_000;

/**
 * A resume probe waits this long for any inbound frame (at least one ping
 * round trip) before deciding the socket is dead and reconnecting.
 */
export const WS_LIVENESS_PROBE_TIMEOUT_MS = WS_HEARTBEAT_INTERVAL_MS + 10_000;
