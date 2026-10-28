import { describe, expect, it } from "vitest";

import { connectorSignedIn } from "./connectorSignIn.logic";

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
