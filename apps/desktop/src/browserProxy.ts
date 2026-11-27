/**
 * Network → Proxy for the desktop's own browser panel (0.0.197).
 *
 * The backend sets the proxy in the environment of everything it starts, but
 * the panel's `<webview>`s are Electron sessions of this process: they take
 * neither the environment nor a login from it. So while the proxy is on the
 * backend writes `<stateDir>/browser-proxy.json` (0600, NetworkService
 * `BROWSER_PROXY_FILE`): its local bridge, the bridge's login and what goes
 * direct (the same list as children's NO_PROXY). Here every panel session
 * gets `session.setProxy` with it, and the bridge's 407 is answered from the
 * app's `login` event — for the bridge only, never for a site.
 *
 * No file — the sessions go back to the system's settings. A file that points
 * to a bridge that is gone fails closed: nothing loads, nothing goes out from
 * this computer's own address.
 *
 * @module browserProxy
 */
import * as FS from "node:fs";

export interface BrowserProxyFile {
  readonly server: string;
  readonly username: string;
  readonly password: string;
  readonly bypass: ReadonlyArray<string>;
}

/** What `session.setProxy` takes (the part of Electron's ProxyConfig used here). */
export type BrowserProxyConfig =
  | { readonly mode: "system" }
  | {
      readonly mode: "fixed_servers";
      readonly proxyRules: string;
      readonly proxyBypassRules: string;
    };

/** The file's content, or null when it isn't one the backend wrote. */
export function parseBrowserProxyFile(text: string | null): BrowserProxyFile | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<BrowserProxyFile>;
    if (
      typeof value.server !== "string" ||
      typeof value.username !== "string" ||
      typeof value.password !== "string" ||
      !Array.isArray(value.bypass)
    ) {
      return null;
    }
    const url = new URL(value.server);
    if (url.protocol !== "http:" || !url.port) return null;
    return {
      server: `http://${url.hostname}:${url.port}`,
      username: value.username,
      password: value.password,
      bypass: value.bypass.filter((entry): entry is string => typeof entry === "string"),
    };
  } catch {
    return null;
  }
}

/**
 * A NO_PROXY entry as a Chromium bypass rule: `.example.com` → `*.example.com`
 * (the host itself is listed separately), IPv6 in brackets; CIDRs as they are.
 */
export function chromiumBypassRule(entry: string): string {
  if (entry.startsWith(".")) return `*${entry}`;
  if (entry.includes(":") && !entry.includes("/") && !entry.startsWith("[")) return `[${entry}]`;
  return entry;
}

export function browserProxyConfig(file: BrowserProxyFile | null): BrowserProxyConfig {
  if (file === null) return { mode: "system" };
  return {
    mode: "fixed_servers",
    proxyRules: file.server,
    proxyBypassRules: [...new Set(file.bypass.map(chromiumBypassRule))].join(","),
  };
}

/** The part of Electron's Session used here (tests pass a fake). */
export interface ProxySession {
  setProxy(config: BrowserProxyConfig): Promise<void>;
  closeAllConnections(): Promise<void>;
}

/** The part of Electron's AuthInfo the `login` event gives. */
export interface ProxyAuthInfo {
  readonly isProxy: boolean;
  readonly host: string;
  readonly port: number;
}

export interface BrowserProxyDeps {
  readonly filePath: string;
  readonly readFile?: (path: string) => string | null;
  /** Calls `onChange` when the file may have changed; returns a stop. */
  readonly watch?: (path: string, onChange: () => void) => () => void;
  readonly log?: (message: string, details?: Record<string, unknown>) => void;
}

const readFileOrNull = (path: string): string | null => {
  try {
    return FS.readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const watchByPolling = (path: string, onChange: () => void): (() => void) => {
  const listener = () => onChange();
  FS.watchFile(path, { interval: 2_000 }, listener);
  return () => FS.unwatchFile(path, listener);
};

export function createBrowserProxy(deps: BrowserProxyDeps) {
  const read = deps.readFile ?? readFileOrNull;
  const sessions = new Set<ProxySession>();
  let current = parseBrowserProxyFile(read(deps.filePath));
  let key = JSON.stringify(browserProxyConfig(current));

  const apply = (target: ProxySession) =>
    target
      .setProxy(browserProxyConfig(current))
      // Open keep-alive sockets would carry on the old way.
      .then(() => target.closeAllConnections())
      .catch((error: unknown) =>
        deps.log?.("[desktop] browser proxy not applied", { error: String(error) }),
      );

  const reload = () => {
    const next = parseBrowserProxyFile(read(deps.filePath));
    const nextKey = JSON.stringify(browserProxyConfig(next));
    current = next;
    if (nextKey === key) return;
    key = nextKey;
    deps.log?.("[desktop] browser proxy changed", {
      on: next !== null,
      ...(next ? { server: next.server } : {}),
    });
    for (const target of sessions) void apply(target);
  };

  const stopWatching = (deps.watch ?? watchByPolling)(deps.filePath, reload);

  return {
    /** A panel session (from will-attach-webview): it follows the proxy from now on. */
    track(target: ProxySession): Promise<void> {
      if (sessions.has(target)) return Promise.resolve();
      sessions.add(target);
      return apply(target);
    },
    /** The bridge's login for a proxy challenge from it; null for anything else. */
    loginFor(
      authInfo: ProxyAuthInfo,
    ): { readonly username: string; readonly password: string } | null {
      if (!authInfo.isProxy || current === null) return null;
      const bridge = new URL(current.server);
      const host = authInfo.host.replace(/^\[|\]$/g, "");
      if (host !== bridge.hostname || String(authInfo.port) !== bridge.port) return null;
      return { username: current.username, password: current.password };
    },
    /** Re-read the file now (also done on every change of it). */
    reload,
    dispose(): void {
      stopWatching();
      sessions.clear();
    },
  };
}

export type BrowserProxy = ReturnType<typeof createBrowserProxy>;
