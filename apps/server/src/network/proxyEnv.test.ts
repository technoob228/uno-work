import { describe, expect, it } from "vitest";

import { appEnvironment } from "../machineApps/MachineAppsService.ts";
import { buildPluginCommandEnv } from "../plugins/PluginRuntime.ts";
import {
  NETWORK_PROXY_MARKER_ENV,
  alwaysDirectHosts,
  applyProxyEnvironment,
  browserProxyFromEnvironment,
  copyProxyEnvironment,
  inheritedProxyEnvironment,
  normalizeSkipEntry,
  normalizeSkipList,
  proxyEnvironment,
} from "./proxyEnv.ts";

const BRIDGE = "http://uno:tok@127.0.0.1:40123";

describe("Network proxy environment", () => {
  it("points every proxy variable at the bridge and keeps loopback, LAN and Uno direct", () => {
    const env = proxyEnvironment({ bridgeUrl: BRIDGE, direct: alwaysDirectHosts(null) });
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"]) {
      expect(env[name]).toBe(BRIDGE);
    }
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
    const noProxy = env.NO_PROXY?.split(",") ?? [];
    expect(env.no_proxy).toBe(env.NO_PROXY);
    for (const host of [
      "localhost",
      "127.0.0.1",
      "::1",
      "192.168.0.0/16",
      "uno.place",
      ".getuno.xyz",
    ]) {
      expect(noProxy).toContain(host);
    }
  });

  it("adds a dev console's host, not a covered one", () => {
    expect(alwaysDirectHosts("http://127.0.0.1:8081")).toEqual(alwaysDirectHosts(null));
    expect(alwaysDirectHosts("https://console.uno.place")).toEqual(alwaysDirectHosts(null));
    expect(alwaysDirectHosts("https://stage.example.dev")).toContain("stage.example.dev");
  });

  it("normalizes Skip-for entries and refuses what no tool would match", () => {
    expect(normalizeSkipEntry("*.Corp.Example")).toBe(".corp.example");
    expect(normalizeSkipEntry("10.0.0.0/8")).toBe("10.0.0.0/8");
    expect(normalizeSkipEntry("[fd00::1]")).toBe("fd00::1");
    expect(normalizeSkipEntry("db.internal")).toBe("db.internal");
    expect(normalizeSkipEntry("http://x")).toBeNull();
    expect(normalizeSkipEntry("300.1.1.1")).toBeNull();
    expect(normalizeSkipEntry("10.0.0.0/40")).toBeNull();
    expect(normalizeSkipList(["a.example, b.example", " ", "a.example"])).toEqual({
      skip: ["a.example", "b.example"],
    });
    expect(normalizeSkipList(["ok.example", "bad host!"])).toEqual({ invalid: "host!" });
  });

  it("restores the person's own proxy variables when off and drops a previous daemon's", () => {
    const env: Record<string, string | undefined> = {
      HTTPS_PROXY: "http://corp:3128",
      PATH: "/bin",
    };
    const inherited = inheritedProxyEnvironment(env);
    applyProxyEnvironment(env, proxyEnvironment({ bridgeUrl: BRIDGE, direct: [] }), inherited);
    expect(env.HTTPS_PROXY).toBe(BRIDGE);
    expect(env[NETWORK_PROXY_MARKER_ENV]).toBe("1");
    // A daemon started from this env (self-update) doesn't take ours for the person's.
    expect(inheritedProxyEnvironment(env)).toEqual({});
    applyProxyEnvironment(env, null, inherited);
    expect(env).toEqual({ HTTPS_PROXY: "http://corp:3128", PATH: "/bin" });
  });

  it("reaches the clean environments of the person's apps and plugins only while on", () => {
    const on = { ...proxyEnvironment({ bridgeUrl: BRIDGE, direct: ["localhost"] }), PATH: "/b" };
    expect(copyProxyEnvironment({ HTTPS_PROXY: "http://corp:3128" })).toEqual({});
    expect(copyProxyEnvironment(on).HTTPS_PROXY).toBe(BRIDGE);
    const plugin = buildPluginCommandEnv({ baseEnv: on, extraEnv: {}, homeDir: "/h" });
    expect(plugin.HTTPS_PROXY).toBe(BRIDGE);
    expect(plugin.NO_PROXY).toBe("localhost");
    const saved = { ...process.env };
    try {
      applyProxyEnvironment(process.env, on, {});
      expect(appEnvironment("/h", 3000).HTTPS_PROXY).toBe(BRIDGE);
      applyProxyEnvironment(process.env, null, {});
      expect(appEnvironment("/h", 3000).HTTPS_PROXY).toBeUndefined();
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it("gives the browser the bridge with its token as a login", () => {
    const env = proxyEnvironment({ bridgeUrl: "http://uno:a%2Fb@127.0.0.1:4011", direct: [] });
    expect(browserProxyFromEnvironment(env)).toEqual({
      server: "http://127.0.0.1:4011",
      username: "uno",
      password: "a/b",
    });
    expect(browserProxyFromEnvironment({ HTTPS_PROXY: "http://corp:3128" })).toBeNull();
  });
});
