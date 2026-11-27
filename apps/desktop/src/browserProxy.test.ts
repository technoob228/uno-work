import { describe, expect, it } from "vitest";

import {
  browserProxyConfig,
  chromiumBypassRule,
  createBrowserProxy,
  parseBrowserProxyFile,
  type BrowserProxyConfig,
  type ProxySession,
} from "./browserProxy.ts";

const FILE = {
  server: "http://127.0.0.1:41234",
  username: "uno",
  password: "bridge-token",
  bypass: ["localhost", "127.0.0.1", "::1", ".local", "10.0.0.0/8", "uno.place", ".uno.place"],
};

function fakeSession() {
  const applied: BrowserProxyConfig[] = [];
  let closed = 0;
  const session: ProxySession = {
    setProxy: async (config) => void applied.push(config),
    closeAllConnections: async () => void (closed += 1),
  };
  return { session, applied, closed: () => closed };
}

function harness(initial: string | null) {
  let text = initial;
  let changed: () => void = () => undefined;
  const proxy = createBrowserProxy({
    filePath: "/state/browser-proxy.json",
    readFile: () => text,
    watch: (_path, onChange) => {
      changed = onChange;
      return () => undefined;
    },
  });
  return {
    proxy,
    write: (next: string | null) => {
      text = next;
      changed();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the panel browser and Network's proxy", () => {
  it("the bypass list is the children's NO_PROXY, in Chromium's words", () => {
    expect(browserProxyConfig(parseBrowserProxyFile(JSON.stringify(FILE)))).toEqual({
      mode: "fixed_servers",
      proxyRules: "http://127.0.0.1:41234",
      proxyBypassRules: "localhost,127.0.0.1,[::1],*.local,10.0.0.0/8,uno.place,*.uno.place",
    });
    expect(chromiumBypassRule("fd00::/8")).toBe("fd00::/8");
  });

  it("no file or a broken one → the system's settings", () => {
    expect(browserProxyConfig(parseBrowserProxyFile(null))).toEqual({ mode: "system" });
    expect(parseBrowserProxyFile("{")).toBeNull();
    expect(
      parseBrowserProxyFile(JSON.stringify({ ...FILE, server: "socks5://127.0.0.1:1" })),
    ).toBeNull();
  });

  it("a panel session follows the proxy on and off, dropping open connections each time", async () => {
    const { proxy, write } = harness(null);
    const panel = fakeSession();
    await proxy.track(panel.session);
    expect(panel.applied).toEqual([{ mode: "system" }]);

    write(JSON.stringify(FILE));
    await flush();
    expect(panel.applied.at(-1)).toMatchObject({ mode: "fixed_servers", proxyRules: FILE.server });

    // Same content again (the poller fires on any stat change): nothing to do.
    write(JSON.stringify(FILE));
    await flush();
    expect(panel.applied).toHaveLength(2);

    write(null);
    await flush();
    expect(panel.applied.at(-1)).toEqual({ mode: "system" });
    expect(panel.closed()).toBe(3);
  });

  it("answers the login of the bridge only, never a site's or another proxy's", () => {
    const { proxy, write } = harness(JSON.stringify(FILE));
    expect(proxy.loginFor({ isProxy: true, host: "127.0.0.1", port: 41234 })).toEqual({
      username: "uno",
      password: "bridge-token",
    });
    expect(proxy.loginFor({ isProxy: false, host: "127.0.0.1", port: 41234 })).toBeNull();
    expect(proxy.loginFor({ isProxy: true, host: "proxy.corp", port: 41234 })).toBeNull();
    expect(proxy.loginFor({ isProxy: true, host: "127.0.0.1", port: 8080 })).toBeNull();
    write(null);
    expect(proxy.loginFor({ isProxy: true, host: "127.0.0.1", port: 41234 })).toBeNull();
  });
});
