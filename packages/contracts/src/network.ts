import { Schema } from "effect";

// ===============================
// Network (12.11.2026; proxy 26.11.2026)
// ===============================
//
// The sidebar's shield: from where Uno Work goes online. The daemon's
// `/api/manager/network` is the whole contract (`apps/server/src/network/`).
//
// Two kinds of exits:
// - a tunnel (Uno's addresses, the person's computers and servers, imported
//   configs) — WireGuard / AmneziaWG / OpenVPN; on a Mac it needs the app's
//   network extension. Not in this daemon yet: `tunnel: false`.
// - a proxy the person brings (HTTP, HTTPS or SOCKS5; Misha, 26.11: "add a
//   proxy, set up in the app's environment"). Everything Uno Work starts on
//   this computer — agents, terminals, the apps and dev servers it runs —
//   gets it in its environment (HTTP_PROXY / HTTPS_PROXY / ALL_PROXY /
//   NO_PROXY), pointing at a local bridge of the daemon: the proxy's password
//   stays in the daemon, never in a child's environment, a config or a log.

export const NETWORK_PROXY_EXIT_ID = "proxy";

/** How the person's proxy is spoken to. `https` — TLS to the proxy itself. */
export const NetworkProxyScheme = Schema.Literals(["http", "https", "socks5"]);
export type NetworkProxyScheme = typeof NetworkProxyScheme.Type;

export const NETWORK_PROXY_HOST_MAX_CHARS = 253;
export const NETWORK_PROXY_CREDENTIAL_MAX_CHARS = 255;
/** Hosts the person adds to "Skip for" (beyond localhost and Uno's own). */
export const NETWORK_PROXY_SKIP_MAX = 32;

/** What the person types in the proxy form. */
export const NetworkProxyInput = Schema.Struct({
  scheme: NetworkProxyScheme,
  host: Schema.String.check(Schema.isMaxLength(NETWORK_PROXY_HOST_MAX_CHARS)),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  /** Empty or absent: no login. */
  username: Schema.optional(
    Schema.String.check(Schema.isMaxLength(NETWORK_PROXY_CREDENTIAL_MAX_CHARS)),
  ),
  /**
   * Absent: keep the saved one (the form never gets it back). Empty string:
   * no password.
   */
  password: Schema.optional(
    Schema.String.check(Schema.isMaxLength(NETWORK_PROXY_CREDENTIAL_MAX_CHARS)),
  ),
  /** Extra hosts that go direct ("*.corp.example", "10.0.0.0/8"). */
  skip: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(NETWORK_PROXY_HOST_MAX_CHARS))).check(
      Schema.isMaxLength(NETWORK_PROXY_SKIP_MAX),
    ),
  ),
});
export type NetworkProxyInput = typeof NetworkProxyInput.Type;

/**
 * The last "Check": an address echo fetched through the proxy.
 * `failed.reason` is a sentence for the person.
 */
export const NetworkProxyCheck = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    /** The address sites see. */
    ip: Schema.String,
    /** ISO 3166 alpha-2, null when the echo didn't say. */
    country: Schema.NullOr(Schema.String),
    latencyMs: Schema.Number,
    at: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: Schema.String,
    at: Schema.String,
  }),
]);
export type NetworkProxyCheck = typeof NetworkProxyCheck.Type;

/** The saved proxy as the form shows it: never the password. */
export const NetworkProxyInfo = Schema.Struct({
  scheme: NetworkProxyScheme,
  host: Schema.String,
  port: Schema.Number,
  username: Schema.NullOr(Schema.String),
  hasPassword: Schema.Boolean,
  skip: Schema.Array(Schema.String),
  /** Always direct, whatever the person adds: loopback and Uno's own hosts. */
  alwaysDirect: Schema.Array(Schema.String),
  check: Schema.NullOr(NetworkProxyCheck),
});
export type NetworkProxyInfo = typeof NetworkProxyInfo.Type;

export const NetworkExitKind = Schema.Literals(["uno", "computer", "server", "config", "proxy"]);
export type NetworkExitKind = typeof NetworkExitKind.Type;

/**
 * How the tunnel to the exit is carried. `auto` tries WireGuard, then
 * AmneziaWG where WireGuard is blocked, then OpenVPN over TCP 443.
 */
export const NetworkProtocol = Schema.Literals(["auto", "wireguard", "amneziawg", "openvpn"]);
export type NetworkProtocol = typeof NetworkProtocol.Type;
export const NetworkTransport = Schema.Literals(["wireguard", "amneziawg", "openvpn"]);
export type NetworkTransport = typeof NetworkTransport.Type;

export const NetworkAddressType = Schema.Literals(["clean", "datacenter", "unknown"]);
export type NetworkAddressType = typeof NetworkAddressType.Type;

export const NetworkExit = Schema.Struct({
  id: Schema.String,
  kind: NetworkExitKind,
  /** "Germany", "uno-work", "VPS Amsterdam", "proxy.example.com". */
  label: Schema.String,
  /** ISO 3166 alpha-2 of where the address is ("DE"); null when unknown. */
  country: Schema.NullOr(Schema.String),
  city: Schema.NullOr(Schema.String),
  /** The public address sites see; null until known. */
  address: Schema.NullOr(Schema.String),
  /** Round trip from this computer, ms; null when not measured or unreachable. */
  latencyMs: Schema.NullOr(Schema.Number),
  online: Schema.Boolean,
  /**
   * Who the address belongs to, as sites see it: `clean` — a home internet
   * provider; `datacenter` — a hosting company; `unknown` — not checked.
   */
  addressType: NetworkAddressType,
  /** What it can carry. An imported config carries only its own; a proxy none. */
  protocols: Schema.Array(NetworkTransport),
});
export type NetworkExit = typeof NetworkExit.Type;

/**
 * off — the computer's own connection;
 * connecting — turned on, the tunnel (or the proxy check) is coming up;
 * on — what Uno Work starts goes out through the exit;
 * down — turned on but the exit doesn't answer: nothing goes out (no leak).
 */
export const NetworkStatus = Schema.Literals(["off", "connecting", "on", "down"]);
export type NetworkStatus = typeof NetworkStatus.Type;

export const NetworkComputer = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** The computer this daemon runs on. */
  current: Schema.Boolean,
  /** cloud — all its traffic goes through a tunnel exit; desktop — what Uno Work starts. */
  kind: Schema.Literals(["cloud", "desktop"]),
  /**
   * asleep — joins with Network as it is when it wakes;
   * permission — waits for the person to allow the network extension once.
   */
  status: Schema.Union([NetworkStatus, Schema.Literals(["asleep", "permission"])]),
});
export type NetworkComputer = typeof NetworkComputer.Type;

export const NetworkState = Schema.Struct({
  available: Schema.Boolean,
  /** The daemon can carry tunnel exits (WireGuard / AmneziaWG / OpenVPN). */
  tunnel: Schema.Boolean,
  enabled: Schema.Boolean,
  status: NetworkStatus,
  exitId: Schema.NullOr(Schema.String),
  exits: Schema.Array(NetworkExit),
  protocol: NetworkProtocol,
  /** What carries the tunnel right now (what `auto` picked); null while off or on a proxy. */
  activeProtocol: Schema.NullOr(NetworkTransport),
  computers: Schema.Array(NetworkComputer),
  /** needed — this computer's network extension isn't allowed yet. */
  permission: Schema.Literals(["granted", "needed"]),
  /** Another VPN already on this computer (corporate, personal); Uno goes through it. */
  otherVpn: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  /** Since when it has been on (ISO), for "on since". */
  since: Schema.NullOr(Schema.String),
  /** The person's proxy on this computer; null — none saved. */
  proxy: Schema.NullOr(NetworkProxyInfo),
});
export type NetworkState = typeof NetworkState.Type;

/** `POST /api/manager/network`. */
export const NetworkChangeInput = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  exitId: Schema.optional(Schema.String),
  protocol: Schema.optional(NetworkProtocol),
  /** Ask the system to allow the network extension (macOS shows its own prompt). */
  askPermission: Schema.optional(Schema.Boolean),
  /** Save the proxy (and check it); null — forget it (Network goes off if it was on it). */
  proxy: Schema.optional(Schema.NullOr(NetworkProxyInput)),
});
export type NetworkChangeInput = typeof NetworkChangeInput.Type;

/** `POST /api/manager/network/check`: the saved proxy, or the one typed in the form (not saved). */
export const NetworkCheckInput = Schema.Struct({
  proxy: Schema.optional(NetworkProxyInput),
});
export type NetworkCheckInput = typeof NetworkCheckInput.Type;
