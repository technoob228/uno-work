import type { AuthSessionId, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { ServerClientSessionRecord } from "../../environments/primary/auth";
import {
  buildPhonePairUrl,
  classifyPhoneHostReach,
  dedupePhoneComputerSources,
  describePhoneSession,
  orderPhoneComputers,
  type PhoneComputerSource,
  resolvePhoneComputer,
  formatCountdown,
  formatPhoneCode,
  isPhoneSession,
  normalizePhoneHost,
  phonePairingLabel,
} from "./phonePairing";

function session(overrides: Partial<ServerClientSessionRecord> = {}): ServerClientSessionRecord {
  return {
    sessionId: "s1" as AuthSessionId,
    subject: "one-time-token",
    role: "client",
    method: "bearer-session-token",
    client: { deviceType: "unknown" },
    issuedAt: "2026-09-21T10:00:00.000Z",
    expiresAt: "2026-10-21T10:00:00.000Z",
    lastConnectedAt: null,
    connected: false,
    current: false,
    ...overrides,
  };
}

describe("buildPhonePairUrl", () => {
  it("puts the code in the hash, the shape the T3 store app parses", () => {
    expect(buildPhonePairUrl("https://box-12.uno4.work/", "ABCD2345EFGH")).toBe(
      "https://box-12.uno4.work/pair#token=ABCD2345EFGH",
    );
  });

  it("drops any path or query the base URL carried", () => {
    expect(buildPhonePairUrl("http://192.168.1.20:3773/settings?x=1", "Z")).toBe(
      "http://192.168.1.20:3773/pair#token=Z",
    );
  });

  it("normalizes the host shown for manual entry", () => {
    expect(normalizePhoneHost("https://box-12.uno4.work/")).toBe("https://box-12.uno4.work");
  });
});

describe("classifyPhoneHostReach", () => {
  it.each([
    ["https://box-12.uno4.work", "public"],
    ["https://8.8.8.8", "public"],
    ["http://localhost:5173", "loopback"],
    ["http://127.0.0.1:3773", "loopback"],
    ["http://[::1]:3773", "loopback"],
    ["http://192.168.1.20:3773", "private"],
    ["http://10.0.0.5", "private"],
    ["http://172.20.1.1", "private"],
    ["http://100.101.1.2", "private"],
    ["http://mikhails-mac.local:3773", "private"],
    ["https://mac.tail1234.ts.net", "private"],
    ["http://devbox:3773", "private"],
  ] as const)("%s → %s", (url, expected) => {
    expect(classifyPhoneHostReach(url)).toBe(expected);
  });
});

describe("formatting", () => {
  it("groups the code in fours", () => {
    expect(formatPhoneCode("ABCD2345EFGH")).toBe("ABCD 2345 EFGH");
  });

  it("counts down in m:ss and never goes negative", () => {
    expect(formatCountdown(300_900)).toBe("5:00");
    expect(formatCountdown(299_100)).toBe("4:59");
    expect(formatCountdown(61_000)).toBe("1:01");
    expect(formatCountdown(-5)).toBe("0:00");
  });

  it("labels codes as Phone · <date>", () => {
    expect(phonePairingLabel(new Date(2026, 8, 21, 14, 5))).toMatch(/^Phone · Sep 21, 14:05$/);
  });
});

describe("isPhoneSession", () => {
  it("recognizes sessions minted by the Connect your phone button", () => {
    expect(
      isPhoneSession(
        session({ client: { deviceType: "unknown", label: "Phone · Sep 21, 14:05" } }),
      ),
    ).toBe(true);
  });

  it("recognizes bearer sessions from mobile user agents paired elsewhere", () => {
    expect(isPhoneSession(session({ client: { deviceType: "mobile" } }))).toBe(true);
  });

  it("ignores the current tab and desktop browsers", () => {
    expect(
      isPhoneSession(
        session({ current: true, client: { deviceType: "mobile", label: "Phone · x" } }),
      ),
    ).toBe(false);
    expect(
      isPhoneSession(
        session({ method: "browser-session-cookie", client: { deviceType: "mobile" } }),
      ),
    ).toBe(false);
    expect(isPhoneSession(session({ client: { deviceType: "desktop" } }))).toBe(false);
  });

  it("describes a phone by its label, else by OS", () => {
    expect(
      describePhoneSession(session({ client: { deviceType: "mobile", label: "Phone · Sep 21" } })),
    ).toBe("Phone · Sep 21");
    expect(describePhoneSession(session({ client: { deviceType: "mobile", os: "iOS" } }))).toBe(
      "iOS",
    );
    expect(describePhoneSession(session())).toBe("Phone");
  });
});

const isProxy = (url: string) => /(^|\.)app\.uno4\.work$/.test(new URL(url).hostname);
const env = (id: string) => id as EnvironmentId;

describe("workspace computers for the phone", () => {
  const mac: PhoneComputerSource = {
    environmentId: env("mac"),
    label: "Mikhail's MacBook Air",
    isPrimary: true,
    unoBoxId: null,
    httpBaseUrl: "http://127.0.0.1:3773",
    boxDirectOrigin: null,
  };
  const cloud: PhoneComputerSource = {
    environmentId: env("cloud"),
    label: "uno-work",
    isPrimary: false,
    unoBoxId: 395,
    httpBaseUrl: "https://main-abc.app.uno4.dev",
    boxDirectOrigin: "https://main-abc.app.uno4.dev",
  };

  it("never hands a phone the desktop's loopback address", () => {
    const resolved = resolvePhoneComputer(mac, isProxy);
    expect(resolved.phoneBaseUrl).toBeNull();
    expect(resolved.reach).toBe("unreachable");
  });

  it("offers the desktop's LAN address only when the daemon really listens there", () => {
    const resolved = resolvePhoneComputer(
      {
        ...mac,
        advertisedEndpoints: [
          { httpBaseUrl: "http://127.0.0.1:3773", reachability: "loopback", status: "available" },
          { httpBaseUrl: "http://192.168.1.44:3773", reachability: "lan", status: "available" },
        ],
      },
      isProxy,
    );
    expect(resolved).toMatchObject({ phoneBaseUrl: "http://192.168.1.44:3773", reach: "private" });
  });

  it("skips endpoints the desktop marks unavailable and prefers a public one", () => {
    const resolved = resolvePhoneComputer(
      {
        ...mac,
        advertisedEndpoints: [
          { httpBaseUrl: "http://192.168.1.44:3773", reachability: "lan", status: "available" },
          { httpBaseUrl: "https://mac.example.com", reachability: "public", status: "available" },
          { httpBaseUrl: "http://10.0.0.9:3773", reachability: "lan", status: "unavailable" },
        ],
      },
      isProxy,
    );
    expect(resolved.phoneBaseUrl).toBe("https://mac.example.com");
  });

  it("uses the box's own address, not the sign-in proxy it was opened through", () => {
    const resolved = resolvePhoneComputer(
      { ...cloud, isPrimary: true, httpBaseUrl: "https://app.uno4.work" },
      isProxy,
    );
    expect(resolved).toMatchObject({
      phoneBaseUrl: "https://main-abc.app.uno4.dev",
      reach: "public",
    });
  });

  it("puts the cloud computer first and unreachable ones last", () => {
    const lanServer: PhoneComputerSource = {
      environmentId: env("lan"),
      label: "attic",
      isPrimary: false,
      unoBoxId: null,
      httpBaseUrl: "http://192.168.1.50:3773",
      boxDirectOrigin: null,
    };
    const vps: PhoneComputerSource = {
      environmentId: env("vps"),
      label: "a-vps",
      isPrimary: false,
      unoBoxId: null,
      httpBaseUrl: "https://vps.example.com",
      boxDirectOrigin: null,
    };
    const ordered = orderPhoneComputers(
      [mac, lanServer, vps, cloud].map((source) => resolvePhoneComputer(source, isProxy)),
    );
    expect(ordered.map((computer) => computer.label)).toEqual([
      "uno-work",
      "a-vps",
      "attic",
      "Mikhail's MacBook Air",
    ]);
  });

  it("lists a box once when it is both the primary and a saved connection", () => {
    const deduped = dedupePhoneComputerSources([
      { ...cloud, environmentId: env("primary-box"), isPrimary: true },
      cloud,
      mac,
      mac,
    ]);
    expect(deduped.map((source) => source.environmentId)).toEqual(["primary-box", "mac"]);
  });
});
