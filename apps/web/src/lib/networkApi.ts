/**
 * Network (12.11.2026): the account's computers — this one and the cloud ones —
 * go online through one address the person picked (a Uno address in a country,
 * one of their computers, their own server). All the work goes inside the
 * tunnel, with no exceptions (Misha, 12.11: "all the work must go inside the
 * tunnel"): on a cloud computer that is all of its traffic; on a desktop it is
 * everything Uno Work and what it starts do — agents, terminals, the browser,
 * git, ssh, downloads, Uno's own connection — and all of Docker there, since
 * containers go online as Docker Desktop, not as Uno Work (Misha, 12.11).
 * The desktop catches it with the
 * app's network extension (macOS asks the person to allow it once); until then,
 * and whenever the tunnel drops, Uno Work there stays offline rather than going
 * around it. Other apps of that computer keep their own connection.
 *
 * The daemon's `/api/manager/network` is the whole contract: it reports the
 * state, the exits, the protocols and each computer, and takes
 * `{enabled, exitId, protocol}`. A daemon without the route (today's Work)
 * reads as "not available": the button is not shown at all.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { EnvironmentHttpError, environmentFetchJson } from "~/environments/http/target";

/** Where an exit comes from: Uno's own address, a computer or server of the person, their config. */
export type NetworkExitKind = "uno" | "computer" | "server" | "config";

/**
 * How the tunnel to the exit is carried. `auto` tries WireGuard, then
 * AmneziaWG where WireGuard is blocked, then OpenVPN over TCP 443.
 */
export type NetworkProtocol = "auto" | "wireguard" | "amneziawg" | "openvpn";
export type NetworkTransport = Exclude<NetworkProtocol, "auto">;

export type NetworkAddressType = "clean" | "datacenter" | "unknown";

export interface NetworkExit {
  readonly id: string;
  readonly kind: NetworkExitKind;
  /** "Germany", "uno-work", "VPS Amsterdam". */
  readonly label: string;
  /** ISO 3166 alpha-2 of where the address is ("DE"); null when unknown. */
  readonly country: string | null;
  readonly city: string | null;
  /** The public address sites see; null until known. */
  readonly address: string | null;
  /** Round trip from this computer, ms; null when not measured or unreachable. */
  readonly latencyMs: number | null;
  readonly online: boolean;
  /**
   * Who the address belongs to, as sites see it: `clean` — a home internet
   * provider (Uno's addresses: sites trust them, rarely ask for captchas);
   * `datacenter` — a hosting company (a cloud computer, a VPS: more captchas,
   * some sites block them); `unknown` — not checked yet.
   */
  readonly addressType: NetworkAddressType;
  /** What it can carry. An imported config carries only its own (one item). */
  readonly protocols: ReadonlyArray<NetworkTransport>;
}

/**
 * off — the computer's own connection;
 * connecting — turned on, the tunnel is coming up;
 * on — everything Uno Work starts goes out through the exit;
 * down — turned on but the exit doesn't answer: nothing goes out (no leak).
 */
export type NetworkStatus = "off" | "connecting" | "on" | "down";

/** One computer of the account and what Network does on it. */
export interface NetworkComputer {
  readonly id: string;
  readonly name: string;
  /** The computer this daemon runs on. */
  readonly current: boolean;
  /** cloud — all its traffic goes through the exit; desktop — what Uno Work starts. */
  readonly kind: "cloud" | "desktop";
  /**
   * asleep — joins with Network as it is when it wakes;
   * permission — waits for the person to allow the network extension once.
   */
  readonly status: NetworkStatus | "asleep" | "permission";
}

export interface NetworkState {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly status: NetworkStatus;
  readonly exitId: string | null;
  readonly exits: ReadonlyArray<NetworkExit>;
  readonly protocol: NetworkProtocol;
  /** What carries the tunnel right now (what `auto` picked); null while off. */
  readonly activeProtocol: NetworkTransport | null;
  readonly computers: ReadonlyArray<NetworkComputer>;
  /**
   * needed — this computer's network extension isn't allowed yet: while on,
   * Uno Work here stays offline until the person allows it (`askPermission`).
   */
  readonly permission: "granted" | "needed";
  /** Another VPN already on this computer (corporate, personal); Uno goes through it. */
  readonly otherVpn: { readonly name: string } | null;
  /** Since when it has been on (ISO), for "on since". */
  readonly since: string | null;
}

export const NETWORK_UNAVAILABLE: NetworkState = {
  available: false,
  enabled: false,
  status: "off",
  exitId: null,
  exits: [],
  protocol: "auto",
  activeProtocol: null,
  computers: [],
  permission: "granted",
  otherVpn: null,
  since: null,
};

export interface NetworkChange {
  readonly enabled?: boolean;
  readonly exitId?: string;
  readonly protocol?: NetworkProtocol;
  /** Ask the system to allow the network extension (macOS shows its own prompt). */
  readonly askPermission?: boolean;
}

const ROOT = "/api/manager/network";

export async function getNetwork(input: { environmentId: EnvironmentId }): Promise<NetworkState> {
  try {
    return await environmentFetchJson<NetworkState>({
      environmentId: input.environmentId,
      pathname: ROOT,
    });
  } catch (cause) {
    if (cause instanceof EnvironmentHttpError && (cause.status === 404 || cause.status === 405)) {
      return NETWORK_UNAVAILABLE;
    }
    throw cause;
  }
}

export function setNetwork(
  input: { environmentId: EnvironmentId } & NetworkChange,
): Promise<NetworkState> {
  const { environmentId, ...change } = input;
  return environmentFetchJson<NetworkState>({
    environmentId,
    pathname: ROOT,
    method: "POST",
    body: change,
  });
}

export const ADDRESS_TYPE_LABEL: Record<NetworkAddressType, string> = {
  clean: "Clean",
  datacenter: "Datacenter",
  unknown: "Not checked",
};

export const PROTOCOL_LABEL: Record<NetworkProtocol, string> = {
  auto: "Auto",
  wireguard: "WireGuard",
  amneziawg: "AmneziaWG",
  openvpn: "OpenVPN",
};

export const PROTOCOL_HINT: Record<NetworkProtocol, string> = {
  auto: "Picks what works on this network",
  wireguard: "Fastest. Blocked on some networks",
  amneziawg: "WireGuard that looks like noise. Where WireGuard is blocked",
  openvpn: "Over TCP 443, like a website. Passes strict office networks, slower",
};

/** "Auto · WireGuard" while auto has picked one; else the chosen protocol. */
export function protocolSummary(state: NetworkState): string {
  if (state.protocol !== "auto") return PROTOCOL_LABEL[state.protocol];
  return state.activeProtocol ? `Auto · ${PROTOCOL_LABEL[state.activeProtocol]}` : "Auto";
}

/** Can this exit carry that protocol (auto: anything)? */
export function exitCarries(exit: NetworkExit, protocol: NetworkProtocol): boolean {
  return protocol === "auto" || exit.protocols.includes(protocol);
}

/** 🇩🇪 from "DE"; empty for anything that isn't two letters. */
export function flagOf(country: string | null): string {
  if (!country || !/^[A-Za-z]{2}$/.test(country)) return "";
  const base = 0x1f1e6 - "A".charCodeAt(0);
  const upper = country.toUpperCase();
  return String.fromCodePoint(base + upper.charCodeAt(0), base + upper.charCodeAt(1));
}

export function currentExit(state: NetworkState): NetworkExit | null {
  return state.exits.find((exit) => exit.id === state.exitId) ?? null;
}
