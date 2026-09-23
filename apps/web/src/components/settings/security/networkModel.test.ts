import { describe, expect, it } from "vitest";

import {
  addAddress,
  choosablePorts,
  MODE_OPTIONS,
  type NetworkPolicy,
  type NetworkPort,
  networkErrorText,
  normalizeAddress,
  policyBody,
  portTitle,
  reachability,
  sameAddresses,
  toggledPorts,
} from "./networkModel";

const port = (over: Partial<NetworkPort>): NetworkPort => ({
  id: 1,
  internal_port: 8080,
  protocol: "tcp",
  external_port: 20080,
  address: "185.1.2.3:20080",
  kind: "other",
  configured: "public",
  effective: "public",
  ...over,
});

const PORTS: ReadonlyArray<NetworkPort> = [
  port({ id: 1, internal_port: 80, kind: "uno_work" }),
  port({ id: 2, internal_port: 22, kind: "ssh", effective: "allowlist" }),
  port({ id: 3, internal_port: 8090, kind: "app", app_name: "Nextcloud", effective: "private" }),
  port({ id: 4, internal_port: 51820, protocol: "udp", kind: "vpn", app_name: "WireGuard" }),
  port({ id: 5, internal_port: 3000 }),
  port({ id: 6, internal_port: 3000, protocol: "udp" }),
];

const POLICY: NetworkPolicy = {
  internet: "open",
  open_mode: "all",
  open_ports: [],
  allowed_ips: ["1.2.3.4"],
  ssh_enabled: true,
};

describe("policyBody", () => {
  it("sends the whole policy with the change applied", () => {
    expect(policyBody(POLICY, { internet: "closed" })).toEqual({
      internet: "closed",
      open_mode: "all",
      open_ports: [],
      allowed_ips: ["1.2.3.4"],
      ssh_enabled: true,
    });
    expect(policyBody(POLICY)).not.toHaveProperty("updated_at");
  });
});

describe("mode labels", () => {
  it("has the four choices in order", () => {
    expect(MODE_OPTIONS.map((m) => m.value)).toEqual(["all", "ports", "allowlist", "vpn"]);
    expect(MODE_OPTIONS[0]?.title).toBe("Everything you've opened");
  });
});

describe("ports", () => {
  it("names ports for people", () => {
    expect(PORTS.map(portTitle)).toEqual([
      "Uno Work",
      "SSH",
      "Nextcloud",
      "WireGuard (VPN)",
      "Port 3000",
      "Port 3000 (UDP)",
    ]);
  });

  it("offers every port except Uno Work and SSH, once per inside port", () => {
    expect(choosablePorts(PORTS)).toEqual([
      { internalPort: 3000, title: "Port 3000" },
      { internalPort: 8090, title: "Nextcloud" },
      { internalPort: 51820, title: "WireGuard (VPN)" },
    ]);
  });

  it("toggles a port in the chosen list", () => {
    expect(toggledPorts([8090], 3000, true)).toEqual([3000, 8090]);
    expect(toggledPorts([3000, 8090], 3000, false)).toEqual([8090]);
    expect(toggledPorts([8090], 8090, true)).toEqual([8090]);
  });
});

describe("reachability", () => {
  it("lists open first, closed last, with plain words", () => {
    const rows = reachability(PORTS);
    expect(rows.map((r) => r.status)).toEqual([
      "public",
      "public",
      "public",
      "public",
      "allowlist",
      "private",
    ]);
    expect(rows.find((r) => r.title === "SSH")?.statusLabel).toBe("Only your addresses");
    expect(rows.find((r) => r.title === "Nextcloud")?.statusLabel).toBe("Closed");
    expect(rows[0]?.address).toBe("185.1.2.3:20080");
  });
});

describe("addresses", () => {
  it("accepts IPv4 addresses and networks, tidied", () => {
    expect(normalizeAddress(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(normalizeAddress("10.0.0.0/8")).toBe("10.0.0.0/8");
    expect(normalizeAddress("010.1.1.1/08")).toBe("10.1.1.1/8");
    expect(normalizeAddress("0.0.0.0/0")).toBe("0.0.0.0/0");
  });

  it("rejects anything else", () => {
    for (const bad of [
      "",
      "example.com",
      "1.2.3",
      "256.1.1.1",
      "1.2.3.4/33",
      "1.2.3.4/",
      "1.2.3.4/8/1",
      "::1",
      "1.2.3.4 5",
    ]) {
      expect(normalizeAddress(bad), bad).toBeNull();
    }
  });

  it("adds without duplicates and explains mistakes", () => {
    expect(addAddress([], "1.2.3.4")).toEqual({ list: ["1.2.3.4"], error: null });
    expect(addAddress(["1.2.3.4"], "1.2.3.4")).toEqual({ list: ["1.2.3.4"], error: null });
    const bad = addAddress(["1.2.3.4"], "nope");
    expect(bad.list).toEqual(["1.2.3.4"]);
    expect(bad.error).toMatch(/203\.0\.113\.7/);
    const full = Array.from({ length: 64 }, (_, i) => `10.0.0.${i}`);
    expect(addAddress(full, "10.0.1.1").error).toMatch(/64/);
  });

  it("compares lists in order", () => {
    expect(sameAddresses(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameAddresses(["a"], ["a", "b"])).toBe(false);
  });
});

describe("errors", () => {
  it("turns server codes into words", () => {
    expect(networkErrorText(new Error("INVALID_ALLOWLIST"))).toMatch(/address/);
    expect(networkErrorText(new Error("INVALID_PORTS"))).toMatch(/port/);
    expect(networkErrorText("boom")).toBe("boom");
  });
});
