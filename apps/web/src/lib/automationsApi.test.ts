import { describe, expect, it } from "vitest";

import { automationErrorOf } from "./automationsApi";

describe("automation errors", () => {
  it("reads the daemon's error with the link that fixes it", () => {
    const error = automationErrorOf(
      {
        error: {
          code: "GITHUB_REPO_NOT_ALLOWED",
          message: "Uno's GitHub app can't see getuno/web.",
          manageUrl: "https://github.com/settings/installations/1",
        },
      },
      409,
    );
    expect(error).toMatchObject({
      code: "GITHUB_REPO_NOT_ALLOWED",
      status: 409,
      manageUrl: "https://github.com/settings/installations/1",
      connectUrl: null,
    });
    expect(error?.message).toBe("Uno's GitHub app can't see getuno/web.");
  });

  it("takes snake_case links too, and leaves real answers alone", () => {
    expect(
      automationErrorOf({ error: { code: "GITHUB_NOT_CONNECTED", connect_url: "https://x" } }, 409)
        ?.connectUrl,
    ).toBe("https://x");
    expect(automationErrorOf({ id: 1, name: "x" }, 200)).toBeNull();
    expect(automationErrorOf({ error: "flat" }, 500)).toBeNull();
  });
});
