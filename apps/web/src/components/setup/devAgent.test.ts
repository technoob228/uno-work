import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { devWayStart } from "./devAgent";

const agent = (instanceId: string, auth: Record<string, unknown>): ServerProvider =>
  ({ instanceId, driver: instanceId, installed: true, auth }) as unknown as ServerProvider;
const signedIn = (id: string) => agent(id, { status: "authenticated", type: "claude.ai" });
const signedOut = (id: string) => agent(id, { status: "unauthenticated" });

describe("Home's Move my projects here: where the developer way starts", () => {
  it("nobody signed in: at the sign-in", () => {
    expect(devWayStart([signedOut("claudeAgent"), signedOut("codex")], null)).toEqual({
      step: "sign-in",
    });
  });

  it("Claude Code on the plan's Uno AI credit isn't their agent: still the sign-in", () => {
    const onCredit = agent("claudeAgent", { status: "authenticated", type: "unoAi" });
    expect(devWayStart([onCredit, signedOut("codex")], null).step).toBe("sign-in");
  });

  it("Claude Code or Codex signed in: straight to the import, on that agent", () => {
    expect(devWayStart([signedOut("claudeAgent"), signedIn("codex")], null)).toEqual({
      step: "import",
      agent: "codex",
    });
    expect(devWayStart([signedIn("claudeAgent"), signedIn("codex")], "codex")).toEqual({
      step: "import",
      agent: "codex",
    });
  });

  it("the saved pick signed out since: the other one signed in", () => {
    expect(devWayStart([signedIn("claudeAgent"), signedOut("codex")], "codex")).toEqual({
      step: "import",
      agent: "claudeAgent",
    });
  });
});
