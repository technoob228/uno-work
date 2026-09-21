import { describe, expect, it } from "vitest";

import type { ServerClientSessionRecord } from "../../environments/primary/auth";
import {
  clientSessionPrimaryLabel,
  describeWorkProxyGroup,
  groupClientSessions,
} from "./clientSessionGroups";

function session(id: string, label: string | null, current = false): ServerClientSessionRecord {
  return {
    sessionId: id,
    current,
    connected: false,
    client: {
      label,
      deviceType: "desktop",
      os: "macOS",
      browser: "Chrome",
      ipAddress: "10.77.0.1",
    },
  } as unknown as ServerClientSessionRecord;
}

describe("groupClientSessions", () => {
  it("folds app.uno4.work sessions into one group, keeping this tab separate", () => {
    const sessions = [
      ...Array.from({ length: 17 }, (_, i) => session(`p${i}`, "proxy")),
      session("me", "proxy", true),
      session("phone", "Phone · Sep 21, 10:00"),
    ];
    const groups = groupClientSessions(sessions);
    expect(groups.proxy).toHaveLength(17);
    expect(groups.individual.map((s) => s.sessionId)).toEqual(["me", "phone"]);
    expect(describeWorkProxyGroup(17)).toBe("Browser via app.uno4.work · 17 sessions");
  });

  it("never labels a row with the bare word proxy", () => {
    expect(clientSessionPrimaryLabel(session("me", "proxy", true))).toBe(
      "Browser via app.uno4.work",
    );
  });
});
