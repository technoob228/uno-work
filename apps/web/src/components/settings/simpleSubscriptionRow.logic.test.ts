import { describe, expect, it } from "vitest";

import { subscriptionRowState } from "./simpleSubscriptionRow.logic";

describe("subscriptionRowState", () => {
  it("Claude on Uno AI is not 'Connected' and still offers Sign in", () => {
    expect(
      subscriptionRowState({ kind: "models", onUnoAi: true, accountLabel: "Uno AI", email: null }),
    ).toEqual({ state: "unoAi", paneKind: "signin", detail: null });
  });

  it("an own sign-in is Connected, with the plan and email", () => {
    expect(
      subscriptionRowState({
        kind: "models",
        onUnoAi: false,
        accountLabel: "Claude Max",
        email: "me@example.com",
      }),
    ).toEqual({ state: "connected", paneKind: null, detail: "Claude Max · me@example.com" });
  });

  it("not installed / signed out opens the setup pane", () => {
    expect(
      subscriptionRowState({ kind: "signin", onUnoAi: false, accountLabel: null, email: null })
        .paneKind,
    ).toBe("signin");
    expect(
      subscriptionRowState({ kind: "install", onUnoAi: false, accountLabel: null, email: null })
        .paneKind,
    ).toBe("install");
    expect(
      subscriptionRowState({ kind: "blocked", onUnoAi: false, accountLabel: null, email: null })
        .state,
    ).toBe("none");
  });
});
