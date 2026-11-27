/**
 * Network on this computer's daemon (`/api/manager/network`, the sidebar's
 * shield). Three kinds of exits:
 *
 * - the person's own proxy (Misha, 26.11) — this computer's;
 * - an imported WireGuard / AmneziaWG config — this computer's;
 * - the account's exits from the console (Misha 12.11: one switch per
 *   account) — the person's cloud computers with Uno's gateway, later Uno's
 *   addresses. This device registers its own key at the exit; the private
 *   key never leaves the daemon.
 *
 * Tunnel exits run in uno-net (`tunnelRuntime.ts`), a child process; on a
 * Mac too, without the network extension (Misha 27.11: "now like this,
 * strict mode later"). Everything rides one local bridge
 * (`proxyBridge.ts`): every child started while Network is on gets it in its
 * environment (`proxyEnv.ts`), the bridge forwards to the proxy or to the
 * tunnel's SOCKS. Fail-closed at app level: the exit down → the bridge
 * answers 502, never direct. Apps that ignore proxy settings go direct
 * (`strict: false`) until the macOS extension / the node gateway.
 *
 * A local exit (proxy, config) on this computer wins over the account's
 * exit; off, this computer follows the account.
 *
 * Everything lives in the secret store as one record (0600, outside
 * settings.json): proxy login, configs, the device key, the bridge's token,
 * the last console state (so a restart with the console unreachable stays
 * in the tunnel — or offline — never direct). No secret reaches an answer,
 * a child's environment or a log (all registered with the log redaction).
 */
import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import * as OS from "node:os";
import { join } from "node:path";

import {
  NETWORK_PROXY_EXIT_ID,
  type NetworkChangeInput,
  type NetworkComputer,
  type NetworkExit,
  type NetworkProtocol,
  type NetworkProxyCheck,
  type NetworkProxyInput,
  type NetworkProxyScheme,
  type NetworkState,
  type NetworkStatus,
  type NetworkTransport,
} from "@t3tools/contracts";
import { Context, Effect, Layer } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { registerKnownSecret } from "../secretRedaction.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { controlPlaneBaseUrl } from "../workspaceRegistry/unoCloudParse.ts";
import {
  type ConsoleNetworkClient,
  type ConsoleNetworkCredentials,
  ConsoleNetworkError,
  type ConsoleNetworkExit,
  type ConsoleNetworkState,
  makeConsoleNetworkClient,
  newDeviceKey,
  transportsFor,
} from "./consoleNetwork.ts";
import { checkProxy } from "./exitTrace.ts";
import { type ProxyBridge, startProxyBridge } from "./proxyBridge.ts";
import type { UpstreamProxy } from "./proxyDial.ts";
import {
  alwaysDirectHosts,
  applyProxyEnvironment,
  type BrowserProxyFile,
  inheritedProxyEnvironment,
  browserProxyOf,
  normalizeSkipList,
  proxyEnvironment,
} from "./proxyEnv.ts";
import { TRANSPORT_LABEL, type TunnelRuntime, makeTunnelRuntime } from "./tunnelRuntime.ts";
import {
  type UnoNetConfig,
  type UnoNetTransport,
  findNativeBinary,
  parseConfWithUnoNet,
} from "./unoNet.ts";

export const NETWORK_SECRET_NAME = "network-proxy";
/**
 * In the state dir, for the desktop app's own browser panel (0.0.197): the
 * Electron sessions of the panel can't take the proxy from the environment,
 * so the desktop reads the bridge from here (`apps/desktop/src/browserProxy.ts`).
 * Present (0600) while the proxy is on; removed when off.
 */
export const BROWSER_PROXY_FILE = "browser-proxy.json";
/** While on, how often the exit is checked ("Sites see …"). */
export const NETWORK_RECHECK_MS = 3 * 60_000;
/** How often the account's Network is read from the console. */
export const NETWORK_ACCOUNT_REFRESH_MS = 60_000;
/** While an exit is being set up or wakes up, how often its key is offered again. */
export const NETWORK_PEER_RETRY_MS = 10_000;

/**
 * `NetworkLive.pending` values that mean "waiting for the exit", not a
 * refusal: Uno is setting it up, or the exit computer sleeps (the console
 * lets an exit sleep after 3 days without devices) and is waking up.
 */
export const PENDING_SETTING_UP = "setting up";
export const PENDING_WAKING = "waking";

export const STRICT_MODE_NOTE =
  "Apps that ignore proxy settings go direct. Strict mode (everything or offline, incl. Docker) comes with the macOS extension.";

const CONFIG_EXIT_PREFIX = "config-";

interface StoredProxy {
  readonly scheme: NetworkProxyScheme;
  readonly host: string;
  readonly port: number;
  readonly username: string | null;
  readonly password: string | null;
  readonly skip: ReadonlyArray<string>;
}

interface StoredConfig {
  readonly id: string;
  readonly label: string;
  /** The wg-quick text as the person gave it (holds its private key). */
  readonly conf: string;
  readonly protocol: "wireguard" | "amneziawg";
}

interface StoredPeer {
  readonly exitId: string;
  readonly publicKey: string;
  readonly transports: ReadonlyArray<UnoNetTransport>;
  readonly at: string;
}

interface StoredNetwork {
  readonly version: 2;
  /** A local exit (proxy, config) is on. */
  readonly enabled: boolean;
  /** Which local exit: "proxy" or "config-…"; null — none chosen. */
  readonly exitId: string | null;
  readonly since: string | null;
  readonly proxy: StoredProxy | null;
  readonly check: NetworkProxyCheck | null;
  readonly bridge: { readonly token: string; readonly port: number };
  readonly configs: ReadonlyArray<StoredConfig>;
  readonly device: {
    readonly id: string;
    readonly privateKey: string;
    readonly publicKey: string;
  } | null;
  /** The account's Network as the console last said. */
  readonly account: ConsoleNetworkState | null;
  readonly peers: ReadonlyArray<StoredPeer>;
  /** "Sites see" through the tunnel, for the exit `tunnelCheckExit`. */
  readonly tunnelCheck: NetworkProxyCheck | null;
  readonly tunnelCheckExit: string | null;
}

interface StoredNetworkV1 {
  readonly version: 1;
  readonly enabled: boolean;
  readonly since: string | null;
  readonly proxy: StoredProxy | null;
  readonly check: NetworkProxyCheck | null;
  readonly bridge: { readonly token: string; readonly port: number };
}

export class NetworkInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "NetworkInputError";
  }
}

export interface NetworkComputerInfo {
  readonly id: string;
  readonly name: string;
  readonly kind: NetworkComputer["kind"];
}

export interface NetworkServiceShape {
  readonly state: (computer: NetworkComputerInfo) => Effect.Effect<NetworkState>;
  readonly change: (
    input: NetworkChangeInput,
    computer: NetworkComputerInfo,
  ) => Effect.Effect<NetworkState, NetworkInputError>;
  /** The saved proxy, or one typed in the form (not saved; its password, else the saved one). */
  readonly check: (input: {
    readonly proxy?: NetworkProxyInput | undefined;
  }) => Effect.Effect<NetworkProxyCheck, NetworkInputError>;
}

export class NetworkService extends Context.Service<NetworkService, NetworkServiceShape>()(
  "t3/network/NetworkService",
) {}

const HOST_PATTERN = /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;

/** The form's input as it will be stored; `saved` gives the password when the form left it out. */
export function normalizeProxyInput(
  input: NetworkProxyInput,
  saved: StoredProxy | null,
): StoredProxy {
  let host = input.host.trim();
  // "http://proxy.example:8080" pasted into the host field.
  const pasted = /^[a-z0-9]+:\/\/([^/]+?)(?::\d+)?\/?$/i.exec(host);
  if (pasted?.[1]) host = pasted[1];
  if (!HOST_PATTERN.test(host)) throw new NetworkInputError("Enter the proxy's host name or IP.");
  host = host.replace(/^\[|\]$/g, "");
  const skip = normalizeSkipList(input.skip ?? []);
  if ("invalid" in skip) {
    throw new NetworkInputError(`"${skip.invalid}" isn't a host, domain or IP range.`);
  }
  const username = input.username?.trim() ? input.username.trim() : null;
  const sameProxy =
    saved !== null &&
    saved.host === host &&
    saved.port === input.port &&
    saved.username === username;
  const password =
    input.password !== undefined
      ? input.password === ""
        ? null
        : input.password
      : sameProxy
        ? saved.password
        : null;
  return { scheme: input.scheme, host, port: input.port, username, password, skip: skip.skip };
}

const upstreamOf = (proxy: StoredProxy): UpstreamProxy => ({
  scheme: proxy.scheme,
  host: proxy.host,
  port: proxy.port,
  username: proxy.username,
  password: proxy.password,
});

function proxyLabel(proxy: StoredProxy): string {
  return proxy.host.includes(":") ? `[${proxy.host}]:${proxy.port}` : `${proxy.host}:${proxy.port}`;
}

/** Private keys inside a wg-quick text (registered with the log redaction). */
export function confSecrets(conf: string): ReadonlyArray<string> {
  return [...conf.matchAll(/^\s*(?:PrivateKey|PresharedKey)\s*=\s*(\S+)\s*$/gim)].flatMap((m) =>
    m[1] ? [m[1]] : [],
  );
}

/** What this computer goes out through right now. */
export type EffectiveExit =
  | { readonly kind: "proxy"; readonly id: string }
  | { readonly kind: "config"; readonly id: string; readonly config: StoredConfig }
  | {
      readonly kind: "account";
      readonly id: string;
      readonly exit: ConsoleNetworkExit | null;
    };

export function effectiveExit(stored: StoredNetwork): EffectiveExit | null {
  if (stored.enabled && stored.exitId === NETWORK_PROXY_EXIT_ID && stored.proxy) {
    return { kind: "proxy", id: NETWORK_PROXY_EXIT_ID };
  }
  if (stored.enabled && stored.exitId?.startsWith(CONFIG_EXIT_PREFIX)) {
    const config = stored.configs.find((c) => c.id === stored.exitId);
    if (config) return { kind: "config", id: config.id, config };
  }
  const account = stored.account;
  if (account?.available && account.enabled && account.exitId) {
    const exit = account.exits.find((e) => e.id === account.exitId) ?? null;
    // A computer is never its own exit: it keeps its own connection.
    if (!exit?.self) return { kind: "account", id: account.exitId, exit };
  }
  return null;
}

/** The account's exit this computer goes out through sleeps (as the console last said). */
export function chosenExitAsleep(stored: StoredNetwork): boolean {
  const effective = effectiveExit(stored);
  return effective?.kind === "account" && effective.exit?.state === "asleep";
}

/** The uno-net config for a tunnel exit; null with the sentence why it can't run. */
export function tunnelConfigFor(
  stored: StoredNetwork,
  effective: EffectiveExit,
): { readonly config: UnoNetConfig; readonly key: string } | { readonly blocked: string } | null {
  if (effective.kind === "proxy") return null;
  if (effective.kind === "config") {
    return {
      config: { transports: [{ conf: effective.config.conf }] },
      key: `${effective.id}:${effective.config.conf.length}:${hashOf(effective.config.conf)}`,
    };
  }
  const device = stored.device;
  const peer = device
    ? stored.peers.find((p) => p.exitId === effective.id && p.publicKey === device.publicKey)
    : undefined;
  if (!device || !peer) return { blocked: "pending" };
  const protocol = stored.account?.protocol ?? "auto";
  if (protocol === "openvpn") {
    return {
      blocked: "OpenVPN isn't available for this exit yet. Pick Auto, WireGuard or AmneziaWG.",
    };
  }
  const transports = transportsFor(peer.transports, protocol).map((t) => ({
    ...t,
    privateKey: device.privateKey,
  }));
  if (transports.length === 0) {
    return {
      blocked: `This exit doesn't carry ${protocol === "amneziawg" ? TRANSPORT_LABEL.amneziawg : TRANSPORT_LABEL.wireguard}. Pick Auto.`,
    };
  }
  return {
    config: { transports },
    key: `${effective.id}:${protocol}:${hashOf(JSON.stringify(peer.transports))}`,
  };
}

function hashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function parseStored(bytes: Uint8Array | null): StoredNetwork | null {
  if (!bytes) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as StoredNetwork | StoredNetworkV1;
    if (!value?.bridge?.token) return null;
    if (value.version === 1) {
      return {
        ...emptyTunnelPart(),
        version: 2,
        enabled: value.enabled,
        exitId: value.proxy ? NETWORK_PROXY_EXIT_ID : null,
        since: value.since,
        proxy: value.proxy,
        check: value.check,
        bridge: value.bridge,
      };
    }
    if (value.version !== 2) return null;
    return { ...emptyTunnelPart(), ...value };
  } catch {
    return null;
  }
}

const emptyTunnelPart = () => ({
  configs: [] as ReadonlyArray<StoredConfig>,
  device: null,
  account: null,
  peers: [] as ReadonlyArray<StoredPeer>,
  tunnelCheck: null,
  tunnelCheckExit: null,
});

/** The pieces of live state the answer needs besides the record. */
export interface NetworkLive {
  readonly checking: boolean;
  readonly direct: ReadonlyArray<string>;
  /** uno-net is installed here. */
  readonly engine: boolean;
  readonly tunnel: {
    readonly status: NetworkStatus;
    readonly activeProtocol: NetworkTransport | null;
    readonly latencyMs: number | null;
    readonly since: string | null;
    readonly error: string | null;
  };
  /** Waiting for the exit (being set up) or refused: a sentence; null — nothing. */
  readonly pending: string | null;
}

function proxyStatus(stored: StoredNetwork, checking: boolean): NetworkStatus {
  if (checking || !stored.check) return "connecting";
  return stored.check.status === "ok" ? "on" : "down";
}

function accountExitNote(exit: ConsoleNetworkExit): string | null {
  if (!exit.available)
    return exit.reason === "soon" ? "Coming soon" : (exit.reason ?? "Not available");
  switch (exit.state) {
    case "setting_up":
      return "Uno is setting it up…";
    case "failed":
      return exit.error ?? "Uno couldn't set it up";
    case "asleep":
      return "Asleep · wakes when picked";
    case "not_set_up":
      return "Uno sets it up when you pick it";
    default:
      return null;
  }
}

export function networkStateOf(
  stored: StoredNetwork,
  computer: NetworkComputerInfo,
  live: NetworkLive,
): NetworkState {
  const effective = effectiveExit(stored);
  const check = stored.check;
  const tunnelCheck =
    effective && effective.kind !== "proxy" && stored.tunnelCheckExit === effective.id
      ? stored.tunnelCheck
      : null;
  const exits: NetworkExit[] = [];
  const account = stored.account?.available ? stored.account : null;
  for (const exit of account?.exits ?? []) {
    if (exit.self) continue;
    const current = effective?.id === exit.id;
    const seen = current && tunnelCheck?.status === "ok" ? tunnelCheck : null;
    const wakingNow = current && exit.state === "asleep" && live.tunnel.status !== "on";
    exits.push({
      id: exit.id,
      kind: exit.kind,
      label: exit.label,
      country: seen?.country ?? exit.country,
      city: exit.city,
      address: seen?.ip ?? exit.address,
      latencyMs: current ? live.tunnel.latencyMs : null,
      online: exit.available && exit.state !== "failed",
      addressType: exit.addressType,
      protocols: exit.protocols,
      note: wakingNow ? "Waking up…" : accountExitNote(exit),
    });
  }
  for (const config of stored.configs) {
    const seen = effective?.id === config.id && tunnelCheck?.status === "ok" ? tunnelCheck : null;
    exits.push({
      id: config.id,
      kind: "config",
      label: config.label,
      country: seen?.country ?? null,
      city: null,
      address: seen?.ip ?? null,
      latencyMs: effective?.id === config.id ? live.tunnel.latencyMs : null,
      online: true,
      addressType: "unknown",
      protocols: [config.protocol],
      note: live.engine ? null : "Needs the tunnel engine (update Uno Work)",
      removable: true,
    });
  }
  if (stored.proxy) {
    exits.push({
      id: NETWORK_PROXY_EXIT_ID,
      kind: "proxy",
      label: proxyLabel(stored.proxy),
      country: check?.status === "ok" ? check.country : null,
      city: null,
      address: check?.status === "ok" ? check.ip : null,
      latencyMs: check?.status === "ok" ? check.latencyMs : null,
      online: check?.status !== "failed",
      addressType: "unknown",
      protocols: [],
    });
  }

  let status: NetworkStatus = "off";
  let reason: string | null = null;
  let since: string | null = null;
  if (effective?.kind === "proxy") {
    status = proxyStatus(stored, live.checking);
    since = stored.since;
  } else if (effective) {
    const accountExit = effective.kind === "account" ? effective.exit : null;
    // Asleep: the device's own state request (or its key) wakes it; until the
    // tunnel is up that's a wait, not "the exit doesn't answer".
    const waking =
      live.pending === PENDING_WAKING ||
      (accountExit?.state === "asleep" &&
        live.tunnel.status !== "on" &&
        (live.pending === null || live.pending === PENDING_SETTING_UP));
    if (waking) {
      status = "connecting";
      reason = `${accountExit?.label ?? "The exit"} is waking up.`;
    } else if (live.pending) {
      status = live.pending === PENDING_SETTING_UP ? "connecting" : "down";
      reason =
        live.pending === PENDING_SETTING_UP
          ? `Uno is setting up ${accountExit ? accountExit.label : "the exit"}. Uno Work stays offline until it's ready.`
          : live.pending;
    } else {
      status = live.tunnel.status === "off" ? "connecting" : live.tunnel.status;
      reason = status === "down" ? (live.tunnel.error ?? "The exit doesn't answer.") : null;
    }
    since =
      effective.kind === "config" ? stored.since : (stored.account?.since ?? live.tunnel.since);
  }

  const protocol: NetworkProtocol =
    effective?.kind === "config" ? effective.config.protocol : (account?.protocol ?? "auto");
  const computers: NetworkComputer[] = [
    { id: computer.id, name: computer.name, current: true, kind: computer.kind, status },
  ];
  for (const other of account?.computers ?? []) {
    if (other.name === computer.name && other.kind === computer.kind) continue;
    computers.push({
      id: other.id,
      name: other.name,
      current: false,
      kind: other.kind,
      status:
        other.status === "on" || other.status === "asleep"
          ? other.status
          : other.status === "down"
            ? "down"
            : "off",
    });
  }

  return {
    available: true,
    tunnel: live.engine || (account?.exits.some((e) => !e.self) ?? false),
    enabled: effective !== null,
    status,
    exitId:
      effective?.id ??
      stored.exitId ??
      account?.exitId ??
      (stored.proxy ? NETWORK_PROXY_EXIT_ID : null),
    exits,
    protocol,
    activeProtocol: effective && effective.kind !== "proxy" ? live.tunnel.activeProtocol : null,
    computers,
    permission: "granted",
    otherVpn: null,
    since: status === "off" ? null : since,
    proxy: stored.proxy
      ? {
          scheme: stored.proxy.scheme,
          host: stored.proxy.host,
          port: stored.proxy.port,
          username: stored.proxy.username,
          hasPassword: stored.proxy.password !== null,
          skip: stored.proxy.skip,
          alwaysDirect: live.direct,
          check,
        }
      : null,
    strict: false,
    reason,
    canImport: live.engine,
  };
}

/** Which console credentials this computer has: its machine token, else the person's account key. */
export function consoleCredentialsFrom(
  uno:
    | {
        readonly boxToken?: string | undefined;
        readonly boxId?: number | null | undefined;
        readonly apiKey?: string | undefined;
      }
    | null
    | undefined,
  deviceId: string,
): ConsoleNetworkCredentials | null {
  const boxToken = uno?.boxToken?.trim() ?? "";
  const boxId = typeof uno?.boxId === "number" && uno.boxId > 0 ? uno.boxId : null;
  if (boxToken && boxId !== null) return { kind: "machine", boxToken, boxId };
  const accountKey = uno?.apiKey?.trim() ?? "";
  // A `unollm_` key only buys AI.
  if (accountKey && !accountKey.startsWith("unollm_")) {
    return { kind: "account", accountKey, deviceId };
  }
  return null;
}

export const makeNetworkService = (options?: {
  /** The env children inherit (tests pass their own). */
  readonly env?: Record<string, string | undefined>;
  readonly checkProxy?: typeof checkProxy;
  readonly recheckMs?: number;
  /** The console as this computer may speak to it; null — not linked. */
  readonly consoleClient?: (deviceId: string) => Effect.Effect<ConsoleNetworkClient | null>;
  readonly runtime?: TunnelRuntime;
  /** uno-net's path; null — not installed (tests). */
  readonly engineBinary?: string | null;
  readonly accountRefreshMs?: number;
  readonly peerRetryMs?: number;
  readonly hostname?: string;
  /** Where the desktop's browser panel reads the proxy ({@link BROWSER_PROXY_FILE}); none on a server. */
  readonly browserProxyPath?: string | null;
}) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore;
    const env = options?.env ?? process.env;
    const runCheck = options?.checkProxy ?? checkProxy;
    const engineBinary =
      options?.engineBinary !== undefined ? options.engineBinary : findNativeBinary("uno-net");
    const runtime = options?.runtime ?? makeLoggedRuntime(engineBinary);
    const consoleClient = options?.consoleClient ?? (() => Effect.succeed(null));
    const hostname = options?.hostname ?? OS.hostname();
    // The person's own proxy variables (a corporate proxy in their shell), restored when off.
    const inherited = inheritedProxyEnvironment(env);
    applyProxyEnvironment(env, null, inherited);
    const direct = alwaysDirectHosts(controlPlaneBaseUrl());
    const browserProxyPath = options?.browserProxyPath ?? null;
    /** The desktop's browser panel follows this file; a failed write is logged, never fatal. */
    const writeBrowserProxy = (value: BrowserProxyFile | null) =>
      browserProxyPath === null
        ? Effect.void
        : Effect.tryPromise(async () => {
            if (value === null) return rm(browserProxyPath, { force: true });
            const tmp = `${browserProxyPath}.${process.pid}.tmp`;
            await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
            await rename(tmp, browserProxyPath);
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("network: proxy for the browser panel not written").pipe(
                Effect.annotateLogs({ cause: String(cause) }),
              ),
            ),
          );
    const lock = yield* Semaphore.make(1);

    const fresh = (): StoredNetwork => ({
      version: 2,
      enabled: false,
      exitId: null,
      since: null,
      proxy: null,
      check: null,
      bridge: { token: randomBytes(24).toString("hex"), port: 0 },
      ...emptyTunnelPart(),
    });
    let stored: StoredNetwork =
      parseStored(yield* secrets.get(NETWORK_SECRET_NAME).pipe(Effect.orElseSucceed(() => null))) ??
      fresh();
    let bridge: ProxyBridge | null = null;
    let checking = false;
    let pending: string | null = null;
    let lastComputerName: string | null = null;
    let accountReadAt = 0;
    let nextPeerTry = 0;

    const remember = (value: StoredNetwork) => {
      registerKnownSecret(value.bridge.token);
      registerKnownSecret(value.proxy?.password);
      if (value.proxy?.password) registerKnownSecret(encodeURIComponent(value.proxy.password));
      registerKnownSecret(value.device?.privateKey);
      for (const config of value.configs)
        for (const s of confSecrets(config.conf)) registerKnownSecret(s);
    };
    remember(stored);

    const persist = (value: StoredNetwork) =>
      secrets
        .set(NETWORK_SECRET_NAME, new TextEncoder().encode(JSON.stringify(value)))
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("network: settings not saved").pipe(
              Effect.annotateLogs({ cause: cause.message }),
            ),
          ),
        );

    const tunnelUpstream = (): UpstreamProxy | "blocked" => {
      const socks = runtime.socks();
      return socks
        ? {
            scheme: "socks5",
            host: socks.host,
            port: socks.port,
            username: "work",
            password: socks.token,
          }
        : "blocked";
    };

    /** Bridge, tunnel and the children's env as `stored` says. */
    const sync = Effect.gen(function* () {
      const effective = effectiveExit(stored);
      const needsBridge = stored.proxy !== null || stored.configs.length > 0 || effective !== null;
      if (needsBridge && !bridge) {
        const started = yield* Effect.tryPromise(() =>
          startProxyBridge({
            token: stored.bridge.token,
            port: stored.bridge.port,
            upstream: null,
          }),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("network: local proxy didn't start").pipe(
              Effect.annotateLogs({ cause: String(cause) }),
              Effect.as(null),
            ),
          ),
        );
        bridge = started;
        if (started && started.port !== stored.bridge.port) {
          stored = { ...stored, bridge: { ...stored.bridge, port: started.port } };
          yield* persist(stored);
        }
      }

      // The tunnel: what uno-net should run.
      let tunnel: ReturnType<typeof tunnelConfigFor> = null;
      if (effective && effective.kind !== "proxy") tunnel = tunnelConfigFor(stored, effective);
      if (tunnel && "config" in tunnel) {
        pending = null;
        yield* Effect.promise(() => runtime.setDesired(tunnel.config, tunnel.key));
      } else {
        if (!tunnel) pending = null;
        else if (tunnel.blocked !== "pending") pending = tunnel.blocked;
        // Waiting for the exit; a refusal from the console (set by reconcileAccount) stays.
        else if (pending === null || pending === PENDING_SETTING_UP)
          pending = chosenExitAsleep(stored) ? PENDING_WAKING : PENDING_SETTING_UP;
        yield* Effect.promise(() => runtime.setDesired(null, null));
      }

      if (bridge) {
        if (!effective) bridge.setUpstream(null);
        else if (effective.kind === "proxy" && stored.proxy)
          bridge.setUpstream(upstreamOf(stored.proxy));
        else if (tunnel && "config" in tunnel) bridge.setUpstream(tunnelUpstream);
        // On, but nothing to carry it yet: fail-closed.
        else bridge.setUpstream("blocked");
      }
      // The browser panel follows the same bridge, so a tunnel that is down closes it too.
      const on = effective !== null && bridge !== null;
      const bypass = [...direct, ...(stored.proxy?.skip ?? [])];
      applyProxyEnvironment(
        env,
        on && bridge ? proxyEnvironment({ bridgeUrl: bridge.url, direct: bypass }) : null,
        inherited,
      );
      yield* writeBrowserProxy(on && bridge ? browserProxyOf(bridge.url, bypass) : null);
    });

    const recheck = Effect.gen(function* () {
      const proxy = stored.proxy;
      if (!proxy) return;
      checking = true;
      const result = yield* Effect.promise(() => runCheck(upstreamOf(proxy))).pipe(
        Effect.ensuring(Effect.sync(() => (checking = false))),
      );
      // Saved anew meanwhile: this answer is about the old one.
      if (stored.proxy !== proxy) return;
      stored = { ...stored, check: result };
      yield* persist(stored);
    });

    /** "Sites see" through the tunnel, while it's on. */
    const recheckTunnel = Effect.gen(function* () {
      const effective = effectiveExit(stored);
      if (!effective || effective.kind === "proxy" || runtime.snapshot().status !== "on") return;
      const upstream = tunnelUpstream();
      if (upstream === "blocked") return;
      const result = yield* Effect.promise(() => runCheck(upstream));
      if (effectiveExit(stored)?.id !== effective.id) return;
      stored = { ...stored, tunnelCheck: result, tunnelCheckExit: effective.id };
      yield* persist(stored);
    });

    const ensureDevice = () => {
      if (stored.device) return stored.device;
      const key = newDeviceKey();
      const device = { id: `dev-${randomBytes(8).toString("hex")}`, ...key };
      stored = { ...stored, device };
      remember(stored);
      return device;
    };

    /** The account's Network from the console, and this device's key at its exit. */
    const reconcileAccount = (force: boolean) =>
      Effect.gen(function* () {
        const device = ensureDevice();
        const client = yield* consoleClient(device.id);
        if (!client) {
          if (stored.account) {
            stored = { ...stored, account: null };
            yield* persist(stored);
          }
          return;
        }
        if (force || Date.now() - accountReadAt > 15_000) {
          const account = yield* Effect.tryPromise(() => client.state()).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("network: console unreachable, keeping the last state").pipe(
                Effect.annotateLogs({ cause: String(cause) }),
                Effect.as(null),
              ),
            ),
          );
          if (account) {
            accountReadAt = Date.now();
            if (JSON.stringify(account) !== JSON.stringify(stored.account)) {
              stored = { ...stored, account };
              yield* persist(stored);
            }
          }
        }
        const effective = effectiveExit(stored);
        if (effective?.kind !== "account") return;
        const have = stored.peers.some(
          (p) => p.exitId === effective.id && p.publicKey === device.publicKey,
        );
        if (have || (!force && Date.now() < nextPeerTry)) return;
        nextPeerTry = Date.now() + (options?.peerRetryMs ?? NETWORK_PEER_RETRY_MS);
        const label = lastComputerName ?? hostname;
        const result = yield* Effect.tryPromise({
          try: () =>
            client.registerPeer({ publicKey: device.publicKey, exitId: effective.id, label }),
          catch: (error) =>
            error instanceof ConsoleNetworkError
              ? error
              : new ConsoleNetworkError(
                  502,
                  "CONSOLE_UNREACHABLE",
                  "The Uno console didn't answer.",
                ),
        }).pipe(Effect.result);
        if (result._tag === "Success") {
          const peer: StoredPeer = {
            exitId: result.success.exitId,
            publicKey: device.publicKey,
            transports: result.success.transports,
            at: new Date().toISOString(),
          };
          stored = {
            ...stored,
            peers: [...stored.peers.filter((p) => p.exitId !== peer.exitId), peer],
          };
          pending = null;
          yield* persist(stored);
          return;
        }
        const error = result.failure;
        if (error instanceof ConsoleNetworkError && error.code === "NETWORK_EXIT_NOT_READY") {
          // The console woke the exit on this request; ask again soon.
          pending = error.state === "asleep" ? PENDING_WAKING : PENDING_SETTING_UP;
        } else {
          pending =
            error instanceof ConsoleNetworkError
              ? error.message
              : "Uno couldn't connect this computer to the exit.";
        }
      });

    const reconcile = (force: boolean) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* reconcileAccount(force);
          yield* sync;
        }),
      );

    yield* lock.withPermits(1)(sync);
    if (effectiveExit(stored)?.kind === "proxy") {
      yield* Effect.forkDetach(lock.withPermits(1)(recheck));
    }
    yield* Effect.forkDetach(reconcile(true).pipe(Effect.ignore));

    // The tunnel came up (or changed exits): see what sites see.
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    let lastTunnelStatus = runtime.snapshot().status;
    runtime.onChange(() => {
      const now = runtime.snapshot().status;
      if (now === "on" && lastTunnelStatus !== "on") {
        runFork(lock.withPermits(1)(recheckTunnel).pipe(Effect.ignore));
      }
      lastTunnelStatus = now;
    });

    const recheckMs = options?.recheckMs ?? NETWORK_RECHECK_MS;
    if (recheckMs > 0) {
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(recheckMs);
            const effective = effectiveExit(stored);
            if (effective?.kind === "proxy") {
              yield* lock.withPermits(1)(recheck).pipe(Effect.ignore);
            } else if (effective) {
              yield* lock.withPermits(1)(recheckTunnel).pipe(Effect.ignore);
            }
          }
        }),
      );
    }
    const accountRefreshMs = options?.accountRefreshMs ?? NETWORK_ACCOUNT_REFRESH_MS;
    /** Waiting for the exit to be set up or to wake: read the console every 10 s, not every minute. */
    const waitingForExit = () =>
      pending === PENDING_SETTING_UP ||
      pending === PENDING_WAKING ||
      (chosenExitAsleep(stored) && runtime.snapshot().status !== "on");
    if (accountRefreshMs > 0) {
      // Ticks at the short pace so a wait that starts mid-minute (an exit
      // picked, a 409) speeds up at once; otherwise a refresh once a minute.
      const peerRetryMs = options?.peerRetryMs ?? NETWORK_PEER_RETRY_MS;
      const tickMs = peerRetryMs > 0 ? Math.min(peerRetryMs, accountRefreshMs) : accountRefreshMs;
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          let refreshedAt = Date.now();
          while (true) {
            yield* Effect.sleep(tickMs);
            const waiting = waitingForExit();
            if (!waiting && Date.now() - refreshedAt < accountRefreshMs) continue;
            refreshedAt = Date.now();
            yield* reconcile(waiting).pipe(Effect.ignore);
          }
        }),
      );
    }
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        applyProxyEnvironment(env, null, inherited);
        await runtime.close();
        await bridge?.close();
      }),
    );

    const live = (): NetworkLive => ({
      checking,
      direct,
      engine: engineBinary !== null,
      tunnel: runtime.snapshot(),
      pending,
    });

    const consoleChange = (input: {
      readonly enabled?: boolean;
      readonly exitId?: string;
      readonly protocol?: NetworkProtocol;
    }) =>
      Effect.gen(function* () {
        const device = ensureDevice();
        const client = yield* consoleClient(device.id);
        if (!client) {
          return yield* Effect.fail(
            new NetworkInputError("This computer isn't linked to the Uno console."),
          );
        }
        const account = yield* Effect.tryPromise({
          try: () => client.change(input),
          catch: (error) =>
            new NetworkInputError(
              error instanceof ConsoleNetworkError
                ? error.message
                : "The Uno console didn't answer.",
            ),
        });
        accountReadAt = Date.now();
        stored = { ...stored, account };
      });

    const change: NetworkServiceShape["change"] = (input, computer) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          lastComputerName = computer.name;
          let next = stored;
          let changedProxy = false;
          let accountTouched = false;
          if (input.proxy !== undefined) {
            if (input.proxy === null) {
              const wasOn = next.exitId === NETWORK_PROXY_EXIT_ID;
              next = {
                ...next,
                proxy: null,
                check: null,
                ...(wasOn ? { enabled: false, exitId: null, since: null } : {}),
              };
            } else {
              const proxy = yield* Effect.try({
                try: () => normalizeProxyInput(input.proxy as NetworkProxyInput, stored.proxy),
                catch: (error) =>
                  error instanceof NetworkInputError
                    ? error
                    : new NetworkInputError("This proxy can't be saved."),
              });
              const same = JSON.stringify(proxy) === JSON.stringify(stored.proxy);
              next = { ...next, proxy, check: same ? next.check : null };
            }
            changedProxy = next.proxy !== stored.proxy;
          }
          if (input.importConfig) {
            if (!engineBinary) {
              return yield* Effect.fail(
                new NetworkInputError(
                  "The tunnel engine isn't installed on this computer. Update Uno Work.",
                ),
              );
            }
            const conf = input.importConfig.conf.trim();
            const parsed = yield* Effect.promise(() => parseConfWithUnoNet(engineBinary, conf));
            if (!parsed.ok) return yield* Effect.fail(new NetworkInputError(parsed.reason));
            const endpointHost = parsed.transport.peer?.endpoint
              ?.replace(/:\d+$/, "")
              .replace(/^\[|\]$/g, "");
            const label = input.importConfig.label?.trim() || endpointHost || "Imported config";
            const config: StoredConfig = {
              id: `${CONFIG_EXIT_PREFIX}${randomBytes(4).toString("hex")}`,
              label,
              conf,
              protocol: parsed.transport.protocol === "amneziawg" ? "amneziawg" : "wireguard",
            };
            next = {
              ...next,
              configs: [...next.configs, config],
              enabled: true,
              exitId: config.id,
              since: new Date().toISOString(),
            };
          }
          if (input.removeExitId?.startsWith(CONFIG_EXIT_PREFIX)) {
            const wasOn = next.exitId === input.removeExitId;
            next = {
              ...next,
              configs: next.configs.filter((c) => c.id !== input.removeExitId),
              ...(wasOn ? { enabled: false, exitId: null, since: null } : {}),
            };
          }

          const localExit = (id: string | undefined) =>
            id === NETWORK_PROXY_EXIT_ID || (id?.startsWith(CONFIG_EXIT_PREFIX) ?? false);
          if (input.exitId !== undefined && !input.importConfig) {
            if (localExit(input.exitId)) {
              if (input.exitId === NETWORK_PROXY_EXIT_ID && !next.proxy) {
                return yield* Effect.fail(new NetworkInputError("Add a proxy first."));
              }
              if (
                input.exitId.startsWith(CONFIG_EXIT_PREFIX) &&
                !next.configs.some((c) => c.id === input.exitId)
              ) {
                return yield* Effect.fail(
                  new NetworkInputError("That config isn't here any more."),
                );
              }
              if (input.enabled !== false) {
                next = {
                  ...next,
                  enabled: true,
                  exitId: input.exitId,
                  since:
                    next.enabled && next.exitId === input.exitId
                      ? next.since
                      : new Date().toISOString(),
                };
              } else {
                next = { ...next, exitId: input.exitId };
              }
            } else {
              // The account's exit: one switch for every computer of the account.
              stored = next;
              yield* consoleChange({
                exitId: input.exitId,
                enabled: input.enabled ?? true,
                ...(input.protocol ? { protocol: input.protocol } : {}),
              });
              accountTouched = true;
              next = { ...stored, enabled: false, since: null };
            }
          } else if (input.enabled !== undefined && !input.importConfig) {
            const current = effectiveExit(next);
            if (input.enabled) {
              if (current) {
                // Already on.
              } else if (next.exitId && localExit(next.exitId)) {
                if (next.exitId === NETWORK_PROXY_EXIT_ID && !next.proxy) {
                  return yield* Effect.fail(new NetworkInputError("Add a proxy first."));
                }
                next = { ...next, enabled: true, since: new Date().toISOString() };
              } else if (next.account?.available && next.account.exitId) {
                stored = next;
                yield* consoleChange({ enabled: true });
                accountTouched = true;
                next = stored;
              } else if (next.proxy) {
                next = {
                  ...next,
                  enabled: true,
                  exitId: NETWORK_PROXY_EXIT_ID,
                  since: new Date().toISOString(),
                };
              } else if (next.configs[0]) {
                next = {
                  ...next,
                  enabled: true,
                  exitId: next.configs[0].id,
                  since: new Date().toISOString(),
                };
              } else {
                return yield* Effect.fail(
                  new NetworkInputError(
                    next.account?.available ? "Pick an exit first." : "Add a proxy first.",
                  ),
                );
              }
            } else if (current?.kind === "account") {
              stored = next;
              yield* consoleChange({ enabled: false });
              accountTouched = true;
              next = stored;
            } else {
              next = { ...next, enabled: false, since: null };
            }
          }
          if (input.protocol !== undefined && !accountTouched && next.account?.available) {
            stored = next;
            yield* consoleChange({ protocol: input.protocol });
            accountTouched = true;
            next = stored;
          }

          if (
            next.proxy &&
            bridge &&
            next.proxy.port === bridge.port &&
            ["localhost", "127.0.0.1", "::1"].includes(next.proxy.host.toLowerCase())
          ) {
            return yield* Effect.fail(
              new NetworkInputError(
                "That's Uno Work's own local proxy. Enter your proxy's address.",
              ),
            );
          }
          const turnedOnProxy =
            effectiveExit(next)?.kind === "proxy" && effectiveExit(stored)?.kind !== "proxy";
          stored = next;
          remember(stored);
          yield* persist(stored);
          if (accountTouched) {
            nextPeerTry = 0;
            yield* reconcileAccount(false);
          }
          yield* sync;
          // A new proxy, or turned on: the person sees at once whether it works.
          if (stored.proxy && (changedProxy || turnedOnProxy)) yield* recheck;
          return networkStateOf(stored, computer, live());
        }),
      );

    const check: NetworkServiceShape["check"] = (input) =>
      Effect.gen(function* () {
        if (!input.proxy) {
          if (!stored.proxy) return yield* Effect.fail(new NetworkInputError("Add a proxy first."));
          yield* lock.withPermits(1)(recheck);
          return stored.check as NetworkProxyCheck;
        }
        const typed = input.proxy;
        const proxy = yield* Effect.try({
          try: () => normalizeProxyInput(typed, stored.proxy),
          catch: (error) =>
            error instanceof NetworkInputError
              ? error
              : new NetworkInputError("This proxy can't be checked."),
        });
        return yield* Effect.promise(() => runCheck(upstreamOf(proxy)));
      });

    return {
      state: (computer) =>
        Effect.gen(function* () {
          lastComputerName = computer.name;
          // Fresh enough for the panel without waiting on the console every time.
          if (Date.now() - accountReadAt > 15_000) {
            yield* Effect.forkDetach(reconcile(false).pipe(Effect.ignore));
          }
          return networkStateOf(stored, computer, live());
        }),
      change,
      check,
    } satisfies NetworkServiceShape;
  });

function makeLoggedRuntime(binary: string | null): TunnelRuntime {
  return makeTunnelRuntime({
    binary,
    log: (message, fields) => {
      Effect.runFork(Effect.logWarning(message).pipe(Effect.annotateLogs(fields ?? {})));
    },
  });
}

export const NetworkServiceLive = Layer.effect(
  NetworkService,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const config = yield* ServerConfig;
    return yield* makeNetworkService({
      // Only the desktop app has a browser panel of its own (Electron).
      browserProxyPath:
        config.mode === "desktop" ? join(config.stateDir, BROWSER_PROXY_FILE) : null,
      consoleClient: (deviceId) =>
        settings.getSettings.pipe(
          Effect.map((current) => {
            const credentials = consoleCredentialsFrom(current.uno, deviceId);
            return credentials ? makeConsoleNetworkClient(credentials) : null;
          }),
          Effect.orElseSucceed(() => null),
        ),
    });
  }),
);
