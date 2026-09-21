import type { AuthSessionId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { ServerClientSessionRecord } from "../../environments/primary/auth";
import {
  buildPhonePairUrl,
  classifyPhoneHostReach,
  describePhoneSession,
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
