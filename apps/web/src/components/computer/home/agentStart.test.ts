import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { EMPTY_SETUP_PROGRESS } from "../../setup/setupModel";
import {
  AGENT_START_STEP,
  agentDriverFromAccountDefault,
  agentStartDoneHere,
  nextStepIdForSetupStep,
  noSignInAgent,
  noSignInAgentFromAccountDefault,
  parseAgentDriver,
  pickAgentDriver,
  shouldAutoOpenAgentSignIn,
  signedInWithOwnAccount,
} from "./agentStart";

const provider = (
  auth: ServerProvider["auth"],
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: "claudeAgent" as ServerProvider["instanceId"],
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.0",
  status: "ready",
  auth,
  checkedAt: "2026-10-16T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("parseAgentDriver", () => {
  it("reads the entry link's agent", () => {
    expect(parseAgentDriver("claude")).toBe("claudeAgent");
    expect(parseAgentDriver(" Codex ")).toBe("codex");
    expect(parseAgentDriver("claudeAgent")).toBe("claudeAgent");
    expect(parseAgentDriver("opencode")).toBeNull();
    expect(parseAgentDriver("<script>")).toBeNull();
    expect(parseAgentDriver(null)).toBeNull();
  });

  it("the account's default AI means a CLI only for Claude and Codex", () => {
    expect(agentDriverFromAccountDefault("claude")).toBe("claudeAgent");
    expect(agentDriverFromAccountDefault("codex")).toBe("codex");
    expect(agentDriverFromAccountDefault("uno")).toBeNull();
    expect(agentDriverFromAccountDefault("byok")).toBeNull();
  });
});

describe("pickAgentDriver", () => {
  it("the link first, then this computer, then the account; Claude Code by default", () => {
    expect(pickAgentDriver({ arrived: "codex", saved: "claudeAgent", accountDefault: null })).toBe(
      "codex",
    );
    expect(pickAgentDriver({ arrived: null, saved: "codex", accountDefault: "claudeAgent" })).toBe(
      "codex",
    );
    expect(pickAgentDriver({ arrived: null, saved: null, accountDefault: "codex" })).toBe("codex");
    expect(pickAgentDriver({ arrived: null, saved: null, accountDefault: null })).toBe(
      "claudeAgent",
    );
  });
});

describe("signedInWithOwnAccount", () => {
  it("the plan's Uno AI credit is not the person's sign-in", () => {
    expect(
      signedInWithOwnAccount(provider({ status: "authenticated", type: "subscription" })),
    ).toBe(true);
    expect(signedInWithOwnAccount(provider({ status: "authenticated", type: "unoAi" }))).toBe(
      false,
    );
    expect(signedInWithOwnAccount(provider({ status: "unauthenticated" }))).toBe(false);
    expect(
      signedInWithOwnAccount(provider({ status: "authenticated" }, { installed: false })),
    ).toBe(false);
    expect(signedInWithOwnAccount(null)).toBe(false);
  });
});

describe("shouldAutoOpenAgentSignIn", () => {
  const base = {
    lite: false,
    arrived: "claudeAgent" as const,
    ownAgentGoal: true,
    accountDefault: null,
    prompted: false,
    provider: provider({ status: "unauthenticated" }),
  };

  it("opens once after the person picked their agent before Work", () => {
    expect(shouldAutoOpenAgentSignIn(base)).toBe(true);
    // No link, but the own-agent goal with Claude as the account's AI.
    expect(
      shouldAutoOpenAgentSignIn({ ...base, arrived: null, accountDefault: "claudeAgent" }),
    ).toBe(true);
    // Claude Code on Uno AI's credit still needs the person's own sign-in.
    expect(
      shouldAutoOpenAgentSignIn({
        ...base,
        provider: provider({ status: "authenticated", type: "unoAi" }),
      }),
    ).toBe(true);
  });

  it("never twice, never without a pick, never when signed in or not installed", () => {
    expect(shouldAutoOpenAgentSignIn({ ...base, prompted: true })).toBe(false);
    expect(shouldAutoOpenAgentSignIn({ ...base, arrived: null })).toBe(false);
    expect(
      shouldAutoOpenAgentSignIn({
        ...base,
        arrived: null,
        ownAgentGoal: false,
        accountDefault: "claudeAgent",
      }),
    ).toBe(false);
    expect(
      shouldAutoOpenAgentSignIn({
        ...base,
        provider: provider({ status: "authenticated", type: "subscription" }),
      }),
    ).toBe(false);
    expect(
      shouldAutoOpenAgentSignIn({
        ...base,
        provider: provider({ status: "unauthenticated" }, { installed: false }),
      }),
    ).toBe(false);
    expect(shouldAutoOpenAgentSignIn({ ...base, provider: null })).toBe(false);
    expect(shouldAutoOpenAgentSignIn({ ...base, lite: true })).toBe(false);
  });
});

describe("agentStartDoneHere", () => {
  it("knows what this computer already did", () => {
    const done = agentStartDoneHere({
      agentSignedIn: true,
      progress: {
        ...EMPTY_SETUP_PROGRESS,
        visited: ["skills", "connectors"],
        skipped: ["connectors"],
        project: { id: "p1", path: "/home/u/acme", name: "acme", kind: "site" },
      },
      channelOn: false,
    });
    expect(done).toEqual(
      new Set([
        AGENT_START_STEP.connectAgent,
        AGENT_START_STEP.addProject,
        AGENT_START_STEP.addSkills,
      ]),
    );
  });

  it("Telegram or Slack already on closes the channel step", () => {
    const done = agentStartDoneHere({
      agentSignedIn: false,
      progress: EMPTY_SETUP_PROGRESS,
      channelOn: true,
    });
    expect([...done]).toEqual([AGENT_START_STEP.connectChannel]);
  });

  it("the setup steps map back to the card's ids", () => {
    expect(nextStepIdForSetupStep("skills")).toBe("add_skills");
    expect(nextStepIdForSetupStep("connectors")).toBe("connect_tools");
    expect(nextStepIdForSetupStep("channels")).toBe("connect_channel");
    expect(nextStepIdForSetupStep("project")).toBeNull();
  });
});

describe("noSignInAgent (28.10: OpenCode picked in the configurator → Home asked to sign in to Claude Code)", () => {
  it("OpenCode or Uno AI as the account's default AI needs no sign-in", () => {
    expect(noSignInAgentFromAccountDefault("opencode")).toBe("opencode");
    expect(noSignInAgentFromAccountDefault("uno")).toBe("uno");
    expect(noSignInAgentFromAccountDefault("claude")).toBeNull();
    expect(noSignInAgentFromAccountDefault("codex")).toBeNull();
    expect(noSignInAgentFromAccountDefault("byok")).toBeNull();
    expect(noSignInAgentFromAccountDefault(null)).toBeNull();
    expect(noSignInAgent({ arrived: null, saved: null, accountDefaultAi: "opencode" })).toBe(
      "opencode",
    );
  });

  it("Claude Code or Codex named on the entry link or saved here still wins", () => {
    expect(
      noSignInAgent({ arrived: "claudeAgent", saved: null, accountDefaultAi: "opencode" }),
    ).toBeNull();
    expect(
      noSignInAgent({ arrived: null, saved: "codex", accountDefaultAi: "opencode" }),
    ).toBeNull();
  });

  it("closes the sign-in step: the card moves on to the project", () => {
    const done = agentStartDoneHere({
      agentSignedIn:
        noSignInAgent({ arrived: null, saved: null, accountDefaultAi: "opencode" }) !== null,
      progress: EMPTY_SETUP_PROGRESS,
      channelOn: false,
    });
    expect([...done]).toEqual([AGENT_START_STEP.connectAgent]);
  });
});
