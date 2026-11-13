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
 *   (allowing takes ~1.2 s in the demo, as if the person clicked Allow).
 * All addresses are made up.
 */
import { HttpResponse, http, type HttpHandler } from "msw";

import type {
  NetworkComputer,
  NetworkExit,
  NetworkProtocol,
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
  return {
    enabled: asked === "on" || asked === "down",
    exitId: "uno-de",
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
  const exit = EXITS.find((item) => item.id === current.exitId) ?? null;
  const needed = permissionNeeded(current);
  if (!needed && current.permissionAskedAt !== null) {
    // Allowed just now: the tunnel comes up from here.
    current.permissionAskedAt = null;
    current.at = Date.now();
  }
  const waiting = current.enabled && needed;
  let status: NetworkStatus = "off";
  if (current.enabled) {
    if (current.forcedDown || !exit?.online) status = "down";
    else if (waiting) status = "connecting";
    else status = Date.now() - current.at < CONNECT_MS ? "connecting" : "on";
  }
  return {
    available: true,
    enabled: current.enabled,
    status,
    exitId: current.exitId,
    exits: EXITS,
    protocol: current.protocol,
    activeProtocol: status === "on" ? transportOf(current, exit) : null,
    computers: computersOf(status, waiting),
    permission: needed ? "needed" : "granted",
    otherVpn: current.otherVpn,
    since: current.enabled ? new Date(current.at).toISOString() : null,
  };
}

const PROTOCOLS: ReadonlyArray<NetworkProtocol> = ["auto", ...ALL];

export function networkHandlers(): HttpHandler[] {
  return [
    http.get("*/api/manager/network", ({ request }) =>
      HttpResponse.json(stateOf(switchOf(new URL(request.url).host))),
    ),
    http.post("*/api/manager/network", async ({ request }) => {
      const current = switchOf(new URL(request.url).host);
      const body = (await request.json().catch(() => ({}))) as {
        enabled?: unknown;
        exitId?: unknown;
        protocol?: unknown;
        askPermission?: unknown;
      };
      if (body.askPermission === true && current.permissionAskedAt === 0) {
        current.permissionAskedAt = Date.now();
      }
      if (typeof body.exitId === "string") {
        const exit = EXITS.find((item) => item.id === body.exitId);
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
