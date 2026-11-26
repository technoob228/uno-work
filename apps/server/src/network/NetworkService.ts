/**
 * Network on this computer's daemon (`/api/manager/network`, the sidebar's
 * shield). Today it carries one kind of exit: the person's own proxy
 * (Misha, 26.11). The tunnel exits (uno-net, the macOS extension, the
 * console's account switch) come later and report `tunnel: false` until then.
 *
 * The proxy is this computer's (recommended default, open question for Misha:
 * per account later, through the console). It lives in the secret store as
 * one record — address, login, password, the bridge's token and port, the
 * switch and the last check — 0600, outside settings.json; the password
 * never leaves the daemon: not in an answer, a child's environment or a log
 * (it is registered with the log redaction).
 *
 * On: the bridge (`proxyBridge.ts`) forwards to the proxy and every child
 * started from now on gets the bridge in its environment (`proxyEnv.ts`).
 * Running chats, terminals and apps keep the environment they started with;
 * the bridge serves them as well (direct while off). A check runs on every
 * change and every few minutes while on: a proxy that stops answering reads
 * "down" — its users can't go online, nothing goes around it.
 */
import { randomBytes } from "node:crypto";

import {
  NETWORK_PROXY_EXIT_ID,
  type NetworkChangeInput,
  type NetworkComputer,
  type NetworkExit,
  type NetworkProxyCheck,
  type NetworkProxyInput,
  type NetworkProxyScheme,
  type NetworkState,
  type NetworkStatus,
} from "@t3tools/contracts";
import { Context, Effect, Layer } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { registerKnownSecret } from "../secretRedaction.ts";
import { controlPlaneBaseUrl } from "../workspaceRegistry/unoCloudParse.ts";
import { checkProxy } from "./exitTrace.ts";
import { type ProxyBridge, startProxyBridge } from "./proxyBridge.ts";
import type { UpstreamProxy } from "./proxyDial.ts";
import {
  alwaysDirectHosts,
  applyProxyEnvironment,
  inheritedProxyEnvironment,
  normalizeSkipList,
  proxyEnvironment,
} from "./proxyEnv.ts";

export const NETWORK_SECRET_NAME = "network-proxy";
/** While on, how often the proxy is checked. */
export const NETWORK_RECHECK_MS = 3 * 60_000;

interface StoredProxy {
  readonly scheme: NetworkProxyScheme;
  readonly host: string;
  readonly port: number;
  readonly username: string | null;
  readonly password: string | null;
  readonly skip: ReadonlyArray<string>;
}

interface StoredNetwork {
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

function statusOf(stored: StoredNetwork, checking: boolean): NetworkStatus {
  if (!stored.enabled || !stored.proxy) return "off";
  if (checking || !stored.check) return "connecting";
  return stored.check.status === "ok" ? "on" : "down";
}

export function networkStateOf(
  stored: StoredNetwork,
  computer: NetworkComputerInfo,
  checking: boolean,
  direct: ReadonlyArray<string>,
): NetworkState {
  const status = statusOf(stored, checking);
  const check = stored.check;
  const exits: NetworkExit[] = stored.proxy
    ? [
        {
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
        },
      ]
    : [];
  return {
    available: true,
    tunnel: false,
    enabled: stored.enabled && stored.proxy !== null,
    status,
    exitId: stored.proxy ? NETWORK_PROXY_EXIT_ID : null,
    exits,
    protocol: "auto",
    activeProtocol: null,
    computers: [
      { id: computer.id, name: computer.name, current: true, kind: computer.kind, status },
    ],
    permission: "granted",
    otherVpn: null,
    since: status === "off" ? null : stored.since,
    proxy: stored.proxy
      ? {
          scheme: stored.proxy.scheme,
          host: stored.proxy.host,
          port: stored.proxy.port,
          username: stored.proxy.username,
          hasPassword: stored.proxy.password !== null,
          skip: stored.proxy.skip,
          alwaysDirect: direct,
          check,
        }
      : null,
  };
}

function parseStored(bytes: Uint8Array | null): StoredNetwork | null {
  if (!bytes) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as StoredNetwork;
    return value && value.version === 1 && value.bridge?.token ? value : null;
  } catch {
    return null;
  }
}

export const makeNetworkService = (options?: {
  /** The env children inherit (tests pass their own). */
  readonly env?: Record<string, string | undefined>;
  readonly checkProxy?: typeof checkProxy;
  readonly recheckMs?: number;
}) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore;
    const env = options?.env ?? process.env;
    const runCheck = options?.checkProxy ?? checkProxy;
    // The person's own proxy variables (a corporate proxy in their shell), restored when off.
    const inherited = inheritedProxyEnvironment(env);
    applyProxyEnvironment(env, null, inherited);
    const direct = alwaysDirectHosts(controlPlaneBaseUrl());
    const lock = yield* Semaphore.make(1);

    const fresh = (): StoredNetwork => ({
      version: 1,
      enabled: false,
      since: null,
      proxy: null,
      check: null,
      bridge: { token: randomBytes(24).toString("hex"), port: 0 },
    });
    let stored: StoredNetwork =
      parseStored(yield* secrets.get(NETWORK_SECRET_NAME).pipe(Effect.orElseSucceed(() => null))) ??
      fresh();
    let bridge: ProxyBridge | null = null;
    let checking = false;

    const remember = (value: StoredNetwork) => {
      registerKnownSecret(value.bridge.token);
      registerKnownSecret(value.proxy?.password);
      if (value.proxy?.password) registerKnownSecret(encodeURIComponent(value.proxy.password));
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

    /** Bridge up (when a proxy is saved), its upstream and the children's env as `stored` says. */
    const sync = Effect.gen(function* () {
      if (stored.proxy && !bridge) {
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
      const on = stored.enabled && stored.proxy !== null && bridge !== null;
      bridge?.setUpstream(on && stored.proxy ? upstreamOf(stored.proxy) : null);
      applyProxyEnvironment(
        env,
        on && bridge
          ? proxyEnvironment({
              bridgeUrl: bridge.url,
              direct: [...direct, ...(stored.proxy?.skip ?? [])],
            })
          : null,
        inherited,
      );
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

    yield* lock.withPermits(1)(sync);
    if (stored.enabled && stored.proxy) yield* Effect.forkDetach(lock.withPermits(1)(recheck));

    const recheckMs = options?.recheckMs ?? NETWORK_RECHECK_MS;
    if (recheckMs > 0) {
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(recheckMs);
            if (stored.enabled && stored.proxy) {
              yield* lock.withPermits(1)(recheck).pipe(Effect.ignore);
            }
          }
        }),
      );
    }
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        applyProxyEnvironment(env, null, inherited);
        await bridge?.close();
      }),
    );

    const change: NetworkServiceShape["change"] = (input, computer) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          let next = stored;
          if (input.proxy !== undefined) {
            if (input.proxy === null) {
              next = { ...next, proxy: null, check: null, enabled: false, since: null };
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
          }
          const wantsOn =
            input.enabled ?? (input.exitId === NETWORK_PROXY_EXIT_ID ? true : undefined);
          if (wantsOn !== undefined) {
            if (wantsOn && !next.proxy) {
              return yield* Effect.fail(new NetworkInputError("Add a proxy first."));
            }
            next = {
              ...next,
              enabled: wantsOn,
              since: wantsOn ? (next.enabled ? next.since : new Date().toISOString()) : null,
            };
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
          const changedProxy = next.proxy !== stored.proxy;
          stored = next;
          remember(stored);
          yield* persist(stored);
          yield* sync;
          // A new proxy, or turned on: the person sees at once whether it works.
          if (stored.proxy && (changedProxy || wantsOn === true)) yield* recheck;
          return networkStateOf(stored, computer, checking, direct);
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
      state: (computer) => Effect.sync(() => networkStateOf(stored, computer, checking, direct)),
      change,
      check,
    } satisfies NetworkServiceShape;
  });

export const NetworkServiceLive = Layer.effect(NetworkService, makeNetworkService());
