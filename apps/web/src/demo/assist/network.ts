/**
 * Network (12.11.2026): what a computer's daemon answers on
 * `/api/manager/network` in the demo — the exits it can use, the protocol,
 * the account's computers and the switch, kept in memory per computer, in the
 * wire shape of `lib/networkApi.ts`. Turning it on (or moving it to another
 * exit or protocol) takes ~1.5 s ("Connecting…"); an offline exit reads "down".
 *
 * Address params: `net=off|on|down` — where it starts (off by default);
 * `vpn=cisco` — this Mac is already on a corporate VPN;
 * `perm=ask` — macOS hasn't allowed Uno Work's network extension yet
 *   (allowing takes ~1.2 s in the demo, as if the person clicked Allow);
 * `tunnel=0` — a daemon without the tunnel yet (what ships first, 26.11):
 *   the person's proxy is the only exit;
 * `proxy=saved|on|down` — a proxy is already saved (and on / not answering);
 * `tunnel=app` — what ships first with the tunnel (27.11): Uno Work's own
 *   apps go through it (not strict), the exits are the account's cloud
 *   computer and pasted WireGuard configs; Uno addresses are "Coming soon".
 * A proxy whose host has "bad" in it fails its check. All addresses are made up.
 */
import { HttpResponse, http, type HttpHandler } from "msw";

import type {
  NetworkComputer,
  NetworkExit,
  NetworkProtocol,
  NetworkProxyCheck,
  NetworkProxyInfo,
  NetworkProxyInput,
  NetworkState,
  NetworkStatus,
  NetworkTransport,
} from "../../lib/networkApi";

const ALL: ReadonlyArray<NetworkTransport> = ["wireguard", "amneziawg", "openvpn"];

const EXITS: ReadonlyArray<NetworkExit> = [
  {
    id: "uno-de",
    kind: "uno",
    label: "Germany",
    country: "DE",
    city: "Frankfurt",
    address: "85.214.132.7",
    latencyMs: 38,
    online: true,
    addressType: "clean",
    protocols: ALL,
  },
  {
    id: "uno-fr",
    kind: "uno",
    label: "France",
    country: "FR",
    city: "Paris",
    address: "89.105.201.14",
    latencyMs: 41,
    online: true,
    addressType: "clean",
    protocols: ALL,
  },
  {
    id: "uno-us",
    kind: "uno",
    label: "United States",
    country: "US",
    city: "New York",
    address: "172.58.14.220",
    latencyMs: 96,
    online: true,
    addressType: "clean",
    protocols: ALL,
  },
  {
    id: "box-work",
    kind: "computer",
    label: "uno-work",
    country: "NL",
    city: null,
    address: "51.15.88.4",
    latencyMs: 44,
    online: true,
    addressType: "datacenter",
    protocols: ALL,
  },
  {
    id: "srv-ams",
    kind: "server",
    label: "VPS Amsterdam",
    country: "NL",
    city: null,
    address: "185.212.47.9",
    latencyMs: 47,
    online: true,
    addressType: "datacenter",
    protocols: ALL,
  },
  {
    id: "cfg-home",
    kind: "config",
    label: "Home router",
    country: "AR",
    city: null,
    address: "181.47.22.130",
    latencyMs: 12,
    online: true,
    addressType: "clean",
    protocols: ["openvpn"],
  },
  {
    id: "cfg-office",
    kind: "config",
    label: "Office WireGuard",
    country: "PL",
    city: null,
    address: "31.11.42.7",
    latencyMs: null,
    online: false,
    addressType: "unknown",
    protocols: ["wireguard"],
  },
];

/** `tunnel=app`: the account's cloud computer, Uno addresses still to come. */
const APP_EXITS: ReadonlyArray<NetworkExit> = [
  {
    id: "box-2531",
    kind: "computer",
    label: "stage-work",
    country: "NL",
    city: null,
    address: "46.17.102.25",
    latencyMs: 6,
    online: true,
    addressType: "datacenter",
    protocols: ["wireguard", "amneziawg"],
    note: null,
  },
  {
    id: "uno-17",
    kind: "uno",
    label: "Germany",
    country: "DE",
    city: "Frankfurt",
    address: null,
    latencyMs: null,
    online: false,
    addressType: "clean",
    protocols: ["wireguard", "amneziawg"],
    note: "Coming soon",
  },
];

const CONNECT_MS = 1_500;

interface Switch {
  enabled: boolean;
  exitId: string;
  protocol: NetworkProtocol;
  /** When it was last turned on or moved to another exit or protocol. */
  at: number;
  /** `net=down`: the exit stops answering whatever it is. */
  forcedDown: boolean;
  otherVpn: { name: string } | null;
  /** null — allowed; else when the person asked macOS (0 — not yet). */
  permissionAskedAt: number | null;
  tunnel: boolean;
  /** `tunnel=app`: app-level (not strict), configs can be pasted. */
  app: boolean;
  configs: NetworkExit[];
  proxy: Omit<NetworkProxyInfo, "check" | "alwaysDirect"> | null;
  proxyCheck: NetworkProxyCheck | null;
}

const ALWAYS_DIRECT = ["localhost", "127.0.0.1", "::1", ".local", "192.168.0.0/16", "uno.place"];
const PROXY_CHECK_MS = 900;
const SAMPLE_PROXY = {
  scheme: "http" as const,
  host: "de.proxy-seller.example",
  port: 8080,
  username: "misha",
  hasPassword: true,
  skip: [],
};

function demoCheck(proxy: { host: string }): NetworkProxyCheck {
  const at = new Date().toISOString();
  if (/bad/i.test(proxy.host)) {
    return { status: "failed", reason: "The proxy doesn't answer at this address and port.", at };
  }
  return { status: "ok", ip: "185.199.110.42", country: "DE", latencyMs: 142, at };
}

function proxyExit(current: Switch): NetworkExit | null {
  if (!current.proxy) return null;
  const check = current.proxyCheck;
  return {
    id: "proxy",
    kind: "proxy",
    label: `${current.proxy.host}:${current.proxy.port}`,
    country: check?.status === "ok" ? check.country : null,
    city: null,
    address: check?.status === "ok" ? check.ip : null,
    latencyMs: check?.status === "ok" ? check.latencyMs : null,
    online: check?.status !== "failed",
    addressType: "unknown",
    protocols: [],
  };
}

function exitsOf(current: Switch): ReadonlyArray<NetworkExit> {
  const proxy = proxyExit(current);
  const tunnel = current.app ? [...APP_EXITS, ...current.configs] : current.tunnel ? EXITS : [];
  return [...tunnel, ...(proxy ? [proxy] : [])];
}

const ALLOW_MS = 1_200;

function permissionNeeded(current: Switch): boolean {
  return (
    current.permissionAskedAt !== null &&
    (current.permissionAskedAt === 0 || Date.now() - current.permissionAskedAt < ALLOW_MS)
  );
}

const byHost = new Map<string, Switch>();

function startOf(): Switch {
  const params = typeof location === "undefined" ? null : new URLSearchParams(location.search);
  const asked = params?.get("net") ?? null;
  const tunnel = params?.get("tunnel") !== "0";
  const app = params?.get("tunnel") === "app";
  const proxy = params?.get("proxy") ?? null;
  const proxyDown = proxy === "down";
  return {
    tunnel,
    app,
    configs: [],
    proxy: proxy ? { ...SAMPLE_PROXY, ...(proxyDown ? { host: "bad.proxy.example" } : {}) } : null,
    proxyCheck: proxy ? demoCheck(proxyDown ? { host: "bad" } : SAMPLE_PROXY) : null,
    enabled: asked === "on" || asked === "down" || proxy === "on" || proxyDown,
    exitId: proxy === "on" || proxyDown || !tunnel ? "proxy" : app ? "box-2531" : "uno-de",
    protocol: "auto",
    // Started "on": connected a week ago.
    at: Date.now() - 7 * 86_400_000,
    forcedDown: asked === "down",
    otherVpn: params?.get("vpn") === "cisco" ? { name: "Cisco Secure Client" } : null,
    permissionAskedAt: params?.get("perm") === "ask" ? 0 : null,
  };
}

function switchOf(host: string): Switch {
  let current = byHost.get(host);
  if (!current) {
    current = startOf();
    byHost.set(host, current);
  }
  return current;
}

/** What `auto` lands on: WireGuard where the exit carries it, else what it has. */
function transportOf(current: Switch, exit: NetworkExit | null): NetworkTransport | null {
  if (!current.enabled || !exit) return null;
  if (current.protocol !== "auto") return current.protocol;
  return exit.protocols.includes("wireguard") ? "wireguard" : (exit.protocols[0] ?? null);
}

function computersOf(status: NetworkStatus, waiting: boolean): ReadonlyArray<NetworkComputer> {
  return [
    {
      id: "this",
      name: "MacBook Pro",
      current: true,
      kind: "desktop",
      status: waiting ? "permission" : status,
    },
    {
      id: "box-work",
      name: "uno-work",
      current: false,
      kind: "cloud",
      // The cloud doesn't wait for the Mac's permission.
      status: waiting && status === "connecting" ? "on" : status,
    },
    { id: "box-product", name: "uno-product", current: false, kind: "cloud", status: "asleep" },
  ];
}

function stateOf(current: Switch): NetworkState {
  const exits = exitsOf(current);
  const exit = exits.find((item) => item.id === current.exitId) ?? null;
  const needed = permissionNeeded(current);
  if (!needed && current.permissionAskedAt !== null) {
    // Allowed just now: the tunnel comes up from here.
    current.permissionAskedAt = null;
    current.at = Date.now();
  }
  const waiting = current.enabled && needed;
  let status: NetworkStatus = "off";
  const viaProxy = exit?.kind === "proxy";
  if (current.enabled && exit) {
    if (current.forcedDown || !exit.online) status = "down";
    else if (waiting && !viaProxy) status = "connecting";
    else
      status =
        Date.now() - current.at < (viaProxy ? PROXY_CHECK_MS : CONNECT_MS) ? "connecting" : "on";
  }
  return {
    available: true,
    tunnel: current.tunnel,
    enabled: current.enabled && exit !== null,
    status,
    exitId: exit ? current.exitId : null,
    exits,
    protocol: current.protocol,
    activeProtocol: status === "on" && !viaProxy ? transportOf(current, exit) : null,
    computers: computersOf(status, waiting && !viaProxy).slice(0, current.tunnel ? 3 : 1),
    strict: !current.app,
    canImport: current.app,
    reason:
      status === "down" && current.app && exit
        ? `${exit.label} stopped answering.`
        : status === "connecting" && current.app && exit?.kind === "computer"
          ? `Uno is setting up ${exit.label} as an exit.`
          : null,
    permission: needed && !viaProxy ? "needed" : "granted",
    otherVpn: current.otherVpn,
    since: current.enabled ? new Date(current.at).toISOString() : null,
    proxy: current.proxy
      ? { ...current.proxy, alwaysDirect: ALWAYS_DIRECT, check: current.proxyCheck }
      : null,
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PROTOCOLS: ReadonlyArray<NetworkProtocol> = ["auto", ...ALL];

export function networkHandlers(): HttpHandler[] {
  return [
    http.get("*/api/manager/network", ({ request }) =>
      HttpResponse.json(stateOf(switchOf(new URL(request.url).host))),
    ),
    http.post("*/api/manager/network/check", async ({ request }) => {
      const current = switchOf(new URL(request.url).host);
      const body = (await request.json().catch(() => ({}))) as { proxy?: NetworkProxyInput };
      const typed = body.proxy ?? current.proxy;
      if (!typed) return HttpResponse.json({ error: "Add a proxy first." }, { status: 400 });
      await wait(PROXY_CHECK_MS);
      const check = demoCheck(typed);
      if (!body.proxy) current.proxyCheck = check;
      return HttpResponse.json(check);
    }),
    http.post("*/api/manager/network", async ({ request }) => {
      const current = switchOf(new URL(request.url).host);
      const body = (await request.json().catch(() => ({}))) as {
        enabled?: unknown;
        exitId?: unknown;
        protocol?: unknown;
        askPermission?: unknown;
        proxy?: NetworkProxyInput | null;
        importConfig?: { conf: string; label?: string };
        removeExitId?: unknown;
      };
      if (body.importConfig && current.app) {
        const conf = body.importConfig.conf;
        if (!/\[Interface\]/i.test(conf) || !/\[Peer\]/i.test(conf)) {
          return HttpResponse.json(
            {
              error: "This doesn't look like a WireGuard config: it needs [Interface] and [Peer].",
            },
            { status: 400 },
          );
        }
        await wait(600);
        const host = /Endpoint\s*=\s*([^:\s]+)/i.exec(conf)?.[1] ?? null;
        const config: NetworkExit = {
          id: `config-${current.configs.length + 1}`,
          kind: "config",
          label: body.importConfig.label || host || "WireGuard config",
          country: null,
          city: null,
          address: host,
          latencyMs: 31,
          online: true,
          addressType: "unknown",
          protocols: [/Jc\s*=/i.test(conf) ? "amneziawg" : "wireguard"],
          removable: true,
        };
        current.configs.push(config);
        current.exitId = config.id;
        current.enabled = true;
        current.forcedDown = false;
        current.at = Date.now();
      }
      if (typeof body.removeExitId === "string") {
        current.configs = current.configs.filter((item) => item.id !== body.removeExitId);
        if (current.exitId === body.removeExitId) {
          current.exitId = "box-2531";
          current.enabled = false;
        }
      }
      if (body.proxy === null) {
        current.proxy = null;
        current.proxyCheck = null;
        if (current.exitId === "proxy") current.enabled = false;
        if (!current.tunnel) current.enabled = false;
      } else if (body.proxy) {
        const typed = body.proxy;
        if (!/^[a-z0-9.-]+$/i.test(typed.host.trim())) {
          return HttpResponse.json(
            { error: "Enter the proxy's host name or IP." },
            { status: 400 },
          );
        }
        await wait(PROXY_CHECK_MS);
        current.proxy = {
          scheme: typed.scheme,
          host: typed.host.trim(),
          port: typed.port,
          username: typed.username ?? null,
          hasPassword: typed.password
            ? true
            : (typed.password === undefined && current.proxy?.hasPassword) || false,
          skip: typed.skip?.flatMap((item) => item.split(/[\s,]+/)).filter(Boolean) ?? [],
        };
        current.proxyCheck = demoCheck(current.proxy);
        current.exitId = "proxy";
        current.forcedDown = false;
        current.at = Date.now() - PROXY_CHECK_MS;
      }
      if (body.askPermission === true && current.permissionAskedAt === 0) {
        current.permissionAskedAt = Date.now();
      }
      if (typeof body.exitId === "string") {
        const exit = exitsOf(current).find((item) => item.id === body.exitId);
        if (!exit) return HttpResponse.json({ error: "unknown exit" }, { status: 400 });
        current.exitId = exit.id;
        // A config carries only its own protocol: picking it moves the protocol along.
        if (current.protocol !== "auto" && !exit.protocols.includes(current.protocol)) {
          current.protocol = "auto";
        }
        current.enabled = true;
        current.forcedDown = false;
        current.at = Date.now();
      }
      if (typeof body.protocol === "string") {
        const protocol = PROTOCOLS.find((item) => item === body.protocol);
        if (!protocol) return HttpResponse.json({ error: "unknown protocol" }, { status: 400 });
        if (protocol !== current.protocol) {
          current.protocol = protocol;
          if (current.enabled) current.at = Date.now();
        }
      }
      if (typeof body.enabled === "boolean" && body.enabled !== current.enabled) {
        current.enabled = body.enabled;
        current.forcedDown = false;
        current.at = Date.now();
      }
      return HttpResponse.json(stateOf(current));
    }),
  ];
}
