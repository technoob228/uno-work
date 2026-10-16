import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { ownSignedInDrivers } from "./harnessSignInMemory";

const provider = (
  driver: string,
  auth: ServerProvider["auth"],
  installed = true,
): ServerProvider => ({
  instanceId: driver as ServerProvider["instanceId"],
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed,
  version: "1.0.0",
  status: "ready",
  auth,
  checkedAt: "2026-10-16T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

describe("ownSignedInDrivers", () => {
  it("counts only Claude / Codex signed in with the person's own account", () => {
    expect(
      ownSignedInDrivers([
        provider("claudeAgent", { status: "authenticated", type: "subscription" }),
        provider("codex", { status: "unauthenticated" }),
        provider("opencode", { status: "authenticated" }),
      ]),
    ).toEqual(["claudeAgent"]);
  });

  it("Claude Code on the plan's Uno AI credit is not a sign-in of the person", () => {
    expect(
      ownSignedInDrivers([provider("claudeAgent", { status: "authenticated", type: "unoAi" })]),
    ).toEqual([]);
    expect(ownSignedInDrivers([provider("codex", { status: "authenticated" }, false)])).toEqual([]);
  });
});
