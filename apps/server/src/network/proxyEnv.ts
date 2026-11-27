/**
 * Network → Proxy (26.11): the environment every child of Uno Work gets while
 * the person's proxy is on, and what always goes direct.
 *
 * Children don't see the person's proxy: they see the daemon's local bridge
 * (`proxyBridge.ts`, `http://uno:<token>@127.0.0.1:<port>`), which speaks to
 * the real proxy (HTTP, HTTPS or SOCKS5) with the real login. So one plain
 * HTTP proxy URL works for every tool (git, curl, npm, pip, Node with
 * NODE_USE_ENV_PROXY, Go, Rust, Claude Code, Codex), SOCKS5 included, and the
 * password never lands in an agent's environment.
 *
 * How it reaches every child: like upstream T3 Code, our spawns take the
 * daemon's `process.env` as the base (`mergeProviderInstanceEnvironment`,
 * terminals, `withManagedNodeOnPath` in server.ts does the same for PATH), so
 * the variables are set on `process.env` itself. The daemon's own requests
 * don't follow them: Node reads proxy variables only at start
 * (`NODE_USE_ENV_PROXY`), and the daemon was started without them. The
 * spawns that build a clean environment (the person's apps, plugins) copy
 * them with {@link copyProxyEnvironment}.
 *
 * Always direct: loopback (the daemon, the bridge itself, dev servers), the
 * local network (a proxy out there can't reach it anyway) and Uno's own
 * hosts — so Uno AI and the console keep working when the proxy breaks, and
 * Uno can help to fix it.
 */
import { NETWORK_PROXY_SKIP_MAX } from "@t3tools/contracts";

/** Every name a tool may read a proxy from (curl reads lower case first; Node, Go both). */
export const PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
] as const;

/**
 * Set next to the variables while they are ours: a daemon started by a
 * daemon that had them on (self-update, restart) knows they aren't the
 * person's own and drops them before it decides anew.
 */
export const NETWORK_PROXY_MARKER_ENV = "UNO_WORK_NETWORK_PROXY";

const LOOPBACK = ["localhost", "127.0.0.1", "::1"];
const LOCAL_NETWORK = [
  ".local",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
];
/** Uno's own hosts: the console, the AI gateway, sites, Spark, computers. */
const UNO_HOSTS = [
  "uno.place",
  ".uno.place",
  "uno4.me",
  ".uno4.me",
  "uno4.dev",
  ".uno4.dev",
  "getuno.xyz",
  ".getuno.xyz",
];

/** What always goes direct; `controlPlaneUrl` adds a dev / stage console's host. */
export function alwaysDirectHosts(controlPlaneUrl: string | null): ReadonlyArray<string> {
  const hosts = [...LOOPBACK, ...LOCAL_NETWORK, ...UNO_HOSTS];
  if (controlPlaneUrl) {
    try {
      const host = new URL(controlPlaneUrl).hostname.replace(/^\[|\]$/g, "");
      if (host && !coveredBy(host, hosts)) hosts.push(host);
    } catch {
      // Not a URL: the defaults cover the production console.
    }
  }
  return hosts;
}

function coveredBy(host: string, list: ReadonlyArray<string>): boolean {
  return list.some((entry) => {
    const bare = entry.replace(/^\./, "");
    return host === bare || host.endsWith(`.${bare}`);
  });
}

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;

/**
 * One "Skip for" entry, normalized for NO_PROXY: `*.corp.example` →
 * `.corp.example`, `10.0.0.0/8`, `db.internal`, `[::1]` → `::1`. null — not
 * something a tool would match.
 */
export function normalizeSkipEntry(raw: string): string | null {
  let entry = raw.trim().toLowerCase();
  if (entry.startsWith("*.")) entry = entry.slice(1);
  entry = entry.replace(/^\[|\]$/g, "");
  if (entry.length === 0 || entry.length > 253) return null;
  const cidr = /^([0-9a-f.:]+)\/(\d{1,3})$/.exec(entry);
  if (cidr) {
    const [, address = "", bits = ""] = cidr;
    const max = address.includes(":") ? 128 : 32;
    return Number(bits) <= max && (IPV4.test(address) || address.includes(":")) ? entry : null;
  }
  if (entry.includes(":")) return /^[0-9a-f:]+$/.test(entry) ? entry : null;
  if (IPV4.test(entry)) return entry.split(".").every((part) => Number(part) <= 255) ? entry : null;
  const labels = (entry.startsWith(".") ? entry.slice(1) : entry).split(".");
  return labels.every((label) => HOST_LABEL.test(label)) ? entry : null;
}

/** The person's "Skip for" list, cleaned: unknown entries are an error for the form. */
export function normalizeSkipList(
  raw: ReadonlyArray<string>,
): { readonly skip: ReadonlyArray<string> } | { readonly invalid: string } {
  const skip: string[] = [];
  for (const item of raw.flatMap((value) => value.split(/[\s,]+/))) {
    if (item.trim() === "") continue;
    const entry = normalizeSkipEntry(item);
    if (entry === null) return { invalid: item.trim() };
    if (!skip.includes(entry)) skip.push(entry);
  }
  return { skip: skip.slice(0, NETWORK_PROXY_SKIP_MAX) };
}

/** The variables a child gets while the proxy is on. */
export function proxyEnvironment(input: {
  readonly bridgeUrl: string;
  readonly direct: ReadonlyArray<string>;
}): Record<string, string> {
  const noProxy = [...new Set(input.direct)].join(",");
  return {
    HTTP_PROXY: input.bridgeUrl,
    HTTPS_PROXY: input.bridgeUrl,
    ALL_PROXY: input.bridgeUrl,
    NO_PROXY: noProxy,
    http_proxy: input.bridgeUrl,
    https_proxy: input.bridgeUrl,
    all_proxy: input.bridgeUrl,
    no_proxy: noProxy,
    // Node 22.21+ / 24.5+: fetch and http(s) follow the variables only with it.
    NODE_USE_ENV_PROXY: "1",
    [NETWORK_PROXY_MARKER_ENV]: "1",
  };
}

type MutableEnv = Record<string, string | undefined>;

/**
 * The proxy variables the daemon was started with that are the person's own
 * (a corporate proxy in their shell): restored when Network's proxy goes off.
 * Ones a previous daemon set for Network are dropped.
 */
export function inheritedProxyEnvironment(env: Readonly<MutableEnv>): Record<string, string> {
  if (env[NETWORK_PROXY_MARKER_ENV]) return {};
  const inherited: Record<string, string> = {};
  for (const name of PROXY_ENV_NAMES) {
    const value = env[name];
    if (value !== undefined) inherited[name] = value;
  }
  return inherited;
}

/** Puts `vars` (or, with null, the person's own `inherited`) onto `env`, in place. */
export function applyProxyEnvironment(
  env: MutableEnv,
  vars: Readonly<Record<string, string>> | null,
  inherited: Readonly<Record<string, string>>,
): void {
  for (const name of [...PROXY_ENV_NAMES, NETWORK_PROXY_MARKER_ENV]) delete env[name];
  Object.assign(env, vars ?? inherited);
}

/**
 * Network's proxy variables of `from` (the daemon's env by default), for a
 * spawn that builds a clean env. Empty while Network's proxy is off: such
 * spawns never got the person's own shell proxy and still don't.
 */
export function copyProxyEnvironment(
  from: Readonly<MutableEnv> = process.env,
): Record<string, string> {
  if (!from[NETWORK_PROXY_MARKER_ENV]) return {};
  const copied: Record<string, string> = {};
  for (const name of [...PROXY_ENV_NAMES, NETWORK_PROXY_MARKER_ENV]) {
    const value = from[name];
    if (value !== undefined) copied[name] = value;
  }
  return copied;
}

/**
 * Network's proxy as a browser takes it (Chrome can't read a login from the
 * environment; Playwright answers the bridge's challenge itself). null — off.
 */
export function browserProxyFromEnvironment(
  from: Readonly<MutableEnv> = process.env,
): { readonly server: string; readonly username: string; readonly password: string } | null {
  if (!from[NETWORK_PROXY_MARKER_ENV]) return null;
  try {
    const url = new URL(from.HTTPS_PROXY ?? "");
    if (url.protocol !== "http:" || !url.port) return null;
    return {
      server: `http://${url.hostname}:${url.port}`,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  } catch {
    return null;
  }
}

/**
 * What the desktop's browser panel reads (NetworkService `BROWSER_PROXY_FILE`):
 * the bridge, its login, and what goes direct — the same list as children's
 * NO_PROXY.
 */
export interface BrowserProxyFile {
  readonly server: string;
  readonly username: string;
  readonly password: string;
  readonly bypass: ReadonlyArray<string>;
}

export function browserProxyOf(
  bridgeUrl: string,
  bypass: ReadonlyArray<string>,
): BrowserProxyFile | null {
  const proxy = browserProxyFromEnvironment({
    [NETWORK_PROXY_MARKER_ENV]: "1",
    HTTPS_PROXY: bridgeUrl,
  });
  return proxy === null ? null : { ...proxy, bypass: [...new Set(bypass)] };
}
