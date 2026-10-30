import { describe, expect, it } from "vitest";

import { connectorShown, connectorSignedIn, connectorsGate } from "./connectorSignIn.logic";

describe("connectorSignedIn", () => {
  it("is not signed in before the first sign-in", () => {
    expect(connectorSignedIn(undefined)).toBe(false);
    expect(connectorSignedIn({ connected: false })).toBe(false);
  });

  it("expired → Reconnect → signed in only once the console lists the new grant", () => {
    // What the console lists while the old grant is refused: still "connected".
    const expired = { connected: true, needsReconnect: true };
    expect(connectorSignedIn(expired)).toBe(false);
    // Polls while the person is still on the provider's page: the same answer.
    expect(connectorSignedIn({ ...expired })).toBe(false);
    // The new grant landed.
    expect(connectorSignedIn({ connected: true, needsReconnect: false })).toBe(true);
  });

  it("an older console without needsReconnect counts connected as signed in", () => {
    expect(connectorSignedIn({ connected: true })).toBe(true);
  });
});

describe("connectorsGate", () => {
  it("ready when the console answered", () => {
    expect(connectorsGate({ available: true, reason: null })).toBe("ready");
  });

  it("a computer without a token or an account key: Sign in, not Soon", () => {
    expect(connectorsGate({ available: false, reason: "sign_in_required" })).toBe("sign-in");
    // An older daemon's word for the same.
    expect(connectorsGate({ available: false, reason: "not_cloud_computer" })).toBe("sign-in");
  });

  it("a console without the Mac routes yet, the console down, no answer: no false Sign in", () => {
    expect(connectorsGate({ available: false, reason: "console_outdated" })).toBe("outdated");
    expect(connectorsGate({ available: false, reason: "console_unreachable" })).toBe("soon");
    expect(connectorsGate({ available: false, reason: "unavailable" })).toBe("soon");
    expect(connectorsGate(undefined)).toBe("soon");
  });
});

describe("connectorShown", () => {
  const row = (provider: string, available: boolean, connected = false) =>
    ({ provider, available, connected }) as const;

  it("the four apps always have a row", () => {
    expect(connectorShown("gmail", [])).toBe(true);
    expect(connectorShown("notion", [row("notion", false)])).toBe(true);
  });

  it("Outlook & Teams only when the console offers it", () => {
    expect(connectorShown("microsoft", [])).toBe(false);
    expect(connectorShown("microsoft", [row("microsoft", false)])).toBe(false);
    expect(connectorShown("microsoft", [row("microsoft", true)])).toBe(true);
    // Connected earlier, the console's config gone since: still there to disconnect.
    expect(connectorShown("microsoft", [row("microsoft", false, true)])).toBe(true);
  });
});
