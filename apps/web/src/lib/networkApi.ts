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
 * The daemon's `/api/manager/network` is the whole contract
 * (`@t3tools/contracts` network.ts): it reports the state, the exits, the
 * protocols and each computer, and takes `{enabled, exitId, protocol, proxy}`.
 * A daemon without the route reads as "not available": no button at all.
 *
 * Proxy (26.11, Misha: "add a proxy, set up in the app's environment"): the
 * person's own HTTP / HTTPS / SOCKS5 proxy is an exit too. It needs no
 * network extension, so it works before the tunnel does, on a Mac and on
 * cloud computers alike: what Uno Work starts on that computer gets it in its
 * environment. A daemon without the tunnel says `tunnel: false`: no protocol
 * row, the proxy is the only exit.
 */
import type {
  EnvironmentId,
  NetworkAddressType,
  NetworkChangeInput,
  NetworkExit,
  NetworkProtocol,
  NetworkProxyCheck,
  NetworkProxyInput,
  NetworkState,
} from "@t3tools/contracts";

import { EnvironmentHttpError, environmentFetchJson } from "~/environments/http/target";

export type {
  NetworkAddressType,
  NetworkComputer,
  NetworkExit,
  NetworkExitKind,
  NetworkProtocol,
  NetworkProxyCheck,
  NetworkProxyInfo,
  NetworkProxyInput,
  NetworkProxyScheme,
  NetworkState,
  NetworkStatus,
  NetworkTransport,
} from "@t3tools/contracts";
export {
  NETWORK_CONFIG_MAX_CHARS,
  NETWORK_LABEL_MAX_CHARS,
  NETWORK_PROXY_EXIT_ID,
} from "@t3tools/contracts";

export const NETWORK_UNAVAILABLE: NetworkState = {
  available: false,
  tunnel: false,
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
  proxy: null,
};

export type NetworkChange = NetworkChangeInput;

/** A refusal of the daemon, as a sentence for the person ("Enter the proxy's host name or IP."). */
export function networkErrorMessage(error: unknown): string {
  if (error instanceof EnvironmentHttpError && error.status === 400) return error.message;
  return "Uno Work on this computer didn't answer. Try again.";
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

/** "Check": the saved proxy, or the one typed in the form (not saved). */
export function checkNetworkProxy(input: {
  environmentId: EnvironmentId;
  proxy?: NetworkProxyInput;
}): Promise<NetworkProxyCheck> {
  return environmentFetchJson<NetworkProxyCheck>({
    environmentId: input.environmentId,
    pathname: `${ROOT}/check`,
    method: "POST",
    body: input.proxy ? { proxy: input.proxy } : {},
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
